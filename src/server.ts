import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { SessionStore } from "./session-store";
import type { AgentReply, AgentStatus, FeedbackInput, FeedbackPollResult, SessionEndBy } from "./types";
import {
  contentTypeFor,
  isLocalRequest,
  resolveArtifactPath,
  resolveSafeFile,
  sessionIdForPath,
} from "./path-safety";

export const DEFAULT_PORT = 8765;
export const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1_000;

export interface PairPlanServerConfig {
  artifactInput: string;
  configuredRoot?: string;
  stateDir: string;
  port: number;
  idleTimeoutMs: number;
  installSignalHandlers?: boolean;
}

export interface PairPlanServerRuntime {
  readonly artifact: Awaited<ReturnType<typeof resolveArtifactPath>>;
  readonly store: SessionStore;
  readonly server: ReturnType<typeof Bun.serve>;
  readonly port: number;
  stop(): Promise<void>;
}

export function defaultStateDir(): string {
  return join(homedir(), ".pair-plan", "sessions");
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

export function parseServerConfig(args: string[] = Bun.argv.slice(2)): PairPlanServerConfig {
  const argv = args.filter((argument) => argument !== "--");
  const artifactInput = argumentValue(argv, "--artifact")
    ?? argv.find((argument) => !argument.startsWith("-"))
    ?? Bun.env.PAIR_PLAN_ARTIFACT
    ?? join(process.cwd(), "pair-plan-review-artifact.html");
  const configuredRoot = argumentValue(argv, "--root") ?? Bun.env.PAIR_PLAN_ARTIFACT_ROOT;
  const stateDir = resolve(argumentValue(argv, "--state-dir") ?? Bun.env.PAIR_PLAN_STATE_DIR ?? defaultStateDir());
  const port = Math.max(1, Math.min(65_535, Math.floor(parseNumber(argumentValue(argv, "--port") ?? Bun.env.PAIR_PLAN_PORT, DEFAULT_PORT))));
  const idleTimeoutMs = parseIdleTimeout(argumentValue(argv, "--idle-timeout-ms") ?? Bun.env.PAIR_PLAN_IDLE_TIMEOUT_MS);
  return { artifactInput, configuredRoot, stateDir, port, idleTimeoutMs };
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

function sessionPayload(store: SessionStore) {
  return {
    ...store.getSnapshot(),
    artifactUrl: `/api/session/${store.id}/artifact/`,
    eventsUrl: `/api/session/${store.id}/events`,
    feedbackUrl: `/api/session/${store.id}/feedback`,
    feedbackNextUrl: `/api/session/${store.id}/feedback/next`,
    feedbackAckUrl: `/api/session/${store.id}/feedback/ack`,
    replyUrl: `/api/session/${store.id}/reply`,
    completeUrl: `/api/session/${store.id}/complete`,
    statusUrl: `/api/session/${store.id}/status`,
    endUrl: `/api/session/${store.id}/end`,
  };
}

export async function startPairPlanServer(config: PairPlanServerConfig): Promise<PairPlanServerRuntime> {
  const artifact = await resolveArtifactPath(config.artifactInput, config.configuredRoot);
  const sessionId = sessionIdForPath(artifact.filePath);
  const store = await SessionStore.open({
    id: sessionId,
    filePath: artifact.filePath,
    rootPath: artifact.rootPath,
    stateDir: config.stateDir,
  });

  const clientRoot = join(dirname(fileURLToPath(import.meta.url)), "client");
  const indexHtml = await readFile(join(clientRoot, "index.html"), "utf8");
  const clientModule = await readFile(join(clientRoot, "app.ts"), "utf8");
  const clientJavascript = new Bun.Transpiler({ loader: "ts", target: "browser" }).transformSync(clientModule);
  const clientStyles = await readFile(join(clientRoot, "styles.css"), "utf8");
  const sessionPrefix = `/api/session/${store.id}`;

  let activeConnections = 0;
  let lastActivity = Date.now();
  let shuttingDown = false;
  let server: ReturnType<typeof Bun.serve>;
  let watcherTimer: ReturnType<typeof setInterval>;
  let idleTimer: ReturnType<typeof setInterval>;

  const touch = () => { lastActivity = Date.now(); };
  const openConnection = () => { activeConnections += 1; touch(); };
  const closeConnection = () => { activeConnections = Math.max(0, activeConnections - 1); touch(); };

  function sseResponse(request: Request): Response {
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
        const unsubscribe = store.subscribe(send);
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
        send({ type: "snapshot", snapshot: store.getSnapshot() });
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

  async function route(request: Request): Promise<Response> {
    touch();
    if (!isLocalRequest(request)) return text("Pair Plan only accepts loopback requests.", "text/plain; charset=utf-8", 403);

    const url = new URL(request.url);
    const pathname = url.pathname;

    if (request.method === "GET" && pathname === "/health") {
      return json({ ok: true, sessionId: store.id, revision: store.snapshot.artifactRevision, ended: Boolean(store.snapshot.endedAt) });
    }

    if (request.method === "GET" && pathname === "/") return text(indexHtml, "text/html; charset=utf-8");
    if (request.method === "GET" && pathname === "/client/styles.css") return text(clientStyles, "text/css; charset=utf-8");
    if (request.method === "GET" && pathname === "/client/app.ts") return text(clientJavascript, "text/javascript; charset=utf-8");
    if (request.method === "GET" && pathname === "/api/session") return json(sessionPayload(store));
    if (pathname === "/api/session" || !pathname.startsWith(sessionPrefix)) return notFound();

    const artifactPrefix = `${sessionPrefix}/artifact`;
    if (request.method === "GET" && (pathname === artifactPrefix || pathname.startsWith(`${artifactPrefix}/`))) {
      const relativeAsset = pathname.slice(artifactPrefix.length).replace(/^\/+/, "");
      const artifactPath = relativeAsset
        ? await resolveSafeFile(artifact.rootPath, relativeAsset)
        : artifact.filePath;
      if (!artifactPath) return notFound("Artifact asset is outside the allowed root or does not exist.");
      return new Response(Bun.file(artifactPath), {
        headers: {
          "content-type": contentTypeFor(artifactPath),
          "cache-control": "no-cache",
        },
      });
    }

    if (request.method === "GET" && pathname === sessionPrefix) return json(store.getSnapshot());
    if (request.method === "GET" && pathname === `${sessionPrefix}/events`) return sseResponse(request);

    if (request.method === "GET" && pathname === `${sessionPrefix}/feedback/next`) {
      const requestedTimeout = Number(url.searchParams.get("timeout") ?? 25_000);
      const timeoutMs = Math.min(30_000, Math.max(1_000, Number.isFinite(requestedTimeout) ? requestedTimeout : 25_000));
      openConnection();
      try {
        const result = await store.waitForFeedback(timeoutMs, request.signal);
        return result ? json(result) : new Response(null, { status: 204 });
      } catch (error) {
        if (request.signal.aborted) return new Response(null, { status: 499 });
        throw error;
      } finally {
        closeConnection();
      }
    }

    if (request.method === "POST" && pathname === `${sessionPrefix}/feedback`) {
      if (store.snapshot.endedAt) return json({ error: "Session has ended; reopen it before sending feedback." }, 409);
      const payload = await parseJson(request);
      if (!payload) return badRequest("Expected a JSON feedback payload.");
      try {
        const items = await store.enqueue(normalizeFeedbackList(payload));
        return json({ queued: items, snapshot: store.getSnapshot() }, 201);
      } catch (error) {
        return badRequest(error instanceof Error ? error.message : "Invalid feedback payload.");
      }
    }

    if (request.method === "POST" && pathname === `${sessionPrefix}/feedback/ack`) {
      const payload = await parseJson(request);
      if (!payload || typeof payload.batchId !== "string") return badRequest("batchId is required.");
      try {
        await store.acknowledge(payload.batchId);
        return json({ ok: true, snapshot: store.getSnapshot() });
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "Unknown delivery batch." }, 409);
      }
    }

    if (request.method === "POST" && pathname === `${sessionPrefix}/complete`) {
      const payload = await parseJson(request);
      if (!payload || typeof payload.batchId !== "string") return badRequest("batchId is required.");
      try {
        const message = await store.complete(payload.batchId, normalizeReply(payload));
        return json({ message, snapshot: store.getSnapshot() });
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "Unknown delivery batch." }, 409);
      }
    }

    if (request.method === "POST" && pathname === `${sessionPrefix}/reply`) {
      const payload = await parseJson(request);
      if (!payload) return badRequest("Expected a JSON reply payload.");
      try {
        const message = await store.recordReply(normalizeReply(payload));
        return json({ message, snapshot: store.getSnapshot() });
      } catch (error) {
        return badRequest(error instanceof Error ? error.message : "Invalid agent reply.");
      }
    }

    if (request.method === "POST" && pathname === `${sessionPrefix}/status`) {
      const payload = await parseJson(request);
      const status = payload?.status;
      if (status !== "listening" && status !== "working" && status !== "offline") return badRequest("status must be listening, working, or offline.");
      await store.setAgentStatus(status as AgentStatus);
      return json({ ok: true, snapshot: store.getSnapshot() });
    }

    if (request.method === "POST" && pathname === `${sessionPrefix}/end`) {
      const payload = await parseJson(request);
      const by = payload?.by;
      if (by !== undefined && by !== "agent" && by !== "user") return badRequest("by must be agent or user.");
      await store.end((by as SessionEndBy | undefined) ?? "agent");
      return json({ ok: true, snapshot: store.getSnapshot() });
    }

    if (request.method === "POST" && pathname === `${sessionPrefix}/reopen`) {
      await store.reopen();
      return json({ ok: true, snapshot: store.getSnapshot() });
    }

    return notFound();
  }

  const stop = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(watcherTimer);
    clearInterval(idleTimer);
    store.close();
    await server.stop(true);
  };

  server = Bun.serve({
    hostname: "127.0.0.1",
    port: config.port,
    fetch: route,
  });

  watcherTimer = setInterval(() => {
    void store.refreshArtifact().catch((error) => console.error("Artifact watcher error:", error));
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
    const runtime = await startPairPlanServer({ ...parseServerConfig(), installSignalHandlers: true });
    console.log(`Pair Plan listening at http://127.0.0.1:${runtime.port}`);
    console.log(`Reviewing ${runtime.artifact.filePath}`);
    console.log(`Session ${runtime.store.id}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
