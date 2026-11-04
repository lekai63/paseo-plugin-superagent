import assert from "node:assert/strict";
import test, { before } from "node:test";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import * as plugin from "@getpaseo/plugin";
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
before(async () => {
  [fontBundle, clientBundle, webBundle] = await Promise.all([
    compile("../client/host-font-scale.ts"),
    compile("../index.client.tsx"),
    compile("../client/web.ts"),
  ]);
});

function load(code, platform, { turbo = null, legacy = null, storage = null } = {}) {
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
    "@getpaseo/plugin/client": {},
    "@getpaseo/plugin/client/ui": {},
    "@tanstack/react-query": {},
    zod,
  };
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
  exports.subscribeWebAppearance(unexpectedBrowserCall)();
  exports.subscribeWebReducedMotion(unexpectedBrowserCall)();
  assert.equal(exports.startWebRotation({ get animate() { unexpectedBrowserCall(); } }), undefined);
});
