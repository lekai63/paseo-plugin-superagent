import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SuperagentStore } from "../server/store.ts";
import { emptyState, SuperagentStateSchema } from "../shared/model.ts";

test("old state defaults to an empty outbox", () => {
  const legacy = emptyState();
  delete legacy.imDeliveries;
  assert.deepEqual(SuperagentStateSchema.parse(legacy).imDeliveries, []);
});

test("failed delivery progress survives a real store reload and closed-thread history trimming", async () => {
  const home = await mkdtemp(join(tmpdir(), "superagent-im-store-"));
  const original = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  try {
    const store = new SuperagentStore();
    await store.ready;
    await store.update((state) => {
      for (let i = 0; i < 45; i++) state.threads.push({
        id: `thread-${i}`, key: `manual:${i}`, title: `task ${i}`, state: "closed", createdAt: "2020-01-01",
        updatedAt: `2026-01-01T00:00:${String(i).padStart(2, "0")}Z`,
      });
      state.imDeliveries.push({
        id: "failed", threadId: "thread-0", origin: { channel: "qq", chatId: "g:1", senderId: "user" },
        parts: ["[1/2] one", "[2/2] two"], nextPart: 1, status: "failed", createdAt: "2020-01-01", updatedAt: "2020-01-01",
      });
    });
    const restored = new SuperagentStore();
    await restored.ready;
    assert.equal(restored.get().imDeliveries[0].nextPart, 1);
    assert.equal(restored.get().imDeliveries[0].status, "failed");
    assert.ok(restored.get().threads.some((thread) => thread.id === "thread-0"));
    assert.equal(restored.get().threads.length, 41);
  } finally {
    if (original === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = original;
    await rm(home, { recursive: true, force: true });
  }
});

test("a failed durable write rejects the operation and a later write can recover", async () => {
  const home = await mkdtemp(join(tmpdir(), "superagent-im-write-"));
  const original = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  try {
    const store = new SuperagentStore();
    await store.ready;
    await writeFile(join(home, "plugin-data"), "blocks directory creation");
    await assert.rejects(store.update((state) => { state.kv.routerProvider = "saved-after-recovery"; }));
    await rm(join(home, "plugin-data"));
    await mkdir(join(home, "plugin-data"));
    await store.update(() => {});
    const restored = new SuperagentStore();
    await restored.ready;
    assert.equal(restored.get().kv.routerProvider, "saved-after-recovery");
  } finally {
    if (original === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = original;
    await rm(home, { recursive: true, force: true });
  }
});
