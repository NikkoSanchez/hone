import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { SessionStore } from "./session-store";
import type { AgentReply, AgentStatus, CodeReviewFinding, CodeReviewInput, FeedbackInput, FeedbackPollResult, SessionEndBy } from "./types";
import { availableTerminalAgentAdapters, getTerminalAgentAdapter, selectTerminalAgentAdapter, terminalAgentAdapterIds } from "./terminal-bridge/adapters";
import { parseTerminalClientMessage } from "./terminal-bridge/protocol";
import { TerminalSupervisor, type AgentSocketData } from "./terminal-bridge/server/supervisor";
import {
  contentTypeFor,
  isLocalRequest,
  resolveArtifactPath,
  resolveSafeFile,
  sessionIdForPath,
} from "./path-safety";

export const DEFAULT_PORT = 8765;
export const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1_000;

export interface HoneServerConfig {
  artifactInput: string;
  configuredRoot?: string;
  stateDir: string;
  port: number;
  idleTimeoutMs: number;
  agentId?: string;
  noAgent?: boolean;
  installSignalHandlers?: boolean;
}

export interface HoneServerRuntime {
  readonly artifact: Awaited<ReturnType<typeof resolveArtifactPath>>;
  readonly store: SessionStore;
  readonly server: Bun.Server<AgentSocketData>;
  readonly port: number;
  stop(): Promise<void>;
}

export function defaultStateDir(): string {
  return join(homedir(), ".hone", "sessions");
}

