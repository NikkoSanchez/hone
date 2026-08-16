import { fileURLToPath } from "node:url";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveArtifactPath, sessionIdForPath } from "./path-safety";
import type { SessionEndBy, SessionSnapshot } from "./types";

export interface RuntimeRecord {
  artifactPath: string;
  sessionId: string;
  pid: number;
  port: number;
  stateDir: string;
  startedAt: string;
}

export interface RecentArtifactRecord {
  artifactPath: string;
  rootPath: string;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  lastTouchedAt: string;
  sessionUpdatedAt: string;
  endedAt?: string;
}

export interface SessionPayload extends SessionSnapshot {
  artifactUrl: string;
  eventsUrl: string;
  feedbackUrl: string;
  feedbackNextUrl: string;
  feedbackAckUrl: string;
  replyUrl: string;
  completeUrl: string;
  statusUrl: string;
  endUrl: string;
}

export interface EnsureServerOptions {
  artifactPath: string;
  rootPath: string;
  stateDir: string;
  port: number;
  idleTimeoutMs: number;
  reopen?: boolean;
}

interface RuntimeRegistry {
  version: 1;
  runtimes: RuntimeRecord[];
}

interface PersistedArtifactSession {
  id: string;
  filePath: string;
  rootPath: string;
  updatedAt: string;
  endedAt?: string;
}

export interface SessionHandle {
  record: RuntimeRecord;
  baseUrl: string;
  session: SessionPayload;
}

function runtimeRegistryPath(stateDir: string): string {
  return join(stateDir, "runtime.json");
}

async function readRegistry(stateDir: string): Promise<RuntimeRegistry> {
  const value = await readFile(runtimeRegistryPath(stateDir), "utf8").catch(() => "");
  if (!value) return { version: 1, runtimes: [] };
  try {
    const parsed = JSON.parse(value) as Partial<RuntimeRegistry>;
    return {
      version: 1,
      runtimes: Array.isArray(parsed.runtimes) ? parsed.runtimes.filter(isRuntimeRecord) : [],
    };
  } catch {
    return { version: 1, runtimes: [] };
  }
}

async function writeRegistry(stateDir: string, registry: RuntimeRegistry): Promise<void> {
  const path = runtimeRegistryPath(stateDir);
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, JSON.stringify(registry, null, 2));
}

function isRuntimeRecord(value: unknown): value is RuntimeRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.artifactPath === "string"
    && typeof record.sessionId === "string"
    && typeof record.pid === "number"
    && typeof record.port === "number"
    && typeof record.stateDir === "string"
    && typeof record.startedAt === "string";
}

function isPersistedArtifactSession(value: unknown): value is PersistedArtifactSession {
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  return typeof state.id === "string"
    && typeof state.filePath === "string"
    && typeof state.rootPath === "string"
    && typeof state.updatedAt === "string"
    && (state.endedAt === undefined || typeof state.endedAt === "string");
}

async function fetchSession(record: RuntimeRecord): Promise<SessionPayload | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${record.port}/api/session`, { signal: AbortSignal.timeout(800) });
    if (!response.ok) return null;
    const session = await response.json() as SessionPayload;
    return session.id === record.sessionId && session.filePath === record.artifactPath ? session : null;
  } catch {
    return null;
  }
}

async function waitForSession(record: RuntimeRecord, timeoutMs = 6_000): Promise<SessionPayload> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const session = await fetchSession(record);
    if (session) return session;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Pair Plan server did not become ready on port ${record.port}.`);
}

function serverScriptPath(): string {
  return fileURLToPath(new URL("./server.ts", import.meta.url));
}

function bunExecutable(): string {
  return Bun.argv[0] ?? process.execPath;
}

async function spawnServer(options: EnsureServerOptions, sessionId: string): Promise<RuntimeRecord> {
  const child = Bun.spawn([
    bunExecutable(),
    serverScriptPath(),
    "--artifact",
    options.artifactPath,
    "--root",
    options.rootPath,
    "--state-dir",
    options.stateDir,
    "--port",
    String(options.port),
    "--idle-timeout-ms",
    String(options.idleTimeoutMs),
  ], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    detached: true,
  });
  child.unref();

  return {
    artifactPath: options.artifactPath,
    sessionId,
    pid: child.pid,
    port: options.port,
    stateDir: options.stateDir,
    startedAt: new Date().toISOString(),
  };
}

