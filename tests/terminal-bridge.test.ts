import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { SessionStore } from "../src/session-store";
import type { TerminalAgentAdapter } from "../src/terminal-bridge/adapters";
import { appendBoundedTranscript, decodeTerminalOutputFrame, encodeTerminalOutputFrame, formatFeedbackEnvelope } from "../src/terminal-bridge/protocol";
import { TerminalSupervisor } from "../src/terminal-bridge/server/supervisor";

async function eventually(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(20);
  }
  throw new Error("Condition was not met before the test timeout.");
}

describe("terminal bridge protocol", () => {
  test("formats one atomic, anchored feedback frame", () => {
    const message = formatFeedbackEnvelope({
      sessionId: "session-1",
      file: "/tmp/artifact.html",
      revision: 4,
      batchId: "batch-1",
      prompts: [{
        id: "feedback-1",
        createdAt: "2026-08-29T00:00:00.000Z",
        target: { anchor: "hero", quote: "Review in Hone" },
        body: "Tighten the promise.",
      }],
    });
    expect(message).toStartWith("[HONE FEEDBACK]\n");
    expect(message).toContain("batch: batch-1");
    expect(message).toContain("1. anchor: hero");
    expect(message).toContain('quote: "Review in Hone"');
    expect(message).toEndWith("[/HONE FEEDBACK]");
  });

  test("retains only the bounded transcript tail", () => {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const result = appendBoundedTranscript(encoder.encode("12345"), encoder.encode("67890"), 7);
    expect(decoder.decode(result)).toBe("4567890");
  });

  test("frames binary PTY output with a reconnect sequence", () => {
    const encoded = encodeTerminalOutputFrame(42, new TextEncoder().encode("hello"));
    const decoded = decodeTerminalOutputFrame(encoded);
    expect(decoded?.sequence).toBe(42);
    expect(new TextDecoder().decode(decoded?.data)).toBe("hello");
  });
});

describe("terminal supervisor", () => {
  test("launches a PTY, submits durable feedback, and completes it on readiness", async () => {
    if (process.platform === "win32") return;
    const directory = await mkdtemp(join(tmpdir(), "hone-terminal-test-"));
    const artifactPath = join(directory, "artifact.html");
    await writeFile(artifactPath, '<main data-anchor="hero">Hello</main>', "utf8");
    const store = await SessionStore.open({ id: "terminal-test", filePath: artifactPath, rootPath: directory, stateDir: join(directory, "state") });
    const decoder = new TextDecoder();
    const adapter: TerminalAgentAdapter = {
      id: "test-shell",
      label: "Test shell",
      executable: "sh",
      command: () => ["sh"],
      environment: () => ({ PS1: "HONE_READY> " }),
      async submit(terminal) {
        terminal.write("printf 'APPLIED\\nHONE_READY> '");
        terminal.write("\n");
      },
      observe(chunk) {
        return decoder.decode(chunk).includes("HONE_READY>") ? "ready" : "output";
      },
      canAcceptInput: (status) => status === "ready" || status === "working",
    };
    const supervisor = new TerminalSupervisor({ store, adapter, enabled: true });

    try {
      await supervisor.initialize(true);
      await eventually(() => supervisor.snapshot.status === "ready");
      await store.enqueue([{ target: { anchor: "hero" }, body: "Update the greeting." }]);
      await supervisor.submitPending();
      await eventually(() => store.snapshot.queue.length === 0 && store.snapshot.deliveryBatchId === null);
      expect(supervisor.snapshot.transcriptTail).toContain("APPLIED");
      expect(store.snapshot.history.some((message) => message.role === "agent")).toBe(true);
      await supervisor.stop();
      expect(supervisor.snapshot.status).toBe("offline");
    } finally {
      await supervisor.dispose();
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
