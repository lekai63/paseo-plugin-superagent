import assert from "node:assert/strict";
import test, { before } from "node:test";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import * as plugin from "@getpaseo/plugin";
import { defineTranslations } from "@getpaseo/plugin/client";
import * as zod from "zod";

async function compile(entry) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true,
    format: "cjs",
    platform: "neutral",
    target: "es2020",
    jsx: "automatic",
    external: ["react", "react/jsx-runtime", "react-native", "@getpaseo/*", "@tanstack/react-query", "zod"],
    write: false,
  });
  // Match Paseo 0.15's Hermes compatibility pass. A normal esbuild build keeps
  // namespace getters lazy and would hide this native-module loading regression.
  return result.outputFiles[0].text.replaceAll("get: () => from[key]", "value: from[key]");
}

let fontBundle;
let clientBundle;
let webBundle;
let queryBundle;
let requestCardBundle;
before(async () => {
  [fontBundle, clientBundle, webBundle, queryBundle, requestCardBundle] = await Promise.all([
    compile("../client/host-font-scale.ts"),
    compile("../index.client.tsx"),
    compile("../client/web.ts"),
    compile("../client/query.ts"),
    compile("../client/worker-request-card.tsx"),
  ]);
});

function load(code, platform, { turbo = null, legacy = null, storage = null, paseo = null, modules: overrides = {} } = {}) {
  const reads = [];
  const native = { Platform: { OS: platform } };
  Object.defineProperties(native, {
    TurboModuleRegistry: {
      enumerable: true,
      get() { reads.push("TurboModuleRegistry"); return { get: () => typeof turbo === "function" ? turbo() : turbo }; },
    },
    NativeModules: {
      enumerable: true,
      get() { reads.push("NativeModules"); if (typeof legacy === "function") return legacy(); return { RNCAsyncStorage: legacy }; },
    },
    PushNotificationIOS: {
      enumerable: true,
      get() { assert.fail("Loading the plugin must not initialize unrelated native modules"); },
    },
  });
  const modules = {
    react: { useEffect() {}, useSyncExternalStore: (_subscribe, snapshot) => snapshot() },
    "react/jsx-runtime": {},
    "react-native": native,
    "@getpaseo/plugin": plugin,
    // 真实的 defineTranslations:插件加载时按宿主同样的规则校验中英文资源。
    "@getpaseo/plugin/client": {
      usePaseo: () => paseo,
      defineTranslations,
      useTranslation: () => ({ locale: "en", t: (key) => key }),
      useRpc: () => async () => ({ ok: true }),
    },
    "@getpaseo/plugin/client/ui": {},
    "@tanstack/react-query": { useQuery: (options) => options },
    zod,
  };
  for (const [name, value] of Object.entries(overrides)) modules[name] = { ...modules[name], ...value };
  const sandbox = {
    module: { exports: {} },
    require(name) { assert.ok(name in modules, `Unexpected runtime dependency: ${name}`); return modules[name]; },
  };
  Object.defineProperty(sandbox, "localStorage", {
    get() { assert.equal(platform, "web", "Native clients must not access browser storage"); return storage; },
  });
  sandbox.exports = sandbox.module.exports;
  runInNewContext(code, sandbox);
  return { exports: sandbox.module.exports, reads };
}

test("Worker question cards open the native session, while permission cards submit the exact decision", async () => {
  const calls = [];
  const jsx = (_type, props) => props;
  const { exports } = load(requestCardBundle, "ios", { modules: {
    react: { useState: (value) => [value, () => {}] },
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "@getpaseo/plugin/client": { useRpc: (contract) => async (input) => {
      calls.push({ name: contract.name, ...input });
      return { ok: true };
    } },
    "@getpaseo/plugin/client/ui": { useToast: () => ({ error: assert.fail }) },
    "@tanstack/react-query": {
      useQueryClient: () => ({ invalidateQueries: () => {} }),
      useMutation: (options) => ({ mutate: options.mutationFn, isPending: false }),
    },
  } });
  function buttons(kind) {
    const tree = exports.WorkerRequestCard({
      threadId: "thread", ticket: { id: "ticket", title: "Worker task" }, agentId: "worker",
      request: { id: "request", name: kind, kind },
      theme: { colors: {
        surface0: "#ffffff", surface1: "#f8fafc", surface2: "#f1f5f9", border: "#cbd5e1",
        foreground: "#0f172a", foregroundMuted: "#475569", accent: "#2563eb",
      } },
      navigation: { openAgent: (input) => calls.push(input) },
    });
    return Array.from(tree.children.at(-1).children).filter((child) => child?.onPress);
  }
  const [answer] = buttons("question");
  assert.deepEqual(buttons("question").map((button) => button.label), ["Answer in Worker session"]);
  answer.onPress();
  const [allow, deny, open] = buttons("tool");
  assert.equal(open.label, "Open Worker session");
  await allow.onPress();
  await deny.onPress();
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    { agentId: "worker" },
    { name: "superagent.respond_to_permission", threadId: "thread", ticketId: "ticket", agentId: "worker", requestId: "request", behavior: "allow" },
    { name: "superagent.respond_to_permission", threadId: "thread", ticketId: "ticket", agentId: "worker", requestId: "request", behavior: "deny" },
  ]);
});

