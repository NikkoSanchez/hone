import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

async function runCli(...args: string[]) {
  const child = Bun.spawn([Bun.argv[0]!, join(import.meta.dir, "../src/cli.ts"), ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { exitCode: await child.exited, stdout, stderr };
}

test("prints the agent-facing CLI contract", async () => {
  const result = await runCli("--help");
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("hone poll <artifact>");
  expect(result.stdout).toContain("hone complete <artifact>");
  expect(result.stdout).toContain("hone review <artifact>");
  expect(result.stdout).toContain("hone stop <artifact>");
  expect(result.stdout).toContain("hone stop --all");
  expect(result.stdout).toContain("hone recent [--limit 20]");
  expect(result.stderr).toBe("");
});

test("stop --all stops every daemon in the state directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hone-stop-all-test-"));
  const first = join(directory, "first.html");
  const second = join(directory, "second.html");
  const stateDir = join(directory, "state");
  const firstProbe = Bun.serve({ port: 0, fetch: () => new Response("probe") });
  const firstPort = firstProbe.port!;
  await firstProbe.stop(true);
  const secondProbe = Bun.serve({ port: 0, fetch: () => new Response("probe") });
  const secondPort = secondProbe.port!;
  await secondProbe.stop(true);
  const commonArgs = ["--root", directory, "--state-dir", stateDir, "--idle-timeout-ms", "0"];

  try {
    await writeFile(first, "<main>First</main>", "utf8");
    await writeFile(second, "<main>Second</main>", "utf8");
    const expectedFirst = await realpath(first);
    const expectedSecond = await realpath(second);
    const firstOpen = await runCli(first, "--no-open", "--port", String(firstPort), ...commonArgs);
    const secondOpen = await runCli(second, "--no-open", "--port", String(secondPort), ...commonArgs);
    expect(firstOpen.exitCode).toBe(0);
    expect(secondOpen.exitCode).toBe(0);

    const stopped = await runCli("stop", "--all", "--state-dir", stateDir);
    expect(stopped.exitCode).toBe(0);
    expect(JSON.parse(stopped.stdout.trim())).toEqual({
      status: "stopped",
      count: 2,
      artifacts: [expectedFirst, expectedSecond],
    });

    const status = await runCli("status", "--state-dir", stateDir);
    expect(JSON.parse(status.stdout.trim()).runtimes).toEqual([]);
  } finally {
    await runCli("stop", "--all", "--state-dir", stateDir);
    await rm(directory, { recursive: true, force: true });
  }
});

test("open attaches multiple artifacts and exposes them to the dropdown", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hone-attachments-test-"));
  const first = join(directory, "first.html");
  const second = join(directory, "second.html");
  const patchPath = join(directory, "review.diff");
  const findingsPath = join(directory, "findings.json");
  const stateDir = join(directory, "state");
  const portProbe = Bun.serve({ port: 0, fetch: () => new Response("probe") });
  const port = portProbe.port!;
  await portProbe.stop(true);
  const commonArgs = ["--root", directory, "--state-dir", stateDir, "--port", String(port), "--idle-timeout-ms", "0"];

  try {
    await writeFile(first, "<main>First</main>", "utf8");
    await writeFile(second, "<main>Second</main>", "utf8");
    const opened = await runCli(first, second, "--no-open", ...commonArgs);
    expect(opened.exitCode).toBe(0);
    const payload = JSON.parse(opened.stdout.trim()) as { url: string; artifacts: Array<{ url: string; review_url: string }> };
    expect(payload.artifacts).toHaveLength(2);
    expect(payload.artifacts.map((artifact) => artifact.url)).toEqual([payload.url, payload.url]);
    expect(payload.artifacts.every((artifact) => artifact.review_url.includes("?artifact="))).toBe(true);
    const artifactsResponse = await fetch(`${payload.url}/api/artifacts`);
    const artifactsPayload = await artifactsResponse.json() as { artifacts: Array<{ name: string }> };
    expect(artifactsPayload.artifacts.map((artifact) => artifact.name).sort()).toEqual(["first.html", "second.html"]);

    await writeFile(patchPath, "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n", "utf8");
    await writeFile(findingsPath, JSON.stringify([{ file: "a.ts", line: 1, severity: "warning", title: "Check behavior", body: "Confirm this change." }]), "utf8");
    const reviewed = await runCli("review", first, "--patch-file", patchPath, "--findings-file", findingsPath, "--no-open", ...commonArgs);
    expect(reviewed.exitCode).toBe(0);
    const reviewPayload = JSON.parse(reviewed.stdout.trim()) as { external_posted: boolean; findings: number };
    expect(reviewPayload.external_posted).toBe(false);
    expect(reviewPayload.findings).toBe(1);
    const sessionResponse = await fetch(`${payload.url}/api/session`);
    const sessionPayload = await sessionResponse.json() as { review?: { findings: unknown[] } };
    expect(sessionPayload.review?.findings).toHaveLength(1);

    const endResponse = await fetch(`${payload.url}/api/session/${payload.artifacts[0]!.review_url.split("artifact=")[1]}/end`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ by: "user" }),
    });
    expect(endResponse.ok).toBe(true);
    const endPayload = await endResponse.json() as { snapshot: { endedAt?: string; endedBy?: string; agentStatus: string } };
    expect(endPayload.snapshot.endedAt).toBeDefined();
    expect(endPayload.snapshot.endedBy).toBe("user");
    expect(endPayload.snapshot.agentStatus).toBe("offline");

    const stoppedFirst = await runCli("stop", first, "--state-dir", stateDir);
    expect(JSON.parse(stoppedFirst.stdout.trim()).status).toBe("stopped");
    const secondSession = await fetch(`${payload.url}/api/session/${payload.artifacts[1]!.review_url.split("artifact=")[1]}`);
    expect(secondSession.ok).toBe(true);
  } finally {
    await runCli("stop", "--all", "--state-dir", stateDir);
    await rm(directory, { recursive: true, force: true });
  }
});

