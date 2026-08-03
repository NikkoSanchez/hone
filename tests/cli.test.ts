import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  expect(result.stdout).toContain("pair-plan poll <artifact>");
  expect(result.stdout).toContain("pair-plan complete <artifact>");
  expect(result.stdout).toContain("pair-plan stop <artifact>");
  expect(result.stderr).toBe("");
});

test("open and complete point the agent back into the poll loop", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pair-plan-cli-test-"));
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
    expect(openPayload.next_command).toContain("pair-plan poll");
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
    expect(pollPayload.next_command).toContain("pair-plan complete");

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
