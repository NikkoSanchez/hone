import type { ServerWebSocket } from "bun";
import type { AgentExit, AgentLifecycleStatus, AgentRuntimeSnapshot } from "../../types";
import type { SessionStore } from "../../session-store";
import type { TerminalAgentAdapter } from "../adapters";
import {
  appendBoundedTranscript,
  encodeTerminalOutputFrame,
  formatFeedbackEnvelope,
  TERMINAL_DEFAULT_COLS,
  TERMINAL_DEFAULT_ROWS,
  TERMINAL_TRANSCRIPT_LIMIT,
  type TerminalServerMessage,
} from "../protocol";

export interface AgentSocketData {
  sessionId: string;
}

export interface TerminalSupervisorOptions {
  store: SessionStore;
  adapter?: TerminalAgentAdapter;
  enabled: boolean;
  transcriptLimit?: number;
}

type ManagedProcess = ReturnType<typeof Bun.spawn>;

export class TerminalSupervisor {
  readonly store: SessionStore;
  adapter?: TerminalAgentAdapter;

  private readonly enabled: boolean;
  private readonly transcriptLimit: number;
  private terminal?: Bun.Terminal;
  private process?: ManagedProcess;
  private status: AgentLifecycleStatus;
  private transcript: Uint8Array<ArrayBufferLike> = new Uint8Array();
  private sequence = 0;
  private lastError?: string;
  private lastExit?: AgentExit;
  private requiresInput = false;
  private activeBatchId?: string;
  private activeBatchProducedOutput = false;
  private readonly subscribers = new Set<ServerWebSocket<AgentSocketData>>();
  private persistTimer?: ReturnType<typeof setTimeout>;
  private readyTimer?: ReturnType<typeof setTimeout>;
  private exitHandling?: Promise<void>;
  private readonly pendingWork = new Set<Promise<unknown>>();
  private stopping = false;

  constructor(options: TerminalSupervisorOptions) {
    this.store = options.store;
    this.adapter = options.adapter;
    this.enabled = options.enabled;
    this.transcriptLimit = options.transcriptLimit ?? TERMINAL_TRANSCRIPT_LIMIT;
    this.status = options.enabled ? "offline" : "disabled";
    const persisted = options.store.persistedAgent;
    if (persisted?.transcriptTail) this.transcript = new TextEncoder().encode(persisted.transcriptTail);
    this.lastExit = persisted?.lastExit;
  }

  get snapshot(): AgentRuntimeSnapshot {
    const command = this.adapter?.command({ filePath: this.store.filePath, rootPath: this.store.rootPath });
    return {
      ...(this.adapter ? { adapterId: this.adapter.id, adapterLabel: this.adapter.label } : {}),
      ...(command ? { command } : {}),
      cwd: this.store.rootPath,
      status: this.status,
      ...(this.process ? { pid: this.process.pid } : {}),
      sequence: this.sequence,
      transcriptTail: new TextDecoder().decode(this.transcript),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(this.lastExit ? { lastExit: this.lastExit } : {}),
      canAcceptInput: Boolean(this.terminal && !this.terminal.closed && this.adapter?.canAcceptInput(this.status)),
      requiresInput: this.requiresInput,
    };
  }

  async initialize(autoStart = true): Promise<void> {
    await this.store.configureAgent({ enabled: this.enabled, ...(this.adapter ? { adapterId: this.adapter.id } : {}) });
    if (autoStart && this.enabled && this.adapter) await this.start();
  }