test("plugin Router status includes background sessions, filters archived sessions, and retains the remembered fallback", async () => {
  const records = [
    { id: "hidden", background: true, labels: { "superagent.role": "router" } },
    { id: "archived", background: true, labels: { "superagent.role": "router" }, archivedAt: "2026-01-01" },
    { id: "worker", background: false, labels: { "superagent.role": "worker" } },
  ];
  const paseo = {
    agents: {
      list: async ({ filter }) => ({
        entries: records
          .filter((agent) => (filter.includeBackground || !agent.background)
            && Object.entries(filter.labels).every(([key, value]) => agent.labels[key] === value))
          .map((agent) => ({ agent })),
      }),
      ref: (id) => ({ refresh: async () => ({ agent: { id, archivedAt: null } }) }),
    },
  };
  const { exports } = load(queryBundle, "web", { paseo });
  const query = exports.useRouterAgents("host", "remembered", true);
  const agents = await query.queryFn();
  assert.deepEqual(Array.from(agents, (agent) => agent.id), ["hidden", "remembered"]);
});

// Exported constants are not read back from the bundle: the Hermes pass above evaluates entry
// exports before module-level constants are initialized. Only functions survive it.

/** useSuperagentState 的运行环境:可选的宿主 useSubscription,记录缓存失效。 */
function stateHook({ subscription = null, cachedRevision = null } = {}) {
  const invalidated = [];
  const subscribed = [];
  let onEvent = null;
  const client = { useRpc: () => async () => ({}) };
  if (subscription) {
    client.useSubscription = (contract, input, handler) => {
      subscribed.push({ name: contract.name, input });
      onEvent = handler;
      return { status: subscription };
    };
  }
  const { exports } = load(queryBundle, "web", {
    modules: {
      react: { useRef: (value) => ({ current: value }), useState: (value) => [value, () => {}] },
      "@tanstack/react-query": {
        useQueryClient: () => ({
          getQueryData: () => (cachedRevision ? { revision: cachedRevision } : undefined),
          invalidateQueries: async (options) => { invalidated.push(options); },
        }),
      },
      "@getpaseo/plugin/client": client,
    },
  });
  // The bundle runs in another realm: compare plain JSON copies of what it hands back.
  const plain = (value) => JSON.parse(JSON.stringify(value));
  return {
    exports, push: (revision) => onEvent({ revision }),
    get invalidated() { return plain(invalidated); },
    get subscribed() { return plain(subscribed); },
  };
}

test("without the 0.16 subscription hook (older app) the state keeps polling every 3 seconds", () => {
  const { exports } = stateHook();
  assert.equal(exports.useSuperagentState("host").refetchInterval, 3000);
});

test("a live state subscription refetches only for a newer revision and slows polling to a fallback", () => {
  const harness = stateHook({ subscription: "live", cachedRevision: "boot.4" });
  const query = harness.exports.useSuperagentState("host", { threadId: "t1" });
  assert.equal(query.refetchInterval, 30_000);
  assert.deepEqual(harness.subscribed, [{ name: "superagent.state_events", input: { attempt: 0 } }]);
  harness.push("boot.4");
  assert.deepEqual(harness.invalidated, [], "the cache already holds that revision");
  harness.push("boot.5");
  assert.deepEqual(harness.invalidated, [{ queryKey: ["superagent", "state", "host", { threadId: "t1" }], exact: true }]);
});

test("a closed or failed state subscription falls back to 3-second polling, and a disabled query ignores pushes", () => {
  for (const status of ["connecting", "closed", "error"]) {
    const harness = stateHook({ subscription: status });
    assert.equal(harness.exports.useSuperagentState("host").refetchInterval, 3000);
  }
  const disabled = stateHook({ subscription: "live" });
  disabled.exports.useSuperagentState("host", {}, false);
  disabled.push("boot.9");
  assert.deepEqual(disabled.invalidated, []);
});

