import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { SessionStore } from "../src/session-store";
import { isFeedbackEnded, isFeedbackEnvelope } from "../src/types";

async function createStore() {
  const directory = await mkdtemp(join(tmpdir(), "hone-test-"));
  const artifactPath = join(directory, "plan.html");
  await writeFile(artifactPath, "<main><h1>Plan</h1></main>", "utf8");
  const store = await SessionStore.open({
    id: "test-session",
    filePath: artifactPath,
    rootPath: directory,
    stateDir: join(directory, "state"),
  });
  return { directory, artifactPath, store };
}

describe("SessionStore", () => {
  test("derives agent presence from the feedback poll lifecycle", async () => {
    const { directory, store } = await createStore();
    try {
      expect(store.snapshot.agentStatus).toBe("offline");

      const poll = store.waitForFeedback(2_000);
      await Bun.sleep(10);
      expect(store.snapshot.agentStatus).toBe("listening");

      await store.enqueue([{ target: { anchor: "presence" }, body: "Keep presence honest." }]);
      const envelope = await poll;
      if (!isFeedbackEnvelope(envelope)) throw new Error("Expected a feedback envelope.");
      expect(store.snapshot.agentStatus).toBe("working");

      await store.complete(envelope.batchId, { summary: "Presence now follows the active poll." });
      expect(store.snapshot.agentStatus).toBe("offline");
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("marks the agent offline after polling stops", async () => {
    const { directory, store } = await createStore();
    try {
      expect(await store.waitForFeedback(10)).toBeNull();
      expect(store.snapshot.agentStatus).toBe("listening");
      await Bun.sleep(550);
      expect(store.snapshot.agentStatus).toBe("offline");
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("replaces a queued item with the same queue key", async () => {
    const { directory, store } = await createStore();
    try {
      await store.enqueue([
        { target: { anchor: "runtime" }, body: "first", queueKey: "runtime" },
        { target: { anchor: "runtime" }, body: "second", queueKey: "runtime" },
      ]);
      expect(store.snapshot.queue).toHaveLength(1);
      expect(store.snapshot.queue[0]?.body).toBe("second");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("keeps a delivery stable until acknowledgement", async () => {
    const { directory, store } = await createStore();
    try {
      await store.enqueue([{ target: { anchor: "north-star" }, body: "Keep the shell stable." }]);
      const first = await store.waitForFeedback(100);
      const second = await store.waitForFeedback(100);
      expect(isFeedbackEnvelope(first)).toBe(true);
      expect(isFeedbackEnvelope(second)).toBe(true);
      if (!isFeedbackEnvelope(first) || !isFeedbackEnvelope(second)) throw new Error("Expected feedback envelopes.");
      expect(second.batchId).toBe(first.batchId);
      await store.acknowledge(first.batchId);
      expect(store.snapshot.queue).toHaveLength(0);
      expect(store.snapshot.deliveryBatchId).toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("increments the artifact revision when the file changes", async () => {
    const { directory, artifactPath, store } = await createStore();
    try {
      const initialRevision = store.snapshot.artifactRevision;
      await writeFile(artifactPath, "<main><h1>Updated plan</h1></main>", "utf8");
      expect(await store.refreshArtifact()).toBe(true);
      expect(store.snapshot.artifactRevision).toBe(initialRevision + 1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("completes a delivery atomically and records both sides of the exchange", async () => {
    const { directory, store } = await createStore();
    try {
      await store.enqueue([{ target: { anchor: "commands" }, body: "Make the command ergonomic." }]);
      const envelope = await store.waitForFeedback(100);
      if (!isFeedbackEnvelope(envelope)) throw new Error("Expected a feedback envelope.");

      const message = await store.complete(envelope.batchId, {
        revision: 2,
        changedAnchors: ["commands"],
        summary: "Added a concise command surface.",
      });

      expect(message.role).toBe("agent");
      expect(store.snapshot.queue).toHaveLength(0);
      expect(store.snapshot.deliveryBatchId).toBeNull();
      expect(store.snapshot.artifactRevision).toBe(2);
      expect(store.snapshot.history.map((item) => item.role)).toEqual(["agent", "user"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("returns a terminal poll result after a session ends", async () => {
    const { directory, store } = await createStore();
    try {
      await store.end("agent");
      const result = await store.waitForFeedback(100);
      expect(isFeedbackEnded(result)).toBe(true);
      if (!isFeedbackEnded(result)) throw new Error("Expected an ended poll result.");
      expect(result.endedBy).toBe("agent");
      expect(store.snapshot.endedAt).toBeDefined();
      await store.reopen();
      expect(store.snapshot.endedAt).toBeUndefined();
      expect(store.snapshot.agentStatus).toBe("offline");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("ends after a final feedback delivery completes", async () => {
    const { directory, store } = await createStore();
    try {
      await store.enqueue([{ target: { anchor: "final" }, body: "Apply this final change." }]);
      await store.requestEndAfterDelivery("user");
      const envelope = await store.waitForFeedback(100);
      if (!isFeedbackEnvelope(envelope)) throw new Error("Expected a feedback envelope.");

      expect(store.snapshot.endedAt).toBeUndefined();
      expect(store.snapshot.endsAfterDelivery).toBe(true);
      await store.complete(envelope.batchId, { summary: "Applied the final change." });
      expect(store.snapshot.endedAt).toBeDefined();
      expect(store.snapshot.endedBy).toBe("user");
      expect(store.snapshot.endsAfterDelivery).toBeUndefined();
      expect(store.snapshot.agentStatus).toBe("offline");
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("stores an imported code review without publishing it externally", async () => {
    const { directory, store } = await createStore();
    try {
      const review = await store.setReview({
        patch: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
        source: "test agent",
        findings: [{ file: "a.ts", line: 1, severity: "warning", title: "Check behavior", body: "Confirm this change is intentional." }],
      });
      expect(review.findings).toHaveLength(1);
      expect(store.snapshot.review?.source).toBe("test agent");
      expect(store.snapshot.review?.findings[0]?.severity).toBe("warning");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