  async start(): Promise<AgentRuntimeSnapshot> {
    if (!this.enabled) throw new Error("Managed agent mode is disabled for this session.");
    if (!this.adapter) throw new Error("No agent adapter is configured. Pass --agent codex, claude, or opencode.");
    if (this.process && this.status !== "offline" && this.status !== "error") return this.snapshot;
    const executable = Bun.which(this.adapter.executable);
    if (!executable) {
      this.fail(`Agent executable not found: ${this.adapter.executable}`);
      return this.snapshot;
    }

    this.stopping = false;
    this.lastError = undefined;
    this.requiresInput = false;
    this.setStatus("starting");
    const context = { filePath: this.store.filePath, rootPath: this.store.rootPath };
    this.terminal = new Bun.Terminal({
      cols: TERMINAL_DEFAULT_COLS,
      rows: TERMINAL_DEFAULT_ROWS,
      name: "xterm-256color",
      data: (_terminal, chunk) => this.onData(chunk),
      exit: (_terminal, code) => {
        if (code !== 0 && !this.stopping) this.fail("The agent PTY closed unexpectedly.");
      },
    });

    try {
      const spawned = Bun.spawn(this.adapter.command(context), {
        cwd: this.store.rootPath,
        env: { ...process.env, TERM: "xterm-256color", ...(this.adapter.environment?.(context) ?? {}) },
        terminal: this.terminal,
      });
      this.process = spawned;
      this.exitHandling = spawned.exited.then((exitCode) => this.onExit(exitCode, spawned.signalCode));
      this.broadcastStatus();
    } catch (error) {
      this.terminal.close();
      this.terminal = undefined;
      this.process = undefined;
      this.fail(error instanceof Error ? error.message : "Could not launch the agent CLI.");
    }
    return this.snapshot;
  }

  async configure(adapter: TerminalAgentAdapter): Promise<AgentRuntimeSnapshot> {
    if (!this.enabled) throw new Error("Managed agent mode was disabled with --no-agent.");
    if (this.adapter?.id === adapter.id) return this.start();
    await this.stop();
    this.adapter = adapter;
    this.lastError = undefined;
    await this.store.configureAgent({ enabled: true, adapterId: adapter.id });
    return this.start();
  }

  async submitPending(): Promise<AgentRuntimeSnapshot> {
    if (!this.enabled) return this.snapshot;
    if (!this.process || this.status === "offline" || this.status === "error") await this.start();
    if (!this.terminal || this.terminal.closed || !this.adapter) return this.snapshot;
    if (this.activeBatchId || !this.adapter.canAcceptInput(this.status)) return this.snapshot;
    const envelope = await this.store.claimFeedback();
    if (!envelope) return this.snapshot;

    try {
      await this.adapter.submit(this.terminal, formatFeedbackEnvelope(envelope));
      this.activeBatchId = envelope.batchId;
      this.activeBatchProducedOutput = false;
      this.requiresInput = false;
      await this.store.markDeliverySubmitted(envelope.batchId);
      this.setStatus("working");
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : "Could not submit feedback to the agent terminal.";
      this.broadcastStatus();
    }
    return this.snapshot;
  }

  writeInput(data: string): void {
    if (!this.terminal || this.terminal.closed) throw new Error("The agent terminal is not running.");
    this.terminal.write(data);
    this.requiresInput = false;
    this.broadcastStatus();
  }

  resize(cols: number, rows: number): void {
    if (!this.terminal || this.terminal.closed) return;
    this.terminal.resize(Math.max(20, Math.min(500, cols)), Math.max(5, Math.min(200, rows)));
  }

  connect(socket: ServerWebSocket<AgentSocketData>): void {
    this.subscribers.add(socket);
    this.sendJson(socket, { type: "snapshot", agent: this.snapshot });
    if (this.transcript.byteLength > 0) socket.send(encodeTerminalOutputFrame(this.sequence, this.transcript), true);
  }

  disconnect(socket: ServerWebSocket<AgentSocketData>): void {
    this.subscribers.delete(socket);
  }

  async stop(): Promise<AgentRuntimeSnapshot> {
    if (!this.process && !this.terminal) {
      this.setStatus(this.enabled ? "offline" : "disabled");
      return this.snapshot;
    }
    this.stopping = true;
    this.setStatus("stopping");
    const managedProcess = this.process;
    if (managedProcess) {
      try { managedProcess.kill("SIGTERM"); } catch { /* Already exited. */ }
      await Promise.race([managedProcess.exited.catch(() => undefined), Bun.sleep(1_500)]);
      if (managedProcess.exitCode === null) {
        try { managedProcess.kill("SIGKILL"); } catch { /* Already exited. */ }
      }
      await this.exitHandling;
    }
    this.terminal?.close();
    this.terminal = undefined;
    this.process = undefined;
    this.activeBatchId = undefined;
    clearTimeout(this.readyTimer);
    clearTimeout(this.persistTimer);
    this.setStatus(this.enabled ? "offline" : "disabled");
    await this.flushTranscript();
    return this.snapshot;
  }

