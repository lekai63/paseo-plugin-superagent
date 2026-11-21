import assert from "node:assert/strict";
import test, { before } from "node:test";
import { defineTranslations } from "@getpaseo/plugin/client";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import * as plugin from "@getpaseo/plugin";
import * as zod from "zod";
import { superagentSettings } from "../shared/settings.ts";

let bundle;
before(async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("../client/settings-screen.tsx", import.meta.url))],
    bundle: true, format: "cjs", platform: "neutral", target: "es2020", jsx: "automatic",
    external: ["react", "react/jsx-runtime", "react-native", "@getpaseo/*", "@tanstack/react-query", "zod"],
    write: false,
  });
  bundle = result.outputFiles[0].text;
});

const entries = [
  { provider: "codex", status: "ready", models: [{ id: "gpt", label: "GPT" }], modes: [{ id: "full-access", label: "Full Access" }] },
  { provider: "custom-acp", status: "ready", models: [{ id: "m", label: "M" }, { id: "n", label: "N" }], modes: [{ id: "ask", label: "Ask" }, { id: "agent", label: "Agent" }] },
  { provider: "pi", status: "ready", models: [{ id: "sonnet", label: "Sonnet" }], modes: [] },
];

// Render the real settings draft and callbacks with host UI components as leaves.
function fixture({ query = { data: entries }, modeId = "", piModes = { data: { available: false, modes: [], defaultModeId: null } },
  values = null, listModels = async () => ({ models: [] }) } = {}) {
  const saved = [];
  const slots = [];
  let cursor = 0;
  let queryOptions;
  const settings = {
    status: "ready", revision: 7, saving: false,
    values: superagentSettings.schema.parse(values ?? {
      workerProvider: "codex/gpt", workerModeId: "full-access",
      workerProfiles: [{ name: "research", provider: "custom-acp/m", modeId, description: "research" }],
    }),
    save: async (values, revision) => { saved.push({ values, revision }); },
  };
  const useState = (initial) => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
    return [slots[index], (value) => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
  };
  const jsx = (type, props) => ({ type, props });
  const modules = {
    react: { useState, useEffect() {}, useCallback: (fn) => fn, useMemo: (fn) => fn(), useRef: (value) => useState({ current: value })[0] },
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    "react-native": { View: "View", Text: "Text", Pressable: "Pressable" },
    "@getpaseo/plugin": plugin,
    "@getpaseo/plugin/client": {
      defineTranslations,
      useTranslation: () => ({ locale: "zh-CN", t: (key) => key }),
      useSettings: () => settings,
      usePaseo: () => ({ providers: { snapshot: async () => ({ entries: [], compactSnapshot: { entries } }) } }),
      useRpc: (contract) => contract.name === "superagent.inference_models" ? listModels : async () => piModes.data,
    },
    "@getpaseo/plugin/client/ui": Object.fromEntries([
      "SettingsAction", "SettingsCard", "SettingsInput", "SettingsSection", "SettingsSelect", "SettingsSwitch", "TextInput", "Icon", "ScrollView",
    ].map((name) => [name, name])),
    "@tanstack/react-query": {
      useQueryClient: () => ({ getQueryData() {} }),
      useQuery: (options) => {
        if (options.queryKey?.[1] === "pi-modes") return piModes;
        queryOptions = options;
        return query;
      },
    },
    zod,
  };
  const sandbox = { module: { exports: {} }, require: (name) => { assert.ok(name in modules, name); return modules[name]; } };
  sandbox.exports = sandbox.module.exports;
  runInNewContext(bundle, sandbox);
  function render() {
    cursor = 0;
    const leaves = [];
    function visit(node) {
      if (Array.isArray(node)) { node.forEach(visit); return; }
      if (!node || typeof node !== "object") return;
      if (typeof node.type === "function") { visit(node.type(node.props)); return; }
      leaves.push(node);
      visit(node.props?.children);
    }
    visit(sandbox.module.exports.SuperagentModelSettingsScreen({ host: { id: "host" }, theme: { colors: {} } }));
    return leaves;
  }
  const field = (label, type = "SettingsSelect") => {
    const node = render().find((node) => node.type === type && node.props.label === label);
    assert.ok(node, `${type}: ${label}`);
    return node.props;
  };
  return { field, render, saved, queryFn: () => queryOptions.queryFn() };
}

test("mode options use each provider's own catalog, including compact host snapshots", async () => {
  const f = fixture();
  assert.deepEqual(Array.from(f.field("模式(可选)").options, (option) => option.value), ["", "ask", "agent"]);
  assert.deepEqual(Array.from(f.field("Worker 模式(可选)").options, (option) => option.value), ["", "full-access"]);
  const compact = await f.queryFn();
  assert.equal(compact[1].modes[1].id, "agent");
});

test("Router model and reasoning effort share a row and changing either inference target clears the effort", async () => {
  const f = fixture({
    values: { inferenceBaseUrl: "https://inference.example/v1", routerModel: "model-a", routerReasoningEffort: "high" },
  });
  const modelRow = f.render().find((node) => node.props.testID === "superagent-router-model-fields");
  assert.ok(modelRow);
  assert.equal(modelRow.props.style.flexDirection, "row");
  assert.deepEqual(Array.from(modelRow.props.children, (column) => column.props.children[0].props.children), ["Router 模型", "思考强度"]);
  const input = (label) => f.render().find((node) => node.type === "TextInput" && node.props.accessibilityLabel === label).props;
  assert.equal(input("思考强度").value, "high");
  input("Router 模型").onChangeText("model-b");
  assert.equal(input("思考强度").value, "");
  input("思考强度").onChangeText("provider-specific");
  f.field("推理 API 基础地址", "SettingsInput").onChangeText("https://other.example/v1");
  assert.equal(input("思考强度").value, "");
  input("思考强度").onChangeText("provider-specific");
  await f.render().find((node) => node.type === "SettingsAction" && node.props.actionLabel === "保存").props.onPress();
  assert.equal(f.saved[0].values.routerModel, "model-b");
  assert.equal(f.saved[0].values.routerReasoningEffort, "provider-specific");
});