for (const platform of ["ios", "android", "web"]) {
  test(`full plugin loads and registers on ${platform} without initializing unrelated native modules`, () => {
    const { exports, reads } = load(clientBundle, platform);
    const registrations = [];
    const client = Object.fromEntries([
      "addScreen", "addSidebarHeaderItem", "addCommandCenterItem", "addSettingsScreen", "addSlashCommand",
    ].map((name) => [name, (item) => registrations.push([name, item])]));
    assert.equal(typeof exports.default(client), "function");
    assert.ok(registrations.some(([name, item]) => name === "addSidebarHeaderItem" && item.id === "main"));
    assert.deepEqual(reads, [], "Native storage must only be accessed when the font hook is used");
  });
}

const nativeStorage = (values) => ({
  multiGet(keys, callback) { callback(null, keys.map((key) => [key, values[key] ?? null])); },
});
const flush = () => new Promise(setImmediate);

test("iOS reads the current font setting through the native module", async () => {
  const { exports } = load(fontBundle, "ios", {
    turbo: nativeStorage({ "@paseo:app-settings": '{"uiBaseFontSize":18}' }),
  });
  assert.equal(exports.useHostUiFontSize({}), 15);
  await flush();
  assert.equal(exports.useHostUiFontSize({}), 18);
});

test("native clients also follow the content size and width from the same settings", async () => {
  const { exports } = load(fontBundle, "ios", {
    turbo: nativeStorage({ "@paseo:app-settings": '{"uiBaseFontSize":16,"contentFontSize":19,"contentMaxWidth":1000}' }),
  });
  assert.deepEqual({ ...exports.useHostAppearance({}) }, { uiFontSize: 15, contentFontSize: 16, contentMaxWidth: 820 });
  await flush();
  assert.deepEqual({ ...exports.useHostAppearance({}) }, { uiFontSize: 16, contentFontSize: 19, contentMaxWidth: 1000 });
});

test("Android falls back to legacy native storage and the legacy settings key", async () => {
  const { exports } = load(fontBundle, "android", {
    turbo() { throw new Error("TurboModule unavailable"); },
    legacy: nativeStorage({ "@paseo:settings": '{"uiBaseFontSize":17}' }),
  });
  exports.useHostUiFontSize({});
  await flush();
  assert.equal(exports.useHostUiFontSize({}), 17);
});

test("native module lookup failures keep the platform font default", () => {
  const { exports } = load(fontBundle, "ios", {
    turbo() { throw new Error("TurboModule unavailable"); },
    legacy() { throw new Error("Native bridge unavailable"); },
  });
  assert.equal(exports.useHostUiFontSize({}), 15);
});

test("a native storage read failure keeps the platform font default", async () => {
  const { exports } = load(fontBundle, "ios", {
    turbo: { multiGet() { throw new Error("Storage unavailable"); } },
  });
  exports.useHostUiFontSize({});
  await flush();
  assert.equal(exports.useHostUiFontSize({}), 15);
});

test("web reads browser preferences without accessing the native bridge", () => {
  const { exports, reads } = load(fontBundle, "web", {
    storage: { getItem: (key) => key === "@paseo:app-settings" ? '{"uiBaseFontSize":16}' : null },
  });
  assert.equal(exports.useHostUiFontSize({}), 16);
  assert.deepEqual(reads, []);
});

test("web reads content size and width without accessing the native bridge", () => {
  const { exports, reads } = load(fontBundle, "web", {
    storage: { getItem: (key) => key === "@paseo:app-settings" ? '{"contentFontSize":17,"contentMaxWidth":960}' : null },
  });
  assert.deepEqual({ ...exports.useHostAppearance({}) }, { uiFontSize: 14, contentFontSize: 17, contentMaxWidth: 960 });
  assert.deepEqual(reads, []);
});

test("web storage failures keep the default font without accessing native modules", () => {
  const { exports, reads } = load(fontBundle, "web", {
    storage: { getItem() { throw new Error("Storage access denied"); } },
  });
  assert.equal(exports.useHostUiFontSize({}), 14);
  assert.deepEqual(reads, []);
});

test("browser helpers are safe no-ops on native clients", () => {
  const { exports } = load(webBundle, "ios");
  const unexpectedBrowserCall = () => assert.fail("Native clients must not call browser APIs");
  assert.equal(exports.readWebUiFontSize(), null);
  assert.equal(exports.readWebAppearance(), null);
  exports.subscribeWebAppearance(unexpectedBrowserCall)();
  exports.subscribeWebReducedMotion(unexpectedBrowserCall)();
  assert.equal(exports.startWebRotation({ get animate() { unexpectedBrowserCall(); } }), undefined);
  assert.equal(exports.startWebPulse({ get animate() { unexpectedBrowserCall(); } }), undefined);
});
