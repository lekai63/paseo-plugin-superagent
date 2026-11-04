import assert from "node:assert/strict";
import test from "node:test";
import { ensureSharedWorkspace } from "../server/workspace.ts";
import { DEFAULT_WORKSPACE_TITLE } from "../shared/settings.ts";

/**
 * 伪 daemon:工作区按 id 保存 descriptor(与真 daemon 一致:name 是已解析标题,
 * workspaceDirectory 是工作区目录),list 只返回活跃工作区。
 */
function fakePaseo() {
  const records = new Map();
  const createCalls = [];
  let next = 0;
  const handle = (id) => ({
    id,
    get directory() {
      return records.get(id)?.workspaceDirectory ?? null;
    },
    current: () => records.get(id) ?? null,
    refresh: async () => records.get(id) ?? null,
    archive: async () => {
      records.delete(id);
      return { workspaceId: id, archivedAt: new Date().toISOString() };
    },
  });
  return {
    records,
    createCalls,
    workspaces: {
      create: async (options) => {
        createCalls.push(options);
        const id = `wks-${++next}`;
        records.set(id, {
          id,
          name: options.title ?? null,
          workspaceDirectory: options.source.path,
          archivingAt: null,
        });
        return handle(id);
      },
      list: async () => ({ entries: [...records.values()], pageInfo: { hasMore: false, nextCursor: null, prevCursor: null } }),
      ref: (id) => handle(id),
    },
  };
}

test("creates the 默认 workspace once and reuses the remembered id afterwards", async () => {
  const paseo = fakePaseo();
  const first = await ensureSharedWorkspace(paseo, null, "/repo", DEFAULT_WORKSPACE_TITLE);
  assert.equal(paseo.createCalls.length, 1);
  assert.deepEqual(paseo.createCalls[0].source, { kind: "directory", path: "/repo" });
  assert.equal(paseo.createCalls[0].title, DEFAULT_WORKSPACE_TITLE);

  const second = await ensureSharedWorkspace(paseo, first.handle.id, "/repo", DEFAULT_WORKSPACE_TITLE);
  assert.equal(paseo.createCalls.length, 1, "the remembered workspace is reused, not recreated");
  assert.equal(second.handle.id, first.handle.id);
  assert.equal(second.remembered, true);
});

test("a remembered id that no longer matches (archived or moved) is recovered by title and directory", async () => {
  const paseo = fakePaseo();
  const created = await ensureSharedWorkspace(paseo, null, "/repo", DEFAULT_WORKSPACE_TITLE);
  await created.handle.archive();
  // 死 id 之外,活跃列表里已有同标题同目录的工作区(例如插件重装前的旧工作区):按标题找回,不再新建。
  const preexisting = await paseo.workspaces.create({
    title: DEFAULT_WORKSPACE_TITLE,
    source: { kind: "directory", path: "/repo" },
  });
  const found = await ensureSharedWorkspace(paseo, created.handle.id, "/repo", DEFAULT_WORKSPACE_TITLE);
  assert.equal(paseo.createCalls.length, 2, "no third workspace is created");
  assert.equal(found.handle.id, preexisting.id);
  assert.equal(found.remembered, false);
});

test("a same-titled workspace on another directory is never adopted", async () => {
  const paseo = fakePaseo();
  await paseo.workspaces.create({ title: DEFAULT_WORKSPACE_TITLE, source: { kind: "directory", path: "/elsewhere" } });
  const result = await ensureSharedWorkspace(paseo, null, "/repo", DEFAULT_WORKSPACE_TITLE);
  assert.equal(paseo.createCalls.length, 2, "the foreign-directory workspace is skipped");
  assert.equal(result.handle.directory, "/repo");
});

test("a remembered id pointing at a different directory is ignored", async () => {
  const paseo = fakePaseo();
  const elsewhere = await paseo.workspaces.create({ title: "irrelevant", source: { kind: "directory", path: "/elsewhere" } });
  const result = await ensureSharedWorkspace(paseo, elsewhere.id, "/repo", DEFAULT_WORKSPACE_TITLE);
  assert.equal(result.handle.directory, "/repo", "the mismatched workspace is not reused");
  assert.equal(paseo.createCalls.length, 2);
});
