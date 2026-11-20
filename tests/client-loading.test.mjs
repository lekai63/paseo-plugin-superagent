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
let chatMessagesBundle;
before(async () => {
  [fontBundle, clientBundle, webBundle, queryBundle, requestCardBundle, chatMessagesBundle] = await Promise.all([
    compile("../client/host-font-scale.ts"),
    compile("../index.client.tsx"),
    compile("../client/web.ts"),
    compile("../client/query.ts"),
    compile("../client/worker-request-card.tsx"),
    compile("../client/chat-messages.tsx"),
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

test("Worker cards submit answers and permission decisions and can open the native session", async () => {
  const calls = [];
  const pendingRequests = [{ id: "request" }, { id: "other-request" }];
  let snapshot = { tickets: [{ id: "ticket", workerAgentId: "worker", pendingRequests }] };
  let questionDraft;
  const jsx = (component, props) => ({ ...props, component });
  const { exports } = load(requestCardBundle, "ios", { modules: {
    react: { useState: (value) => typeof value === "object" && value && "active" in value
      ? [questionDraft ?? value, (update) => { questionDraft = update(questionDraft ?? value); }]
      : [value, () => {}] },
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "@getpaseo/plugin/client": { useRpc: (contract) => async (input) => {
      calls.push({ name: contract.name, ...input });
      return { ok: true };
    } },
    "@getpaseo/plugin/client/ui": { useToast: () => ({ error: assert.fail }) },
    "@tanstack/react-query": {
      useQueryClient: () => ({
        cancelQueries: async () => {}, invalidateQueries: () => {},
        setQueriesData: (_key, update) => { snapshot = update(snapshot); },
      }),
      useMutation: (options) => ({ isPending: false, mutate: async (input) => {
        await options.mutationFn(input);
        await options.onSuccess(undefined, input);
      } }),
    },
  } });
  function card(kind, input) {
    return exports.WorkerRequestCard({
      hostId: "host", threadId: "thread", ticket: { id: "ticket", title: "Worker task" }, agentId: "worker",
      request: { id: "request", name: kind, kind, input },
      theme: { colors: {
        surface0: "#ffffff", surface1: "#f8fafc", surface2: "#f1f5f9", border: "#cbd5e1",
        foreground: "#0f172a", foregroundMuted: "#475569", accent: "#2563eb",
      } },
      navigation: { openAgent: (input) => calls.push(input) },
    });
  }
  const buttons = (tree) => Array.from(tree.children.at(-1).children).filter((child) => child?.onPress);
  const question = card("question", { questions: [{ header: "color", question: "Which color?", options: [{ label: "Blue" }] }] });
  const [openQuestion] = buttons(question);
  assert.equal(openQuestion.label, "Answer in Worker session");
  openQuestion.onPress();
  const answers = [{ header: "color", selections: ["Blue"], text: "" }];
  const fields = question.children[1];
  assert.equal(fields.questions[0].question, "Which color?");
  const firstForm = fields.component(fields);
  assert.equal(firstForm.children.at(-1).children.at(-1).disabled, true);
  const singleQuestion = firstForm.children[0];
  const choice = singleQuestion.children.flat().find((child) => child?.accessibilityRole === "radio");
  choice.onPress();
  const secondForm = fields.component(fields);
  const submit = secondForm.children.at(-1).children.at(-1);
  assert.equal(submit.disabled, false);
  await submit.onPress();
  assert.deepEqual(Array.from(snapshot.tickets[0].pendingRequests), [pendingRequests[1]]);
  const [allow, deny, open] = buttons(card("tool"));
  assert.equal(open.label, "Open Worker session");
  await allow.onPress();
  await deny.onPress();
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    { agentId: "worker" },
    { name: "superagent.respond_to_permission", threadId: "thread", ticketId: "ticket", agentId: "worker", requestId: "request", behavior: "answer", answers },
    { name: "superagent.respond_to_permission", threadId: "thread", ticketId: "ticket", agentId: "worker", requestId: "request", behavior: "allow" },
    { name: "superagent.respond_to_permission", threadId: "thread", ticketId: "ticket", agentId: "worker", requestId: "request", behavior: "deny" },
  ]);
});

test("pending questions stay outside the Router's scrollable transcript and disappear when resolved", () => {
  const jsx = (type, props) => ({ type, props });
  const { exports } = load(chatMessagesBundle, "ios", { modules: {
    react: {
      useMemo: (compute) => compute(), useRef: (current) => ({ current }), useState: (value) => [value, () => {}],
    },
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "@getpaseo/plugin/client/ui": { ScrollView: "ScrollView" },
  } });
  const question = { id: "q1", kind: "question", name: "Pi select", input: { questions: [{ question: "Which color?" }] } };
  const permission = { id: "p1", kind: "tool", name: "shell" };
  const render = (pendingRequests) => exports.ChatMessages({
    hostId: "host", threadId: "thread", entries: [],
    tickets: [{ id: "ticket", workerAgentId: "worker", status: "running", pendingRequests }],
    theme: { colors: { border: "#ccc" } }, metrics: { compact: true, maxWidth: 820 },
  }).props.children;

  const [transcript, questions] = render([question, permission]);
  const [permissionRow] = transcript.props.children.props.children.at(-1);
  assert.equal(permissionRow.props.children.props.request, permission);
  assert.equal(questions.props.testID, "worker-questions");
  const [questionCard] = questions.props.children.props.children;
  assert.equal(questionCard.props.request, question);
  assert.equal(questionCard.props.agentId, "worker");
  assert.equal(render([permission])[1], null);
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
