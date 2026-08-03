#!/usr/bin/env bun

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { PairPlanAgentClient } from "./agent-client";
import { defaultStateDir } from "./server";
import { endSession, ensureServer, listRuntimes, resolveCliArtifact, stopServer, type SessionHandle } from "./runtime";
import { isFeedbackEnded, type AgentReply } from "./types";

const COMMANDS = new Set(["open", "poll", "complete", "status", "end", "server", "stop", "reopen", "help"]);
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
]);

const HELP = `Pair Plan · local agent review loop

Usage:
  pair-plan <artifact> [--no-open] [--reopen]
  pair-plan poll <artifact> [--timeout-ms 30000] [--reopen]
  pair-plan complete <artifact> --batch-id ID --summary TEXT [--revision N] [--changed ANCHOR]
  pair-plan status [artifact]
  pair-plan end <artifact>
  pair-plan server <artifact>
  pair-plan stop <artifact>

Commands:
  open       Ensure the local server/session and print its review URL.
  poll       Wait for one feedback batch and print compact JSON to stdout.
  complete   Atomically acknowledge a batch and post the agent reply.
  status     Show healthy local runtimes, or one artifact's state.
  end        End a session without deleting its artifact or history.
  server     Run one server in the foreground for diagnostics.
  stop       Stop the daemon for one artifact and remove its runtime record.
  reopen     Reopen an ended session explicitly.

Common options:
  --state-dir PATH          Session state directory (default: ~/.pair-plan/sessions)
  --root PATH               Artifact asset root
  --port PORT               Local server port (default: 8765)
  --idle-timeout-ms MS      Daemon idle timeout (default: 1800000; 0 disables)
  --no-open                 Do not open the review URL in the system browser
  --reopen                  Reopen a session previously ended by a user or agent
  --help                    Show this help

Agent loop:
  pair-plan plan.html --no-open
  pair-plan poll plan.html
  pair-plan complete plan.html --batch-id BATCH_ID --summary "Updated the plan" --revision 2
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
  const value = flagValue(args, "--idle-timeout-ms") ?? Bun.env.PAIR_PLAN_IDLE_TIMEOUT_MS;
  if (value?.toLowerCase() === "off") return 0;
  return Math.max(0, numberOption(args, "--idle-timeout-ms", 30 * 60 * 1_000));
}

function stateDirectory(args: string[]): string {
  return resolve(flagValue(args, "--state-dir") ?? Bun.env.PAIR_PLAN_STATE_DIR ?? defaultStateDir());
}

function portOption(args: string[]): number {
  return Math.max(1, Math.min(65_535, Math.floor(numberOption(args, "--port", Number(Bun.env.PAIR_PLAN_PORT ?? 8765)))));
}

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
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

async function context(args: string[], required = true): Promise<CliContext | null> {
  const input = artifactInput(args, required);
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
    port: portOption(args),
    idleTimeoutMs: idleTimeoutOption(args),
    reopen: hasFlag(args, "--reopen"),
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
  const current = await context(args);
  if (!current) return;
  const url = current.handle.baseUrl;
  if (!hasFlag(args, "--no-open")) openReviewUrl(url);
  output({
    status: current.handle.session.endedAt ? "ended" : "ready",
    artifact: current.artifactPath,
    session_id: current.handle.session.id,
    revision: current.handle.session.artifactRevision,
    url,
    port: current.port,
    ended_at: current.handle.session.endedAt,
  });
}

async function runPoll(args: string[]): Promise<void> {
  const current = await context(args);
  if (!current) return;
  const client = new PairPlanAgentClient(current.handle.baseUrl, current.handle.session.id);
  if (!current.handle.session.endedAt) await client.status("listening");

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
        next_command: `pair-plan complete "${current.artifactPath}" --batch-id ${result.batchId} --summary "<summary>" --revision ${result.revision}`,
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
  const client = new PairPlanAgentClient(current.handle.baseUrl, current.handle.session.id);
  await client.complete(batchId, reply);
  output({ status: "completed", artifact: current.artifactPath, batch_id: batchId, ...reply });
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

async function runEnd(args: string[]): Promise<void> {
  const current = await context(args);
  if (!current) return;
  const client = new PairPlanAgentClient(current.handle.baseUrl, current.handle.session.id);
  await client.end((flagValue(args, "--by") as "agent" | "user" | undefined) ?? "agent");
  output({ status: "ended", artifact: current.artifactPath, session_id: current.handle.session.id });
}

async function runReopen(args: string[]): Promise<void> {
  const current = await context([...args, "--reopen"]);
  if (!current) return;
  output({ status: "ready", artifact: current.artifactPath, session_id: current.handle.session.id, url: current.handle.baseUrl });
}

async function runStop(args: string[]): Promise<void> {
  const input = artifactInput(args);
  if (!input) throw new Error("stop requires an artifact path.");
  const resolved = await resolveCliArtifact(input, flagValue(args, "--root"));
  const stopped = await stopServer(resolved.filePath, stateDirectory(args));
  output({ status: stopped ? "stopped" : "not-running", artifact: resolved.filePath });
}

async function runForegroundServer(args: string[]): Promise<void> {
  const input = artifactInput(args);
  if (!input) throw new Error("server requires an artifact path.");
  const { startPairPlanServer } = await import("./server");
  const runtime = await startPairPlanServer({
    artifactInput: input,
    configuredRoot: flagValue(args, "--root"),
    stateDir: stateDirectory(args),
    port: portOption(args),
    idleTimeoutMs: idleTimeoutOption(args),
    installSignalHandlers: true,
  });
  console.error(`Pair Plan listening at http://127.0.0.1:${runtime.port}`);
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
  if (parsed.command === "status") return runStatus(parsed.args);
  if (parsed.command === "end") return runEnd(parsed.args);
  if (parsed.command === "reopen") return runReopen(parsed.args);
  if (parsed.command === "stop") return runStop(parsed.args);
  if (parsed.command === "server") return runForegroundServer(parsed.args);
  throw new Error(`Unknown command: ${parsed.command}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`pair-plan: ${message}\n`);
  process.exitCode = 1;
});