  async restart(): Promise<AgentRuntimeSnapshot> {
    await this.stop();
    return this.start();
  }

  async dispose(): Promise<void> {
    clearTimeout(this.persistTimer);
    clearTimeout(this.readyTimer);
    await this.stop();
    await Promise.allSettled([...this.pendingWork]);
    this.subscribers.clear();
  }

  private onData(chunk: Uint8Array): void {
    this.sequence += 1;
    this.transcript = appendBoundedTranscript(this.transcript, chunk, this.transcriptLimit);
    const frame = encodeTerminalOutputFrame(this.sequence, chunk);
    for (const socket of this.subscribers) socket.send(frame, true);
    if (this.stopping) return;
    this.scheduleTranscriptPersist();
    if (!this.adapter) return;
    const hasOutput = chunk.some((byte) => byte > 32);
    if (this.activeBatchId && hasOutput) {
      this.activeBatchProducedOutput = true;
      this.track(this.store.markDeliveryWorking(this.activeBatchId).catch(() => undefined));
    }
    const observation = this.adapter.observe(chunk);
    if (observation === "approval") {
      this.requiresInput = true;
      this.setStatus("working");
    } else if (observation === "ready") {
      this.track(this.becomeReady());
    } else if (hasOutput) {
      if (this.activeBatchId) {
        this.setStatus("working");
      } else {
        this.scheduleInitialReady();
      }
    }
  }

  private scheduleInitialReady(): void {
    clearTimeout(this.readyTimer);
    this.readyTimer = setTimeout(() => {
      if (!this.activeBatchId && this.status === "starting") this.track(this.becomeReady());
    }, 700);
  }

  private async becomeReady(): Promise<void> {
    clearTimeout(this.readyTimer);
    this.requiresInput = false;
    if (this.activeBatchId && this.activeBatchProducedOutput) {
      const batchId = this.activeBatchId;
      this.activeBatchId = undefined;
      this.activeBatchProducedOutput = false;
      await this.store.complete(batchId, { summary: "The managed agent returned to its ready prompt after processing the feedback batch." }).catch((error) => {
        this.lastError = error instanceof Error ? error.message : String(error);
      });
      if (this.store.snapshot.endedAt) {
        this.track(this.stop());
        return;
      }
    }
    this.setStatus("ready");
    await this.store.setAgentStatus("listening");
    await this.submitPending();
  }

  private async onExit(exitCode: number | null, signalCode: NodeJS.Signals | null): Promise<void> {
    this.activeBatchId = undefined;
    this.activeBatchProducedOutput = false;
    this.process = undefined;
    this.terminal?.close();
    this.terminal = undefined;
    this.lastExit = {
      code: exitCode ?? -1,
      ...(signalCode !== null ? { signal: signalCode } : {}),
      at: new Date().toISOString(),
    };
    this.setStatus(this.stopping ? "offline" : exitCode === 0 ? "offline" : "error");
    await this.store.setAgentStatus("offline");
    await this.flushTranscript();
  }

  private fail(message: string): void {
    this.lastError = message;
    this.setStatus("error");
    this.track(this.store.setAgentStatus("offline"));
  }

  private setStatus(status: AgentLifecycleStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.broadcastStatus();
  }

  private broadcastStatus(): void {
    const message: TerminalServerMessage = { type: "status", agent: this.snapshot };
    for (const socket of this.subscribers) this.sendJson(socket, message);
  }

  private sendJson(socket: ServerWebSocket<AgentSocketData>, message: TerminalServerMessage): void {
    socket.send(JSON.stringify(message));
  }

  private scheduleTranscriptPersist(): void {
    clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => this.track(this.flushTranscript()), 400);
  }

  private async flushTranscript(): Promise<void> {
    clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
    await this.store.persistAgentTranscript(new TextDecoder().decode(this.transcript), this.lastExit);
  }

  private track<T>(work: Promise<T>): void {
    this.pendingWork.add(work);
    void work.then(
      () => this.pendingWork.delete(work),
      () => this.pendingWork.delete(work),
    );
  }
}
