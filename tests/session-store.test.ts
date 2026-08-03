import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { SessionStore } from "../src/session-store";

async function createStore() {
  const directory = await mkdtemp(join(tmpdir(), "pair-plan-test-"));
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
      expect(first?.batchId).toBeDefined();
      expect(second?.batchId).toBe(first?.batchId);
      await store.acknowledge(first!.batchId);
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
});
