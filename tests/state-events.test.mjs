import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { SETTINGS_DEFAULTS } from "../shared/settings.ts";

const TABS = { open: [], last: null };

/** 装上真实的插件入口(假宿主),拿到它注册的 RPC 与订阅 handler。 */
async function loadPlugin(t) {
  const home = await mkdtemp(path.join(tmpdir(), "superagent-events-"));
  const previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  const { default: contribute } = await import("../index.server.ts");
  const handlers = new Map();
  const server = {
    registerSettings: () => ({
      read: async () => ({ status: "ready", values: SETTINGS_DEFAULTS }),
      subscribe: () => () => {},
    }),
    handle: (contract, handler) => handlers.set(contract.name, handler),
    before: () => () => {},
    addHook: () => () => {},
    on: () => () => {},
  };
  const cleanup = contribute(server);
  t.after(async () => {
    await cleanup();
    if (previousHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  });
  return handlers;
}

test("state_events pushes the current revision, one revision per change burst, and stops on release", async (t) => {
  const handlers = await loadPlugin(t);
  const subscribe = handlers.get("superagent.state_events");
  const state = handlers.get("superagent.state");
  const saveTabs = handlers.get("superagent.save_chat_tabs");
  assert.equal(typeof subscribe, "function");
  assert.equal(typeof handlers.get("superagent.respond_to_permission"), "function");

  const paseo = {};
  // Let startup (state file load, settings read) settle before anyone listens.
  await saveTabs(TABS, { paseo });
  await sleep(300);
  const controller = new AbortController();
  const pushed = [];
  const result = subscribe({}, { paseo, signal: controller.signal, push: async (event) => { pushed.push(event.revision); } });
  // A handler that returns a promise closes the subscription when it settles.
  assert.equal(result, undefined);
  assert.equal(pushed.length, 1, "the current revision is pushed right away");

  const initial = await state({}, { paseo });
  assert.equal(typeof initial.revision, "string");

  // Two writes in quick succession reach the subscriber as one event.
  await saveTabs(TABS, { paseo });
  await saveTabs(TABS, { paseo });
  await sleep(400);
  assert.equal(pushed.length, 2);
  const after = await state({}, { paseo });
  assert.notEqual(after.revision, initial.revision);
  assert.equal(pushed[1], after.revision, "the pushed revision matches the snapshot the client then reads");

  controller.abort();
  await saveTabs(TABS, { paseo });
  await sleep(400);
  assert.equal(pushed.length, 2, "a released subscriber gets nothing more");
});
