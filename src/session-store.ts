import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  AgentReply,
  AgentStatus,
  DeliveryState,
  FeedbackEnvelope,
  FeedbackPollResult,
  FeedbackInput,
  FeedbackItem,
  HistoryMessage,
  SessionEvent,
  SessionEventType,
  SessionSnapshot,
  SessionEndBy,
  StoredSessionState,
} from "./types";
import { hashText } from "./path-safety";

interface SessionStoreOptions {
  id: string;
  filePath: string;
  rootPath: string;
  stateDir: string;
}

type EventListener = (event: SessionEvent) => void;
type FeedbackWaiter = {
  resolve: (result: FeedbackPollResult | null) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
};

function now(): string {
  return new Date().toISOString();
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function hashFile(filePath: string): Promise<string> {
  const content = await Bun.file(filePath).text();
  return hashText(content);
}

export class SessionStore {
  readonly id: string;
  readonly filePath: string;
  readonly rootPath: string;

  private readonly stateFilePath: string;
  private state: StoredSessionState;
  private readonly listeners = new Set<EventListener>();
  private readonly waiters = new Set<FeedbackWaiter>();
  private writeChain: Promise<void> = Promise.resolve();

  private constructor(options: SessionStoreOptions, state: StoredSessionState) {
    this.id = options.id;
    this.filePath = options.filePath;
    this.rootPath = options.rootPath;
    this.stateFilePath = join(options.stateDir, `${options.id}.json`);
    this.state = state;
  }

  static async open(options: SessionStoreOptions): Promise<SessionStore> {
    await mkdir(options.stateDir, { recursive: true });
    const stateFilePath = join(options.stateDir, `${options.id}.json`);
    const existing = await Bun.file(stateFilePath).json().catch(() => null) as StoredSessionState | null;
    const artifactHash = await hashFile(options.filePath);
    const artifactRevision = existing
      ? artifactHash === existing.artifactHash ? existing.artifactRevision : existing.artifactRevision + 1
      : 1;

    const state: StoredSessionState = {
      id: options.id,
      filePath: options.filePath,
      rootPath: options.rootPath,
      artifactRevision,
      artifactHash,
      queue: existing?.queue ?? [],
      delivery: existing?.delivery,
      history: existing?.history ?? [],
      agentStatus: existing?.agentStatus ?? "listening",
      updatedAt: now(),
      ...(existing?.endedAt ? { endedAt: existing.endedAt } : {}),
      ...(existing?.endedBy ? { endedBy: existing.endedBy } : {}),
    };

    const store = new SessionStore(options, state);
    await store.persist();
    return store;
  }

  get snapshot(): SessionSnapshot {
    return this.getSnapshot();
  }

  getSnapshot(): SessionSnapshot {
    return {
      id: this.state.id,
      filePath: this.state.filePath,
      artifactRevision: this.state.artifactRevision,
      queue: clone(this.state.queue),
      history: clone(this.state.history),
      agentStatus: this.state.agentStatus,
      updatedAt: this.state.updatedAt,
      deliveryBatchId: this.state.delivery?.batchId ?? null,
      ...(this.state.endedAt ? { endedAt: this.state.endedAt } : {}),
      ...(this.state.endedBy ? { endedBy: this.state.endedBy } : {}),
    };
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async enqueue(inputs: FeedbackInput[]): Promise<FeedbackItem[]> {
    const queuedItems: FeedbackItem[] = [];
    for (const input of inputs) {
      const item: FeedbackItem = {
        ...clone(input),
        id: `feedback-${randomUUID()}`,
        createdAt: now(),
      };
      const replacementIndex = item.queueKey
        ? this.state.queue.findIndex((existing) => existing.queueKey === item.queueKey)
        : -1;

      if (replacementIndex >= 0) {
        const existing = this.state.queue[replacementIndex];
        this.state.queue[replacementIndex] = { ...item, id: existing.id };
      } else {
        this.state.queue.push(item);
      }
      queuedItems.push(item);
    }

    await this.persist();
    this.publish("queue");
    this.resolveWaiters();
    return queuedItems;
  }

  async waitForFeedback(timeoutMs: number, signal?: AbortSignal): Promise<FeedbackPollResult | null> {
    if (this.state.endedAt && this.state.endedBy) return this.endedEnvelope();
    if (this.state.delivery) return clone(this.state.delivery.envelope);
    if (this.state.queue.length > 0) return this.createDelivery();

    return new Promise<FeedbackPollResult | null>((resolve, reject) => {
      const waiter: FeedbackWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.removeWaiter(waiter);
          resolve(null);
        }, timeoutMs),
        signal,
      };
      waiter.onAbort = () => {
        this.removeWaiter(waiter);
        reject(new Error("Feedback poll aborted"));
      };
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      this.waiters.add(waiter);
    });
  }

  async acknowledge(batchId: string): Promise<void> {
    this.takeDelivery(batchId);
    await this.persist();
    this.publish("queue");
    this.publish("message");
  }

  async complete(batchId: string, reply: AgentReply): Promise<HistoryMessage> {
    const deliveredIds = this.takeDelivery(batchId);
    const userMessage = this.addHistory("user", `Delivered ${deliveredIds.length} feedback item${deliveredIds.length === 1 ? "" : "s"} to the agent.`);
    if (typeof reply.revision === "number" && reply.revision > this.state.artifactRevision) {
      this.state.artifactRevision = reply.revision;
    }
    this.state.agentStatus = "listening";
    const detail = reply.changedAnchors?.length
      ? ` Changed anchors: ${reply.changedAnchors.join(", ")}.`
      : "";
    const agentMessage = this.addHistory("agent", `${reply.summary}${detail}`);
    await this.persist();
    this.publish("queue");
    this.publish("message", userMessage);
    this.publish("message", agentMessage);
    this.publish("presence");
    return agentMessage;
  }

  async recordReply(reply: AgentReply): Promise<HistoryMessage> {
    if (typeof reply.revision === "number" && reply.revision > this.state.artifactRevision) {
      this.state.artifactRevision = reply.revision;
    }
    this.state.agentStatus = "listening";
    const detail = reply.changedAnchors?.length
      ? ` Changed anchors: ${reply.changedAnchors.join(", ")}.`
      : "";
    const message = this.addHistory("agent", `${reply.summary}${detail}`);
    await this.persist();
    this.publish("message", message);
    this.publish("presence");
    return message;
  }

  async setAgentStatus(status: AgentStatus): Promise<void> {
    this.state.agentStatus = status;
    await this.persist();
    this.publish("presence");
  }

  async end(by: SessionEndBy = "agent"): Promise<void> {
    if (!this.state.endedAt) {
      this.state.endedAt = now();
      this.state.endedBy = by;
    }
    this.state.agentStatus = "offline";
    await this.persist();
    this.publish("presence");
    this.resolveWaiters();
  }

  async reopen(): Promise<void> {
    this.state.endedAt = undefined;
    this.state.endedBy = undefined;
    this.state.agentStatus = "listening";
    await this.persist();
    this.publish("presence");
  }

  close(): void {
    const error = new Error("Pair Plan session store closed");
    for (const waiter of [...this.waiters]) {
      this.removeWaiter(waiter);
      waiter.reject(error);
    }
    this.listeners.clear();
  }

  async refreshArtifact(): Promise<boolean> {
    const artifactHash = await hashFile(this.filePath);
    if (artifactHash === this.state.artifactHash) return false;

    this.state.artifactHash = artifactHash;
    this.state.artifactRevision += 1;
    await this.persist();
    this.publish("artifact");
    return true;
  }

  private async createDelivery(): Promise<FeedbackEnvelope> {
    if (this.state.delivery) return clone(this.state.delivery.envelope);

    const envelope: FeedbackEnvelope = {
      sessionId: this.state.id,
      file: this.state.filePath,
      revision: this.state.artifactRevision,
      batchId: `batch-${randomUUID()}`,
      prompts: clone(this.state.queue),
    };
    const delivery: DeliveryState = {
      batchId: envelope.batchId,
      envelope,
      deliveredAt: now(),
    };
    this.state.delivery = delivery;
    this.state.agentStatus = "working";
    await this.persist();
    this.publish("presence");
    return clone(envelope);
  }

  private resolveWaiters(): void {
    if (this.waiters.size === 0 || (!this.state.endedAt && this.state.queue.length === 0)) return;
    const waiters = [...this.waiters];
    this.waiters.clear();
    const resultPromise = this.state.endedAt && this.state.endedBy
      ? Promise.resolve(this.endedEnvelope())
      : this.createDelivery();
    void resultPromise.then((envelope) => {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
        waiter.resolve(clone(envelope));
      }
    }).catch((error: Error) => {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    });
  }

  private removeWaiter(waiter: FeedbackWaiter): void {
    this.waiters.delete(waiter);
    clearTimeout(waiter.timer);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
  }

  private addHistory(role: HistoryMessage["role"], body: string): HistoryMessage {
    const message: HistoryMessage = {
      id: `message-${randomUUID()}`,
      role,
      body,
      createdAt: now(),
    };
    this.state.history.unshift(message);
    this.state.history = this.state.history.slice(0, 50);
    this.state.updatedAt = message.createdAt;
    return message;
  }

  private takeDelivery(batchId: string): FeedbackItem[] {
    if (!this.state.delivery || this.state.delivery.batchId !== batchId) {
      throw new Error(`Unknown delivery batch: ${batchId}`);
    }

    const deliveredItems = this.state.delivery.envelope.prompts;
    const deliveredIds = new Set(deliveredItems.map((item) => item.id));
    this.state.queue = this.state.queue.filter((item) => !deliveredIds.has(item.id));
    this.state.delivery = undefined;
    return deliveredItems;
  }

  private endedEnvelope(): Extract<FeedbackPollResult, { status: "ended" }> {
    if (!this.state.endedAt || !this.state.endedBy) throw new Error("Ended session is missing end metadata.");
    return {
      sessionId: this.state.id,
      file: this.state.filePath,
      revision: this.state.artifactRevision,
      status: "ended",
      endedAt: this.state.endedAt,
      endedBy: this.state.endedBy,
    };
  }

  private publish(type: SessionEventType, message?: HistoryMessage): void {
    const event: SessionEvent = {
      type,
      snapshot: this.getSnapshot(),
      ...(message ? { message } : {}),
    };
    for (const listener of this.listeners) listener(clone(event));
  }

  private async persist(): Promise<void> {
    this.state.updatedAt = now();
    const serialized = JSON.stringify(this.state, null, 2);
    this.writeChain = this.writeChain.then(() => Bun.write(this.stateFilePath, serialized).then(() => undefined));
    await this.writeChain;
  }
}