test("recent lists known artifacts as date-and-path lines", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hone-recent-test-"));
  const artifactPath = join(directory, "recent-plan.html");
  const stateDir = join(directory, "state");

  try {
    await writeFile(artifactPath, "<main>Recent plan</main>", "utf8");
    await mkdir(stateDir);
    await writeFile(join(stateDir, "recent-session.json"), JSON.stringify({
      id: "recent-session",
      filePath: artifactPath,
      rootPath: directory,
      updatedAt: "2026-08-08T12:00:00.000Z",
      endedAt: "2026-08-08T12:05:00.000Z",
    }), "utf8");

    const result = await runCli("recent", "--state-dir", stateDir, "--limit", "1");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d{4}-\d{2}-\d{2}  .+recent-plan\.html$/);
    expect(result.stdout.trim()).toContain(artifactPath);
    expect(result.stderr).toBe("");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("open and complete point the agent back into the poll loop", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hone-cli-test-"));
  const artifactPath = join(directory, "plan's review.html");
  const stateDir = join(directory, "state");
  const portProbe = Bun.serve({ port: 0, fetch: () => new Response("probe") });
  const port = portProbe.port!;
  await portProbe.stop(true);
  const commonArgs = ["--root", directory, "--state-dir", stateDir, "--port", String(port), "--idle-timeout-ms", "0"];

  try {
    await writeFile(artifactPath, "<main data-anchor=\"plan\">Plan</main>", "utf8");
    const opened = await runCli(artifactPath, "--no-open", ...commonArgs);
    expect(opened.exitCode).toBe(0);
    const openPayload = JSON.parse(opened.stdout.trim()) as Record<string, unknown>;
    expect(openPayload.next_command).toContain("hone poll");
    expect(openPayload.next_command).toContain("plan'\"'\"'s review.html");

    const feedbackResponse = await fetch(`${String(openPayload.url)}/api/session/${String(openPayload.session_id)}/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: { anchor: "plan" }, body: "Tighten the plan." }),
    });
    expect(feedbackResponse.ok).toBe(true);

    const polled = await runCli("poll", artifactPath, ...commonArgs);
    expect(polled.exitCode).toBe(0);
    const pollPayload = JSON.parse(polled.stdout.trim()) as Record<string, unknown>;
    expect(pollPayload.next_command).toContain("hone complete");

    const completed = await runCli(
      "complete",
      artifactPath,
      ...commonArgs,
      "--batch-id",
      String(pollPayload.batchId),
      "--summary",
      "Updated the plan.",
    );
    expect(completed.exitCode).toBe(0);
    const completePayload = JSON.parse(completed.stdout.trim()) as Record<string, unknown>;
    expect(completePayload.next_command).toBe(openPayload.next_command);
  } finally {
    await runCli("stop", artifactPath, "--state-dir", stateDir);
    await rm(directory, { recursive: true, force: true });
  }
});
