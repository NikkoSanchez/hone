#!/usr/bin/env bun

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { HoneAgentClient } from "./agent-client";
import { defaultStateDir } from "./server";
import { ensureServer, listRecentArtifacts, listRuntimes, resolveCliArtifact, stopAllServers, stopServer, type SessionHandle } from "./runtime";
import { isFeedbackEnded, type AgentReply, type CodeReviewFinding } from "./types";

const COMMANDS = new Set(["open", "poll", "complete", "review", "status", "recent", "end", "server", "stop", "reopen", "help"]);
const VALUE_FLAGS = new Set([
  "--artifact",
  "--root",
  "--state-dir",
  "--port",
  "--idle-timeout-ms",
  "--timeout-ms",
  "--batch-id",
  "--summary",
  "--revision",
  "--changed",
  "--body",
  "--by",
  "--limit",
  "--patch-file",
  "--findings-file",
  "--source",
  "--agent",
]);

const HELP = `Hone · local agent review loop

Usage:
  hone <artifact> [artifact...] [--no-open] [--reopen]
  hone poll <artifact> [--timeout-ms 30000] [--reopen]
  hone complete <artifact> --batch-id ID --summary TEXT [--revision N] [--changed ANCHOR]
  hone review <artifact> --patch-file PATH [--findings-file PATH] [--summary TEXT]
  hone status [artifact]
  hone recent [--limit 20]
  hone end <artifact>
  hone server <artifact>
  hone stop <artifact>
  hone stop --all

Commands:
  open       Ensure the local server/session and print its review URL.
  poll       Wait for one feedback batch and print compact JSON to stdout.
  complete   Atomically acknowledge a batch and post the agent reply.
  review     Import an agent code review for local pairing (never posts externally).
  status     Show healthy local runtimes, or one artifact's state.
  recent     List known artifacts as date-and-path lines, newest first.
  end        End a session without deleting its artifact or history.
  server     Run one server in the foreground for diagnostics.
  stop       Stop one daemon, or all daemons with --all, and remove runtime records.
  reopen     Reopen an ended session explicitly.

Common options:
  --state-dir PATH          Session state directory (default: ~/.hone/sessions)
  --root PATH               Artifact asset root
  --port PORT               Local server port (default: 8765)
  --idle-timeout-ms MS      Daemon idle timeout (default: 1800000; 0 disables)
  --agent ID                Managed CLI adapter: codex, claude, or opencode
  --no-agent                Use compatibility polling without a managed terminal
  --limit N                 Maximum artifacts returned by recent (default: 20)
  --no-open                 Do not open the review URL in the system browser
  --reopen                  Reopen a session previously ended by a user or agent
  --help                    Show this help

Agent loop:
  hone plan.html --no-open
  hone poll plan.html
  hone complete plan.html --batch-id BATCH_ID --summary "Updated the plan" --revision 2

Successful open and complete responses include the exact next_command. Keep
following it until poll returns an ended session.
`;

interface ParsedArgs {
  command: string;
  args: string[];
}

interface CliContext {
  artifactInput: string;
  artifactPath: string;
  rootPath: string;
  stateDir: string;
  port: number;
  idleTimeoutMs: number;
  handle: SessionHandle;
}

function parseCommand(argv: string[]): ParsedArgs {
  if (argv.length === 0) return { command: "help", args: [] };
  if (argv[0] === "--help" || argv[0] === "-h") return { command: "help", args: [] };
  if (COMMANDS.has(argv[0]!)) return { command: argv[0]!, args: argv.slice(1) };
  return { command: "open", args: argv };
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name) || args.some((argument) => argument.startsWith(`${name}=`));
}

function flagValue(args: string[], name: string): string | undefined {
  const index = args.findIndex((argument) => argument === name);
  if (index >= 0) return args[index + 1];
  const prefix = `${name}=`;
  return args.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function flagValues(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === name && args[index + 1]) {
      values.push(args[index + 1]!);
      index += 1;
    } else if (argument.startsWith(`${name}=`)) {
      values.push(argument.slice(name.length + 1));
    }
  }
  return values;
}