function argumentValue(args: string[], name: string): string | undefined {
  const index = args.findIndex((argument) => argument === name);
  if (index >= 0) return args[index + 1];
  const prefix = `${name}=`;
  return args.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function parseNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseIdleTimeout(value: string | undefined): number {
  if (!value) return DEFAULT_IDLE_TIMEOUT_MS;
  if (value.toLowerCase() === "off") return 0;
  return Math.max(0, parseNumber(value, DEFAULT_IDLE_TIMEOUT_MS));
}

export function parseServerConfig(args: string[] = Bun.argv.slice(2)): HoneServerConfig {
  const argv = args.filter((argument) => argument !== "--");
  const artifactInput = argumentValue(argv, "--artifact")
    ?? argv.find((argument) => !argument.startsWith("-"))
    ?? Bun.env.HONE_ARTIFACT;
  if (!artifactInput) {
    throw new Error("An artifact path is required. Pass one as an argument or set HONE_ARTIFACT.");
  }
  const configuredRoot = argumentValue(argv, "--root") ?? Bun.env.HONE_ARTIFACT_ROOT;
  const stateDir = resolve(argumentValue(argv, "--state-dir") ?? Bun.env.HONE_STATE_DIR ?? defaultStateDir());
  const port = Math.max(1, Math.min(65_535, Math.floor(parseNumber(argumentValue(argv, "--port") ?? Bun.env.HONE_PORT, DEFAULT_PORT))));
  const idleTimeoutMs = parseIdleTimeout(argumentValue(argv, "--idle-timeout-ms") ?? Bun.env.HONE_IDLE_TIMEOUT_MS);
  const agentId = argumentValue(argv, "--agent") ?? Bun.env.HONE_AGENT;
  const noAgent = argv.includes("--no-agent") || Bun.env.HONE_NO_AGENT === "1";
  return { artifactInput, configuredRoot, stateDir, port, idleTimeoutMs, ...(agentId ? { agentId } : {}), noAgent };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function text(value: string, contentType = "text/plain; charset=utf-8", status = 200): Response {
  return new Response(value, {
    status,
    headers: { "content-type": contentType, "cache-control": "no-store" },
  });
}

function badRequest(message: string): Response {
  return json({ error: message }, 400);
}

function notFound(message = "Not found"): Response {
  return json({ error: message }, 404);
}

async function parseJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value = await request.json();
    return value && typeof value === "object" ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function stringValue(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new Error(`${field} is too long`);
  return normalized;
}

function normalizeFeedback(value: unknown): FeedbackInput {
  if (!value || typeof value !== "object") throw new Error("Feedback item must be an object");
  const input = value as Record<string, unknown>;
  const rawTarget = input.target;
  if (!rawTarget || typeof rawTarget !== "object") throw new Error("Feedback target is required");
  const targetInput = rawTarget as Record<string, unknown>;
  const target = {
    anchor: stringValue(targetInput.anchor, "target.anchor", 500),
    ...(typeof targetInput.label === "string" ? { label: targetInput.label.slice(0, 200) } : {}),
    ...(typeof targetInput.quote === "string" ? { quote: targetInput.quote.slice(0, 1200) } : {}),
    ...(typeof targetInput.contextHash === "string" ? { contextHash: targetInput.contextHash.slice(0, 200) } : {}),
    ...(typeof targetInput.startOffset === "number" ? { startOffset: Math.max(0, Math.floor(targetInput.startOffset)) } : {}),
    ...(typeof targetInput.endOffset === "number" ? { endOffset: Math.max(0, Math.floor(targetInput.endOffset)) } : {}),
  };

  return {
    target,
    body: stringValue(input.body, "body", 8_000),
    ...(typeof input.queueKey === "string" && input.queueKey.trim() ? { queueKey: input.queueKey.trim().slice(0, 200) } : {}),
    ...(typeof input.tag === "string" && input.tag.trim() ? { tag: input.tag.trim().slice(0, 80) } : {}),
  };
}

function normalizeFeedbackList(payload: Record<string, unknown>): FeedbackInput[] {
  const rawItems = Array.isArray(payload.items)
    ? payload.items
    : Array.isArray(payload.prompts)
      ? payload.prompts
      : [payload];
  if (rawItems.length === 0) throw new Error("At least one feedback item is required");
  if (rawItems.length > 100) throw new Error("A feedback batch cannot contain more than 100 items");
  return rawItems.map(normalizeFeedback);
}

function normalizeReply(payload: Record<string, unknown>): AgentReply {
  return {
    summary: stringValue(payload.summary, "summary", 4_000),
    ...(typeof payload.body === "string" ? { body: payload.body.slice(0, 8_000) } : {}),
    ...(typeof payload.revision === "number" ? { revision: Math.max(1, Math.floor(payload.revision)) } : {}),
    ...(Array.isArray(payload.changedAnchors)
      ? { changedAnchors: payload.changedAnchors.filter((value): value is string => typeof value === "string").slice(0, 100) }
      : {}),
  };
}

function normalizeReview(payload: Record<string, unknown>): CodeReviewInput {
  const patch = stringValue(payload.patch, "patch", 5_000_000);
  const rawFindings = payload.findings === undefined ? [] : payload.findings;
  if (!Array.isArray(rawFindings)) throw new Error("findings must be an array");
  if (rawFindings.length > 500) throw new Error("A review cannot contain more than 500 findings");
  const findings = rawFindings.map((value, index) => {
    if (!value || typeof value !== "object") throw new Error(`findings[${index}] must be an object`);
    const finding = value as Record<string, unknown>;
    const severity: CodeReviewFinding["severity"] = finding.severity === "error" || finding.severity === "warning" ? finding.severity : "info";
    const side: CodeReviewFinding["side"] = finding.side === "deletions" || finding.side === "additions" ? finding.side : undefined;
    return {
      ...(typeof finding.id === "string" ? { id: finding.id.slice(0, 200) } : {}),
      file: stringValue(finding.file, `findings[${index}].file`, 1_000),
      ...(typeof finding.line === "number" ? { line: Math.max(1, Math.floor(finding.line)) } : {}),
      ...(side ? { side } : {}),
      severity,
      title: stringValue(finding.title, `findings[${index}].title`, 500),
      body: stringValue(finding.body, `findings[${index}].body`, 8_000),
    };
  });
  return {
    patch,
    findings,
    ...(typeof payload.summary === "string" && payload.summary.trim() ? { summary: payload.summary.trim().slice(0, 4_000) } : {}),
    ...(typeof payload.source === "string" && payload.source.trim() ? { source: payload.source.trim().slice(0, 200) } : {}),
  };
}

function sessionPayload(store: SessionStore, supervisor?: TerminalSupervisor) {
  return {
    ...store.getSnapshot(),
    ...(supervisor ? { agent: supervisor.snapshot } : {}),
    rootPath: store.rootPath,
    artifactUrl: `/api/session/${store.id}/artifact/`,
    eventsUrl: `/api/session/${store.id}/events`,
    feedbackUrl: `/api/session/${store.id}/feedback`,
    feedbackNextUrl: `/api/session/${store.id}/feedback/next`,
    feedbackAckUrl: `/api/session/${store.id}/feedback/ack`,
    replyUrl: `/api/session/${store.id}/reply`,
    completeUrl: `/api/session/${store.id}/complete`,
    statusUrl: `/api/session/${store.id}/status`,
    endUrl: `/api/session/${store.id}/end`,
    reviewUrl: `/api/session/${store.id}/review`,
    agentStartUrl: `/api/session/${store.id}/agent/start`,
    agentSendUrl: `/api/session/${store.id}/agent/send`,
    agentInputUrl: `/api/session/${store.id}/agent/input`,
    agentResizeUrl: `/api/session/${store.id}/agent/resize`,
    agentStopUrl: `/api/session/${store.id}/agent/stop`,
    agentRestartUrl: `/api/session/${store.id}/agent/restart`,
    agentConfigureUrl: `/api/session/${store.id}/agent/configure`,
    agentTerminalUrl: `/api/session/${store.id}/agent/terminal`,
    availableAgentAdapters: availableTerminalAgentAdapters().map(({ id, label }) => ({ id, label })),
    managedAgentEnabled: supervisor?.snapshot.status !== "disabled",
  };
}

export async function startHoneServer(config: HoneServerConfig): Promise<HoneServerRuntime> {
  const artifact = await resolveArtifactPath(config.artifactInput, config.configuredRoot);
  const sessionId = sessionIdForPath(artifact.filePath);
  const store = await SessionStore.open({
    id: sessionId,
    filePath: artifact.filePath,
    rootPath: artifact.rootPath,
    stateDir: config.stateDir,
  });
  const stores = new Map<string, SessionStore>([[store.id, store]]);
  const artifacts = new Map<string, typeof artifact>([[store.id, artifact]]);
  const persistedAdapterId = store.persistedAgent?.configuration.adapterId;
  const requestedAdapter = config.agentId
    ? getTerminalAgentAdapter(config.agentId)
    : persistedAdapterId
      ? getTerminalAgentAdapter(persistedAdapterId)
      : selectTerminalAgentAdapter();
  if (config.agentId && !requestedAdapter) {
    throw new Error(`Unknown agent adapter: ${config.agentId}. Choose one of: ${terminalAgentAdapterIds().join(", ")}.`);
  }
  const supervisor = new TerminalSupervisor({ store, adapter: requestedAdapter, enabled: !config.noAgent });
  const supervisors = new Map<string, TerminalSupervisor>([[store.id, supervisor]]);
  await supervisor.initialize(Boolean(requestedAdapter));
  let primaryStore = store;

  const clientRoot = join(dirname(fileURLToPath(import.meta.url)), "client");
  const indexHtml = await readFile(join(clientRoot, "index.html"), "utf8");
  const clientBuild = await Bun.build({
    entrypoints: [join(clientRoot, "app.ts")],
    target: "browser",
    format: "esm",
    minify: false,
  });
  const javascriptOutput = clientBuild.outputs.find((output) => output.path.endsWith(".js"));
  if (!clientBuild.success || !javascriptOutput) {
    throw new Error(`Could not build Hone client: ${clientBuild.logs.map(String).join("\n")}`);
  }
  const clientJavascript = await javascriptOutput.text();
  const xtermStyles = await readFile(join(clientRoot, "../../node_modules/@xterm/xterm/css/xterm.css"), "utf8");
  const clientStyles = `${await readFile(join(clientRoot, "styles.css"), "utf8")}\n${xtermStyles}`;
  let activeConnections = 0;
  let lastActivity = Date.now();
  let shuttingDown = false;
  let server: Bun.Server<AgentSocketData>;
  let watcherTimer: ReturnType<typeof setInterval>;
  let idleTimer: ReturnType<typeof setInterval>;

  const touch = () => { lastActivity = Date.now(); };
  const openConnection = () => { activeConnections += 1; touch(); };
  const closeConnection = () => { activeConnections = Math.max(0, activeConnections - 1); touch(); };

  function sseResponse(request: Request, activeStore: SessionStore): Response {
    let closeStream: (() => void) | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        openConnection();
        const encoder = new TextEncoder();
        let closed = false;
        const send = (event: unknown) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          } catch {
            closeStream?.();
          }
        };
        const unsubscribe = activeStore.subscribe(send);
        const heartbeat = setInterval(() => {
          if (!closed) controller.enqueue(encoder.encode(": keep-alive\n\n"));
        }, 15_000);
        const close = () => {
          if (closed) return;
          closed = true;
          clearInterval(heartbeat);
          unsubscribe();
          closeConnection();
          try {
            controller.close();
          } catch {
            // The browser already closed the stream.
          }
        };
        closeStream = close;
        request.signal.addEventListener("abort", close, { once: true });
        send({ type: "snapshot", snapshot: activeStore.getSnapshot() });
      },
      cancel() {
        closeStream?.();
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      },
    });
  }

  async function route(request: Request): Promise<Response | undefined> {
    touch();
    if (!isLocalRequest(request)) return text("Hone only accepts loopback requests.", "text/plain; charset=utf-8", 403);

    const url = new URL(request.url);
    const pathname = url.pathname;
    const requestedSessionId = url.searchParams.get("artifact") ?? primaryStore.id;
    const requestedStore = stores.get(requestedSessionId);

    if (request.method === "GET" && pathname === "/health") {
      return json({ ok: true, sessionId: primaryStore.id, revision: primaryStore.snapshot.artifactRevision, ended: Boolean(primaryStore.snapshot.endedAt) });
    }

    if (request.method === "GET" && pathname === "/") return text(indexHtml, "text/html; charset=utf-8");
    if (request.method === "GET" && pathname === "/client/styles.css") return text(clientStyles, "text/css; charset=utf-8");
    if (request.method === "GET" && pathname === "/client/app.ts") return text(clientJavascript, "text/javascript; charset=utf-8");
    if (request.method === "GET" && pathname === "/api/session") {
      return requestedStore ? json(sessionPayload(requestedStore, supervisors.get(requestedStore.id))) : notFound("Unknown artifact session.");
    }
    if (request.method === "GET" && pathname === "/api/artifacts") {
      return json({ artifacts: [...stores.values()].map((item) => ({
        id: item.id,
        name: basename(item.filePath),
        filePath: item.filePath,
        url: `/?artifact=${encodeURIComponent(item.id)}`,
        active: item.id === requestedSessionId,
        revision: item.snapshot.artifactRevision,
        hasReview: Boolean(item.snapshot.review),
      })) });
    }
    if (request.method === "POST" && pathname === "/api/artifacts") {
      const payload = await parseJson(request);
      if (!payload || typeof payload.artifactPath !== "string") return badRequest("artifactPath is required.");
      try {
        const attachedArtifact = await resolveArtifactPath(payload.artifactPath, artifact.rootPath);
        const attachedId = sessionIdForPath(attachedArtifact.filePath);
        let attachedStore = stores.get(attachedId);
        if (!attachedStore) {
          attachedStore = await SessionStore.open({
            id: attachedId,
            filePath: attachedArtifact.filePath,
            rootPath: attachedArtifact.rootPath,
            stateDir: config.stateDir,
          });
          stores.set(attachedId, attachedStore);
          artifacts.set(attachedId, attachedArtifact);
          const attachedPersistedAdapter = attachedStore.persistedAgent?.configuration.adapterId;
          const attachedAdapter = config.agentId
            ? getTerminalAgentAdapter(config.agentId)
            : attachedPersistedAdapter
              ? getTerminalAgentAdapter(attachedPersistedAdapter)
              : selectTerminalAgentAdapter();
          const attachedSupervisor = new TerminalSupervisor({ store: attachedStore, adapter: attachedAdapter, enabled: !config.noAgent });
          supervisors.set(attachedId, attachedSupervisor);
          await attachedSupervisor.initialize(Boolean(attachedAdapter));
        }
        return json({ session: sessionPayload(attachedStore, supervisors.get(attachedId)) }, 201);
      } catch (error) {
        return badRequest(error instanceof Error ? error.message : "Could not attach artifact.");
      }
    }

    const sessionMatch = pathname.match(/^\/api\/session\/([^/]+)/);
    const activeStore = sessionMatch ? stores.get(sessionMatch[1]!) : undefined;
    const activeArtifact = sessionMatch ? artifacts.get(sessionMatch[1]!) : undefined;
    if (!activeStore || !activeArtifact) return notFound();
    const sessionPrefix = `/api/session/${activeStore.id}`;
    const activeSupervisor = supervisors.get(activeStore.id);

    const artifactPrefix = `${sessionPrefix}/artifact`;
    if (request.method === "GET" && (pathname === artifactPrefix || pathname.startsWith(`${artifactPrefix}/`))) {
      const relativeAsset = pathname.slice(artifactPrefix.length).replace(/^\/+/, "");
      const artifactPath = relativeAsset
        ? await resolveSafeFile(activeArtifact.rootPath, relativeAsset)
        : activeArtifact.filePath;
      if (!artifactPath) return notFound("Artifact asset is outside the allowed root or does not exist.");
      return new Response(Bun.file(artifactPath), {
        headers: {
          "content-type": contentTypeFor(artifactPath),
          "cache-control": "no-cache",
        },
      });
    }

    if (request.method === "GET" && pathname === sessionPrefix) return json(sessionPayload(activeStore, activeSupervisor));
    if (request.method === "GET" && pathname === `${sessionPrefix}/events`) {
      server.timeout(request, 0);
      return sseResponse(request, activeStore);
    }

    if (request.method === "GET" && pathname === `${sessionPrefix}/agent/terminal`) {
      if (!activeSupervisor) return notFound("Managed agent is unavailable.");
      return server.upgrade(request, { data: { sessionId: activeStore.id } }) ? undefined : badRequest("Could not upgrade the terminal connection.");
    }

    if (request.method === "POST" && pathname === `${sessionPrefix}/agent/configure`) {
      if (!activeSupervisor) return notFound("Managed agent is unavailable.");
      const payload = await parseJson(request);
      const adapter = typeof payload?.adapterId === "string" ? getTerminalAgentAdapter(payload.adapterId) : undefined;
      if (!adapter) return badRequest(`adapterId must be one of: ${terminalAgentAdapterIds().join(", ")}.`);
      try {
        return json({ agent: await activeSupervisor.configure(adapter), snapshot: activeStore.getSnapshot() });
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "Could not configure the agent." }, 409);
      }
    }

    if (request.method === "POST" && pathname === `${sessionPrefix}/agent/start`) {
      if (!activeSupervisor) return notFound("Managed agent is unavailable.");
      try { return json({ agent: await activeSupervisor.start() }); } catch (error) {
        return json({ error: error instanceof Error ? error.message : "Could not start the agent." }, 409);
      }
    }

    if (request.method === "POST" && pathname === `${sessionPrefix}/agent/send`) {
      if (!activeSupervisor) return notFound("Managed agent is unavailable.");
      if (activeStore.snapshot.endedAt) return json({ error: "Session has ended; reopen it before sending feedback." }, 409);
      const payload = await parseJson(request);
      if (!payload) return badRequest("Expected a JSON feedback payload.");
      try {
        const items = await activeStore.enqueue(normalizeFeedbackList(payload));
        const agent = await activeSupervisor.submitPending();
        return json({ queued: items, snapshot: activeStore.getSnapshot(), agent }, 201);
      } catch (error) {
        return badRequest(error instanceof Error ? error.message : "Could not send feedback.");
      }
    }

    if (request.method === "POST" && pathname === `${sessionPrefix}/agent/input`) {
      if (!activeSupervisor) return notFound("Managed agent is unavailable.");
      const payload = await parseJson(request);
      if (!payload || typeof payload.data !== "string" || payload.data.length > 64_000) return badRequest("data must be a terminal input string.");
      try { activeSupervisor.writeInput(payload.data); return json({ agent: activeSupervisor.snapshot }); } catch (error) {
        return json({ error: error instanceof Error ? error.message : "Could not write terminal input." }, 409);
      }
    }

    if (request.method === "POST" && pathname === `${sessionPrefix}/agent/resize`) {
      if (!activeSupervisor) return notFound("Managed agent is unavailable.");
      const payload = await parseJson(request);
      if (!payload || typeof payload.cols !== "number" || typeof payload.rows !== "number") return badRequest("cols and rows are required.");
      activeSupervisor.resize(payload.cols, payload.rows);
      return json({ agent: activeSupervisor.snapshot });
    }

    if (request.method === "POST" && pathname === `${sessionPrefix}/agent/stop`) {
      if (!activeSupervisor) return notFound("Managed agent is unavailable.");
      return json({ agent: await activeSupervisor.stop() });
    }

    if (request.method === "POST" && pathname === `${sessionPrefix}/agent/restart`) {
      if (!activeSupervisor) return notFound("Managed agent is unavailable.");
      try { return json({ agent: await activeSupervisor.restart() }); } catch (error) {
        return json({ error: error instanceof Error ? error.message : "Could not restart the agent." }, 409);
      }
    }

    if (request.method === "GET" && pathname === `${sessionPrefix}/feedback/next`) {
      const requestedTimeout = Number(url.searchParams.get("timeout") ?? 25_000);
      const timeoutMs = Math.min(30_000, Math.max(1_000, Number.isFinite(requestedTimeout) ? requestedTimeout : 25_000));
      openConnection();
      try {
        const result = await activeStore.waitForFeedback(timeoutMs, request.signal);
        return result ? json(result) : new Response(null, { status: 204 });
      } catch (error) {
        if (request.signal.aborted) return new Response(null, { status: 499 });
        throw error;
      } finally {
        closeConnection();
      }
    }

    if (request.method === "POST" && pathname === `${sessionPrefix}/feedback`) {
      if (activeStore.snapshot.endedAt) return json({ error: "Session has ended; reopen it before sending feedback." }, 409);
      const payload = await parseJson(request);
      if (!payload) return badRequest("Expected a JSON feedback payload.");
      try {
        const items = await activeStore.enqueue(normalizeFeedbackList(payload));
        return json({ queued: items, snapshot: activeStore.getSnapshot() }, 201);
      } catch (error) {
        return badRequest(error instanceof Error ? error.message : "Invalid feedback payload.");
      }
    }

    if (request.method === "POST" && pathname === `${sessionPrefix}/feedback/ack`) {
      const payload = await parseJson(request);
      if (!payload || typeof payload.batchId !== "string") return badRequest("batchId is required.");
      try {
        await activeStore.acknowledge(payload.batchId);
        return json({ ok: true, snapshot: activeStore.getSnapshot() });
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "Unknown delivery batch." }, 409);
      }
    }

    if (request.method === "POST" && pathname === `${sessionPrefix}/complete`) {
      const payload = await parseJson(request);
      if (!payload || typeof payload.batchId !== "string") return badRequest("batchId is required.");
      try {
        const message = await activeStore.complete(payload.batchId, normalizeReply(payload));
        return json({ message, snapshot: activeStore.getSnapshot() });
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "Unknown delivery batch." }, 409);
      }
    }

    if (request.method === "POST" && pathname === `${sessionPrefix}/reply`) {
      const payload = await parseJson(request);
      if (!payload) return badRequest("Expected a JSON reply payload.");
      try {
        const message = await activeStore.recordReply(normalizeReply(payload));
        return json({ message, snapshot: activeStore.getSnapshot() });
      } catch (error) {
        return badRequest(error instanceof Error ? error.message : "Invalid agent reply.");
      }
    }

    if (request.method === "POST" && pathname === `${sessionPrefix}/review`) {
      const payload = await parseJson(request);
      if (!payload) return badRequest("Expected a JSON review payload.");
      try {
        const review = await activeStore.setReview(normalizeReview(payload));
        return json({ review, snapshot: activeStore.getSnapshot() }, 201);
      } catch (error) {
        return badRequest(error instanceof Error ? error.message : "Invalid review payload.");
      }
    }

    if (request.method === "POST" && pathname === `${sessionPrefix}/status`) {
      const payload = await parseJson(request);
      const status = payload?.status;
      if (status !== "listening" && status !== "working" && status !== "offline") return badRequest("status must be listening, working, or offline.");
      await activeStore.setAgentStatus(status as AgentStatus);
      return json({ ok: true, snapshot: activeStore.getSnapshot() });
    }

    if (request.method === "POST" && pathname === `${sessionPrefix}/end`) {
      const payload = await parseJson(request);
      const by = payload?.by;
      if (by !== undefined && by !== "agent" && by !== "user") return badRequest("by must be agent or user.");
      await activeSupervisor?.stop();
      await activeStore.end((by as SessionEndBy | undefined) ?? "agent");
      return json({ ok: true, snapshot: activeStore.getSnapshot() });
    }

    if (request.method === "POST" && pathname === `${sessionPrefix}/reopen`) {
      await activeStore.reopen();
      if (activeSupervisor?.adapter && activeSupervisor.snapshot.status !== "disabled") await activeSupervisor.start();
      return json({ ok: true, snapshot: activeStore.getSnapshot() });
    }

    if (request.method === "POST" && pathname === `${sessionPrefix}/detach`) {
      if (stores.size === 1) return json({ error: "The last artifact cannot be detached while this daemon is running." }, 409);
      await activeSupervisor?.dispose();
      activeStore.close();
      stores.delete(activeStore.id);
      artifacts.delete(activeStore.id);
      supervisors.delete(activeStore.id);
      if (activeStore.id === primaryStore.id) primaryStore = stores.values().next().value!;
      return json({ ok: true });
    }

    return notFound();
  }

  const stop = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(watcherTimer);
    clearInterval(idleTimer);
    await Promise.all([...supervisors.values()].map((item) => item.dispose()));
    for (const item of stores.values()) item.close();
    await server.stop(true);
  };

  server = Bun.serve<AgentSocketData>({
    hostname: "127.0.0.1",
    port: config.port,
    fetch: route,
    websocket: {
      idleTimeout: 0,
      open(socket) {
        openConnection();
        supervisors.get(socket.data.sessionId)?.connect(socket);
      },
      message(socket, message) {
        const activeSupervisor = supervisors.get(socket.data.sessionId);
        if (!activeSupervisor || typeof message !== "string") return;
        const frame = parseTerminalClientMessage(message);
        if (!frame) return;
        if (frame.type === "input") {
          try { activeSupervisor.writeInput(frame.data); } catch { /* Status frames explain offline input. */ }
        } else {
          activeSupervisor.resize(frame.cols, frame.rows);
        }
      },
      close(socket) {
        supervisors.get(socket.data.sessionId)?.disconnect(socket);
        closeConnection();
      },
    },
  });

  watcherTimer = setInterval(() => {
    for (const item of stores.values()) {
      void item.refreshArtifact().catch((error) => console.error("Artifact watcher error:", error));
    }
  }, 1_000);

  idleTimer = setInterval(() => {
    if (config.idleTimeoutMs <= 0 || activeConnections > 0 || Date.now() - lastActivity < config.idleTimeoutMs) return;
    void stop();
  }, 1_000);

  if (config.installSignalHandlers) {
    const onSignal = () => {
      void stop().finally(() => process.exit(0));
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  }

  return { artifact, store, server, port: server.port ?? config.port, stop };
}

if (import.meta.main) {
  try {
    const runtime = await startHoneServer({ ...parseServerConfig(), installSignalHandlers: true });
    console.log(`Hone listening at http://127.0.0.1:${runtime.port}`);
    console.log(`Reviewing ${runtime.artifact.filePath}`);
    console.log(`Session ${runtime.store.id}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