test("the Router selects endpoint models by prefix and offers the selected model's advertised effort", async () => {
  const requests = [];
  const f = fixture({
    values: { inferenceBaseUrl: "https://inference.example/v1", inferenceApiKey: "test-key", routerModel: "other" },
    listModels: async (input) => {
      requests.push(input);
      return { models: [{ id: "deepseek-flash", effort: { supported_levels: ["low", "high"], default_level: "high" } },
        { id: "other" }, { id: "ultra-deepseek" }] };
    },
  });
  const byLabel = (label) => f.render().find((node) => node.props.accessibilityLabel === label).props;
  const option = (label) => f.render().find((node) => node.type === "Pressable" && node.props.children?.props?.children === label);
  assert.equal(requests.length, 0);
  byLabel("浏览Router 模型选项").onPress();
  await new Promise(setImmediate);
  assert.equal(requests[0].baseUrl, "https://inference.example/v1");
  assert.equal(requests[0].apiKey, "test-key");
  byLabel("按前缀搜索").onChangeText("DEEP");
  assert.ok(option("deepseek-flash"));
  assert.equal(option("ultra-deepseek"), undefined);
  byLabel("按前缀搜索").onSubmitEditing();
  assert.equal(byLabel("Router 模型").value, "deepseek-flash");
  byLabel("浏览思考强度选项").onPress();
  byLabel("按前缀搜索").onChangeText("LO");
  assert.ok(option("low"));
  assert.equal(option("high"), undefined);
  option("low").props.onPress();
  assert.equal(byLabel("思考强度").value, "low");
  assert.equal(requests.length, 1, "the model and effort pickers share the same catalog");
  byLabel("Router 模型").onChangeText("other");
  assert.ok(!f.render().some((node) => node.props.accessibilityLabel === "浏览思考强度选项"));
  assert.ok(f.render().some((node) => node.props.children === "端点未列出此模型的思考档位。可以手动填写。"));
  byLabel("思考强度").onChangeText("custom");
  assert.equal(byLabel("思考强度").value, "custom");
});

test("selecting modes survives saving; changing models preserves mode and changing providers clears it", async () => {
  const f = fixture();
  f.field("模式(可选)").onValueChange("agent");
  f.render().find((node) => node.type === "SettingsSelect" && node.props.label === "Model" && node.props.value === "m").props.onValueChange("n");
  assert.equal(f.field("模式(可选)").value, "agent");
  f.render().find((node) => node.type === "SettingsAction" && node.props.actionLabel === "保存").props.onPress();
  assert.equal(f.saved[0].revision, 7);
  assert.equal(f.saved[0].values.workerProfiles[0].modeId, "agent");
  assert.equal(f.saved[0].values.workerModeId, "full-access");
  f.field("Provider").onValueChange("codex");
  assert.equal(f.field("模式(可选)").value, "");
  f.field("默认 Worker").onValueChange("custom-acp");
  assert.equal(f.field("Worker 模式(可选)").value, "");
});

test("discovery failures preserve a saved mode and let users reset to Paseo defaults", () => {
  const f = fixture({ query: { isError: true }, modeId: "agent" });
  const mode = f.field("模式(可选)");
  assert.equal(mode.value, "agent");
  assert.ok(mode.options.some((option) => option.value === "agent"));
  mode.onValueChange("");
  assert.equal(f.field("模式(可选)").value, "");
});

test("a pi worker's modes come from pi-permission-modes instead of the empty provider snapshot", () => {
  const f = fixture({
    values: { workerProvider: "pi/sonnet" },
    piModes: {
      data: {
        available: true,
        modes: [{ id: "build", label: "Build" }, { id: "yolo", label: "YOLO" }],
        defaultModeId: "build",
      },
    },
  });
  const mode = f.field("Worker 模式(可选)");
  assert.deepEqual(Array.from(mode.options.map((option) => option.value)), ["", "build", "yolo"]);
  assert.deepEqual(Array.from(mode.options.map((option) => option.label)), ["Paseo 默认", "Build", "YOLO"]);
  assert.equal(mode.value, "");
  assert.match(mode.hint, /来自 pi-permission-modes/);
  mode.onValueChange("yolo");
  f.render().find((node) => node.type === "SettingsAction" && node.props.actionLabel === "保存").props.onPress();
  assert.equal(f.saved[0].values.workerModeId, "yolo");
});

test("pi falls back to the Paseo default when pi-permission-modes is not installed", () => {
  const f = fixture({
    values: { workerProvider: "pi/sonnet", workerModeId: "yolo" },
    piModes: { data: { available: false, modes: [], defaultModeId: null } },
  });
  const mode = f.field("Worker 模式(可选)");
  assert.deepEqual(Array.from(mode.options.map((option) => option.value)), [""]);
  assert.equal(mode.value, "");
  assert.match(mode.hint, /未安装 pi-permission-modes/);
});