function positionalArgs(args: string[]): string[] {
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument.startsWith("--")) {
      if (VALUE_FLAGS.has(argument)) index += 1;
      continue;
    }
    if (!argument.startsWith("-")) positionals.push(argument);
  }
  return positionals;
}

function artifactInput(args: string[], required = true): string | undefined {
  return flagValue(args, "--artifact") ?? positionalArgs(args)[0] ?? (required ? undefined : undefined);
}

function numberOption(args: string[], name: string, fallback: number): number {
  const parsed = Number(flagValue(args, name));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function idleTimeoutOption(args: string[]): number {
  const value = flagValue(args, "--idle-timeout-ms") ?? Bun.env.HONE_IDLE_TIMEOUT_MS;
  if (value?.toLowerCase() === "off") return 0;
  return Math.max(0, numberOption(args, "--idle-timeout-ms", 30 * 60 * 1_000));
}

function stateDirectory(args: string[]): string {
  return resolve(flagValue(args, "--state-dir") ?? Bun.env.HONE_STATE_DIR ?? defaultStateDir());
}

function portOption(args: string[]): number {
  return Math.max(1, Math.min(65_535, Math.floor(numberOption(args, "--port", Number(Bun.env.HONE_PORT ?? 8765)))));
}

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function shellArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function commandContext(current: CliContext): string {
  return `${shellArgument(current.artifactPath)} --root ${shellArgument(current.rootPath)} --state-dir ${shellArgument(current.stateDir)} --port ${current.port}`;
}

function pollCommand(current: CliContext): string {
  return `hone poll ${commandContext(current)}`;
}

function reviewUrl(current: CliContext, view?: "review"): string {
  const query = new URLSearchParams({ artifact: current.handle.session.id });
  if (view) query.set("view", view);
  return `${current.handle.baseUrl}/?${query}`;
}

function openReviewUrl(url: string): void {
  if (process.platform === "darwin") {
    Bun.spawn(["open", url], { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
  } else if (process.platform === "win32") {
    Bun.spawn(["cmd", "/c", "start", "", url], { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
  } else {
    Bun.spawn(["xdg-open", url], { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
  }
}

async function context(args: string[], required = true, inputOverride?: string, portOverride?: number): Promise<CliContext | null> {
  const input = inputOverride ?? artifactInput(args, required);
  if (!input) {
    if (required) throw new Error("An artifact path is required.");
    return null;
  }
  const resolved = await resolveCliArtifact(input, flagValue(args, "--root"));
  const stateDir = stateDirectory(args);
  const handle = await ensureServer({
    artifactPath: resolved.filePath,
    rootPath: resolved.rootPath,
    stateDir,
    port: portOverride ?? portOption(args),
    idleTimeoutMs: idleTimeoutOption(args),
    reopen: hasFlag(args, "--reopen"),
    ...(flagValue(args, "--agent") ? { agentId: flagValue(args, "--agent") } : {}),
    noAgent: hasFlag(args, "--no-agent"),
  });
  return {
    artifactInput: input,
    artifactPath: resolved.filePath,
    rootPath: resolved.rootPath,
    stateDir,
    port: handle.record.port,
    idleTimeoutMs: idleTimeoutOption(args),
    handle,
  };
}

async function runOpen(args: string[]): Promise<void> {
  const inputs = flagValue(args, "--artifact") ? [flagValue(args, "--artifact")!] : positionalArgs(args);
  if (inputs.length === 0) throw new Error("At least one artifact path is required.");
  const running = await listRuntimes(stateDirectory(args));
  const usedPorts = new Set(running.map((runtime) => runtime.port));
  let candidatePort = portOption(args);
  const attached: CliContext[] = [];
  for (const input of inputs) {
    const existing = running.find((runtime) => runtime.artifactPath === resolve(input));
    while (!existing && usedPorts.has(candidatePort)) candidatePort += 1;
    const current = await context(args, true, input, existing?.port ?? candidatePort);
    if (!current) continue;
    attached.push(current);
    usedPorts.add(current.port);
    candidatePort = Math.max(candidatePort + 1, current.port + 1);
  }
  const current = attached[0];
  if (!current) return;
  const url = current.handle.baseUrl;
  if (!hasFlag(args, "--no-open")) openReviewUrl(reviewUrl(current));
  output({
    status: current.handle.session.endedAt ? "ended" : "ready",
    artifact: current.artifactPath,
    session_id: current.handle.session.id,
    revision: current.handle.session.artifactRevision,
    url,
    port: current.port,
    ended_at: current.handle.session.endedAt,
    review_url: reviewUrl(current),
    artifacts: attached.map((item) => ({ artifact: item.artifactPath, session_id: item.handle.session.id, url: item.handle.baseUrl, review_url: reviewUrl(item) })),
    agent: current.handle.session.agent,
    ...(!current.handle.session.endedAt && !current.handle.session.agent?.adapterId ? { next_command: pollCommand(current) } : {}),
  });
}

async function runReview(args: string[]): Promise<void> {
  const current = await context(args);
  if (!current) return;
  const patchFile = flagValue(args, "--patch-file");
  if (!patchFile) throw new Error("review requires --patch-file.");
  const patch = await readFile(resolve(patchFile), "utf8");
  const findingsFile = flagValue(args, "--findings-file");
  let findings: CodeReviewFinding[] = [];
  if (findingsFile) {
    const parsed = JSON.parse(await readFile(resolve(findingsFile), "utf8")) as unknown;
    const values = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { findings?: unknown }).findings)
        ? (parsed as { findings: unknown[] }).findings
        : null;
    if (!values) throw new Error("findings file must contain an array or an object with a findings array.");
    findings = values as CodeReviewFinding[];
  }
  const client = new HoneAgentClient(current.handle.baseUrl, current.handle.session.id);
  await client.review({
    patch,
    findings,
    ...(flagValue(args, "--summary") ? { summary: flagValue(args, "--summary") } : {}),
    source: flagValue(args, "--source") ?? "agent review",
  });
  if (!hasFlag(args, "--no-open")) openReviewUrl(reviewUrl(current, "review"));
  output({
    status: "review-imported",
    artifact: current.artifactPath,
    session_id: current.handle.session.id,
    url: reviewUrl(current, "review"),
    findings: findings.length,
    external_posted: false,
  });
}

async function runPoll(args: string[]): Promise<void> {
  const current = await context(args);
  if (!current) return;
  const client = new HoneAgentClient(current.handle.baseUrl, current.handle.session.id);

  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    while (!controller.signal.aborted) {
      const result = await client.nextFeedback({
        signal: controller.signal,
        pollTimeoutMs: Math.max(1_000, Math.min(30_000, Math.floor(numberOption(args, "--timeout-ms", 25_000)))),
      });
      if (!result) continue;
      if (isFeedbackEnded(result)) {
        output({ ...result, status: "ended" });
        return;
      }
      output({
        ...result,
        status: "feedback",
        next_command: `hone complete ${commandContext(current)} --batch-id ${shellArgument(result.batchId)} --summary '<summary>' --revision ${result.revision}`,
      });
      return;
    }
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}

async function runComplete(args: string[]): Promise<void> {
  const current = await context(args);
  if (!current) return;
  const batchId = flagValue(args, "--batch-id");
  const summary = flagValue(args, "--summary");
  if (!batchId || !summary) throw new Error("complete requires --batch-id and --summary.");
  const reply: AgentReply = {
    summary,
    ...(flagValue(args, "--body") ? { body: flagValue(args, "--body") } : {}),
    ...(flagValue(args, "--revision") ? { revision: Math.max(1, Math.floor(Number(flagValue(args, "--revision")))) } : {}),
    ...(flagValues(args, "--changed").length ? { changedAnchors: flagValues(args, "--changed") } : {}),
  };
  const client = new HoneAgentClient(current.handle.baseUrl, current.handle.session.id);
  await client.complete(batchId, reply);
  output({ status: "completed", artifact: current.artifactPath, batch_id: batchId, ...reply, next_command: pollCommand(current) });
}

async function runStatus(args: string[]): Promise<void> {
  const stateDir = stateDirectory(args);
  const input = artifactInput(args, false);
  if (input) {
    const resolved = await resolveCliArtifact(input, flagValue(args, "--root"));
    const runtimes = await listRuntimes(stateDir);
    const runtime = runtimes.find((candidate) => candidate.artifactPath === resolved.filePath);
    output(runtime ? { status: "running", ...runtime } : { status: "stopped", artifact: resolved.filePath });
    return;
  }
  output({ status: "ok", state_dir: stateDir, runtimes: await listRuntimes(stateDir) });
}

async function runRecent(args: string[]): Promise<void> {
  const stateDir = stateDirectory(args);
  const limit = Math.max(0, Math.floor(numberOption(args, "--limit", 20)));
  const artifacts = await listRecentArtifacts(stateDir, limit);
  process.stdout.write(artifacts.map((artifact) => {
    const date = artifact.lastTouchedAt.slice(0, 10);
    return `${date}  ${artifact.artifactPath}`;
  }).join("\n"));
  if (artifacts.length > 0) process.stdout.write("\n");
}

async function runEnd(args: string[]): Promise<void> {
  const current = await context(args);
  if (!current) return;
  const client = new HoneAgentClient(current.handle.baseUrl, current.handle.session.id);
  await client.end((flagValue(args, "--by") as "agent" | "user" | undefined) ?? "agent");
  output({ status: "ended", artifact: current.artifactPath, session_id: current.handle.session.id });
}

async function runReopen(args: string[]): Promise<void> {
  const current = await context([...args, "--reopen"]);
  if (!current) return;
  output({ status: "ready", artifact: current.artifactPath, session_id: current.handle.session.id, url: current.handle.baseUrl, review_url: reviewUrl(current) });
}

async function runStop(args: string[]): Promise<void> {
  if (hasFlag(args, "--all")) {
    if (artifactInput(args, false)) throw new Error("stop --all cannot be combined with an artifact path.");
    const stopped = await stopAllServers(stateDirectory(args));
    output({
      status: stopped.length > 0 ? "stopped" : "not-running",
      count: stopped.length,
      artifacts: stopped.map((runtime) => runtime.artifactPath),
    });
    return;
  }

  const input = artifactInput(args);
  if (!input) throw new Error("stop requires an artifact path.");
  const resolved = await resolveCliArtifact(input, flagValue(args, "--root"));
  const stopped = await stopServer(resolved.filePath, stateDirectory(args));
  output({ status: stopped ? "stopped" : "not-running", artifact: resolved.filePath });
}

async function runForegroundServer(args: string[]): Promise<void> {
  const input = artifactInput(args);
  if (!input) throw new Error("server requires an artifact path.");
  const { startHoneServer } = await import("./server");
  const runtime = await startHoneServer({
    artifactInput: input,
    configuredRoot: flagValue(args, "--root"),
    stateDir: stateDirectory(args),
    port: portOption(args),
    idleTimeoutMs: idleTimeoutOption(args),
    ...(flagValue(args, "--agent") ? { agentId: flagValue(args, "--agent") } : {}),
    noAgent: hasFlag(args, "--no-agent"),
    installSignalHandlers: true,
  });
  console.error(`Hone listening at http://127.0.0.1:${runtime.port}`);
  console.error(`Reviewing ${runtime.artifact.filePath}`);
  await new Promise<void>(() => undefined);
}

async function main(): Promise<void> {
  const parsed = parseCommand(Bun.argv.slice(2));
  if (parsed.command === "help") {
    console.log(HELP);
    return;
  }
  if (parsed.command === "open") return runOpen(parsed.args);
  if (parsed.command === "poll") return runPoll(parsed.args);
  if (parsed.command === "complete") return runComplete(parsed.args);
  if (parsed.command === "review") return runReview(parsed.args);
  if (parsed.command === "status") return runStatus(parsed.args);
  if (parsed.command === "recent") return runRecent(parsed.args);
  if (parsed.command === "end") return runEnd(parsed.args);
  if (parsed.command === "reopen") return runReopen(parsed.args);
  if (parsed.command === "stop") return runStop(parsed.args);
  if (parsed.command === "server") return runForegroundServer(parsed.args);
  throw new Error(`Unknown command: ${parsed.command}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`hone: ${message}\n`);
  process.exitCode = 1;
});