export async function ensureServer(options: EnsureServerOptions): Promise<SessionHandle> {
  const sessionId = sessionIdForPath(options.artifactPath);
  const registry = await readRegistry(options.stateDir);
  const existing = registry.runtimes.find((runtime) => runtime.artifactPath === options.artifactPath);

  if (existing) {
    const session = await fetchSession(existing);
    if (session) {
      if (session.endedAt && options.reopen) {
        await postJson(`${baseUrl(existing)}/api/session/${existing.sessionId}/reopen`, {});
        const reopened = await fetchSession(existing);
        if (!reopened) throw new Error("Pair Plan session did not reopen cleanly.");
        return { record: existing, baseUrl: baseUrl(existing), session: reopened };
      }
      return { record: existing, baseUrl: baseUrl(existing), session };
    }
    registry.runtimes = registry.runtimes.filter((runtime) => runtime !== existing);
    await writeRegistry(options.stateDir, registry);
  }

  const record = await spawnServer(options, sessionId);
  const session = await waitForSession(record).catch(async (error) => {
    try { process.kill(record.pid, "SIGTERM"); } catch { /* The child may already have exited. */ }
    throw error;
  });
  registry.runtimes.push(record);
  await writeRegistry(options.stateDir, registry);
  if (session.endedAt && options.reopen) {
    await postJson(`${baseUrl(record)}/api/session/${record.sessionId}/reopen`, {});
    const reopened = await fetchSession(record);
    if (!reopened) throw new Error("Pair Plan session did not reopen cleanly.");
    return { record, baseUrl: baseUrl(record), session: reopened };
  }
  return { record, baseUrl: baseUrl(record), session };
}

function baseUrl(record: RuntimeRecord): string {
  return `http://127.0.0.1:${record.port}`;
}

async function postJson(url: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof payload.error === "string" ? payload.error : `Pair Plan request failed: ${response.status}`);
  return payload;
}

export async function stopServer(artifactPath: string, stateDir: string): Promise<boolean> {
  const registry = await readRegistry(stateDir);
  const runtime = registry.runtimes.find((candidate) => candidate.artifactPath === artifactPath);
  if (!runtime) return false;

  try {
    process.kill(runtime.pid, "SIGTERM");
  } catch {
    // A dead process is already stopped; remove its stale registry entry.
  }

  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline && await fetchSession(runtime)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  registry.runtimes = registry.runtimes.filter((candidate) => candidate !== runtime);
  await writeRegistry(stateDir, registry);
  return true;
}

export async function listRuntimes(stateDir: string): Promise<Array<RuntimeRecord & { healthy: boolean; session?: SessionPayload }>> {
  const registry = await readRegistry(stateDir);
  const results: Array<RuntimeRecord & { healthy: boolean; session?: SessionPayload }> = [];
  let changed = false;
  for (const runtime of registry.runtimes) {
    const session = await fetchSession(runtime);
    if (!session) {
      changed = true;
      continue;
    }
    results.push({ ...runtime, healthy: true, session });
  }
  if (changed) {
    const healthyPaths = new Set(results.map((runtime) => runtime.artifactPath));
    registry.runtimes = registry.runtimes.filter((runtime) => healthyPaths.has(runtime.artifactPath));
    await writeRegistry(stateDir, registry);
  }
  return results;
}

export async function listRecentArtifacts(stateDir: string, limit = 20): Promise<RecentArtifactRecord[]> {
  const entries = await readdir(stateDir, { withFileTypes: true }).catch(() => []);
  const records = await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && entry.name !== "runtime.json")
    .map(async (entry): Promise<RecentArtifactRecord | null> => {
      const statePath = join(stateDir, entry.name);
      const persisted = await Bun.file(statePath).json().catch(() => null);
      if (!isPersistedArtifactSession(persisted)) return null;

      const artifactStat = await stat(persisted.filePath).catch(() => null);
      if (!artifactStat?.isFile()) return null;
      const createdAt = artifactStat.birthtime.toISOString();
      const updatedAt = artifactStat.mtime.toISOString();
      const lastTouchedAt = new Date(Math.max(artifactStat.birthtimeMs, artifactStat.mtimeMs)).toISOString();
      return {
        artifactPath: persisted.filePath,
        rootPath: persisted.rootPath,
        sessionId: persisted.id,
        createdAt,
        updatedAt,
        lastTouchedAt,
        sessionUpdatedAt: persisted.updatedAt,
        ...(persisted.endedAt ? { endedAt: persisted.endedAt } : {}),
      };
    }));

  return records
    .filter((record): record is RecentArtifactRecord => record !== null)
    .sort((left, right) => right.lastTouchedAt.localeCompare(left.lastTouchedAt))
    .slice(0, Math.max(0, Math.floor(limit)));
}

export async function endSession(handle: SessionHandle, by: SessionEndBy = "agent"): Promise<void> {
  await postJson(`${handle.baseUrl}/api/session/${handle.session.id}/end`, { by });
}

export async function reopenSession(handle: SessionHandle): Promise<SessionPayload> {
  await postJson(`${handle.baseUrl}/api/session/${handle.session.id}/reopen`, {});
  const session = await fetchSession(handle.record);
  if (!session) throw new Error("Pair Plan session did not reopen cleanly.");
  return session;
}

export async function resolveCliArtifact(inputPath: string, configuredRoot?: string): Promise<Awaited<ReturnType<typeof resolveArtifactPath>>> {
  return resolveArtifactPath(inputPath, configuredRoot);
}
