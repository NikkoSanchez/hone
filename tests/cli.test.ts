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
