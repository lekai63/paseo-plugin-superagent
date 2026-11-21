import assert from "node:assert/strict";
import { defineTranslations } from "@getpaseo/plugin/client";
import test from "node:test";
import {
  validateProviderThinkingOption,
} from "../server/providers.ts";
import { SETTINGS_DEFAULTS, superagentSettings } from "../shared/settings.ts";

const ENTRIES = [
  {
    provider: "pi",
    status: "ready",
    models: [
      {
        id: "glm-5.3",
        label: "GLM 5.3",
        thinkingOptions: [{ id: "low" }, { id: "high" }, { id: "max" }],
      },
      {
        id: "glm-5.3-flash",
        label: "GLM 5.3 Flash",
        thinkingOptions: [{ id: "low" }, { id: "high" }, { id: "max" }],
      },
    ],
  },
  {
    provider: "codex",
    status: "ready",
    models: [{ id: "gpt", label: "GPT" }], // 未上报 thinkingOptions
  },
  { provider: "loading-provider", status: "loading", models: [{ id: "m" }] },
];

test("validateProviderThinkingOption accepts options the selected model offers", () => {
  validateProviderThinkingOption("pi/glm-5.3", "high", ENTRIES);
  validateProviderThinkingOption("pi", "max", ENTRIES); // 裸 provider:任一模型含此档位即过
  validateProviderThinkingOption("pi/glm-5.3", "", ENTRIES); // 留空 = 不指定
});

test("unknown options on a model that reported its catalog are rejected with the available ids", () => {
  assert.throws(
    () => validateProviderThinkingOption("pi/glm-5.3", "xhigh", ENTRIES),
    /thinking option "xhigh" is not offered by provider "pi\/glm-5.3" \(available: low, high, max\)/,
  );
  // 裸 provider:任一模型报了清单就参与校验
  assert.throws(() => validateProviderThinkingOption("pi", "turbo", ENTRIES), /available: low, high, max/);
});

test("missing catalogs fall through to Paseo's creation-time validation", () => {
  validateProviderThinkingOption("codex/gpt", "high", ENTRIES); // 模型未上报 thinkingOptions
  validateProviderThinkingOption("loading-provider", "high", ENTRIES); // provider 未 ready
  validateProviderThinkingOption("unknown-provider", "high", ENTRIES); // 不在快照中
  validateProviderThinkingOption("pi/not-in-snapshot", "high", ENTRIES); // 模型 id 不在快照(如 ACP 动态模型)
});

test("Worker thinking fields default empty, parse, trim and round-trip", () => {
  assert.equal(SETTINGS_DEFAULTS.workerThinkingOptionId, "");
  assert.deepEqual(SETTINGS_DEFAULTS.workerProfiles, []);
  // v11 旧值照常解析,新字段补默认空串。
  const legacy = superagentSettings.schema.parse({ workerProvider: "pi/glm-5.3" });
  assert.equal(legacy.workerThinkingOptionId, "");
  const configured = superagentSettings.schema.parse({
    workerThinkingOptionId: "max",
    workerProfiles: [{ name: "code", provider: "pi/glm-5.3", description: "code", thinkingOptionId: "low" }],
  });
  assert.equal(configured.workerThinkingOptionId, "max");
  assert.equal(configured.workerProfiles[0].thinkingOptionId, "low");
  assert.equal(configured.workerProfiles[0].modeId, "");
  assert.deepEqual(superagentSettings.schema.parse(configured), configured);
});

test("Worker settings reject malformed thinking ids", () => {
  assert.equal(superagentSettings.schema.safeParse({ workerThinkingOptionId: "a b" }).success, false);
  const issues = (values) =>
    superagentSettings.schema.safeParse(values).error?.issues.map((issue) => issue.path.join("."));
  assert.deepEqual(
    issues({ workerProfiles: [{ name: "code", provider: "pi/glm-5.3", description: "d", thinkingOptionId: "UPPER" }] }),
    ["workerProfiles.0.thinkingOptionId"],
  );
});

// ——— wire 模式 compact 快照还原（宿主 App 共享连接的真实形态）———
// compact 模型只带 thinkingSet 索引,选项收在共享 thinkingSets;useProviderSnapshot 的
// queryFn 负责展开。这里直接驱动同一函数链,验证 ThinkingPicker 能从 compact 快照拿到档位。
test("compact snapshot: queryFn expands thinkingSets and ThinkingPicker offers the options", async (t) => {
  const { build } = await import("esbuild");
  const { runInNewContext } = await import("node:vm");
  const { fileURLToPath } = await import("node:url");
  const result = await build({
    entryPoints: [fileURLToPath(new URL("../client/settings-screen.tsx", import.meta.url))],
    bundle: true, format: "cjs", platform: "neutral", target: "es2020", jsx: "automatic",
    external: ["react", "react/jsx-runtime", "react-native", "@getpaseo/*", "@tanstack/react-query", "zod"],
    write: false,
  });

  // 实测 6768 daemon 的 wire 快照形状:pi 四模型的 thinkingSet=7 → thinkingSets[7] = low/high/max。
  const compactPayload = {
    entries: [],
    compactSnapshot: {
      entries: [
        {
          provider: "pi", status: "ready", enabled: true,
          models: [
            { id: "zcode-local/glm-5.3", label: "GLM 5.3", thinkingSet: 0 },
            { id: "zcode-local/glm-5.3-flash", label: "GLM 5.3 Flash", thinkingSet: 0 },
          ],
        },
        {
          provider: "codex", status: "ready", enabled: true,
          models: [{ id: "gpt-6.1-sol", label: "GPT 6.1", thinkingSet: 1 }],
        },
      ],
      thinkingSets: [
        { options: [{ id: "low" }, { id: "high", isDefault: true }, { id: "max" }], defaultOptionId: "high" },
        { options: [{ id: "low" }, { id: "high" }], defaultOptionId: "high" },
      ],
    },
  };

  let queryOptions;
  const piModesQuery = { data: { available: false, modes: [], defaultModeId: null } };
  const settings = {
    status: "ready", revision: 1, saving: false,
    values: superagentSettings.schema.parse({
      workerProvider: "pi/zcode-local/glm-5.3",
      workerThinkingOptionId: "max",
      workerProfiles: [{ name: "codex-advisor", provider: "codex/gpt-6.1-sol", thinkingOptionId: "high", description: "x" }],
    }),
    save: async () => {},
  };
  const slots = []; let cursor = 0;
  const useState = (initial) => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
    return [slots[index], (value) => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
  };
  const jsx = (type, props) => ({ type, props });
  const modules = {
    react: { useState, useEffect() {}, useCallback: (fn) => fn, useMemo: (fn) => fn(), useRef: (v) => useState({ current: v })[0] },
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    "react-native": { View: "View", Text: "Text" },
    "@getpaseo/plugin": await import("@getpaseo/plugin"),
    "@getpaseo/plugin/client": {
      defineTranslations,
      useTranslation: () => ({ locale: "zh-CN", t: (key) => key }),
      useSettings: () => settings,
      usePaseo: () => ({ providers: { snapshot: async () => compactPayload } }),
      useRpc: () => async () => piModesQuery.data,
    },
    "@getpaseo/plugin/client/ui": Object.fromEntries(
      ["SettingsAction", "SettingsCard", "SettingsInput", "SettingsSection", "SettingsSelect", "SettingsSwitch", "TextInput"].map((n) => [n, n]),
    ),
    "@tanstack/react-query": {
      useQueryClient: () => ({ getQueryData() {} }),
      useQuery: (options) => {
        if (options.queryKey?.[1] === "pi-modes") return piModesQuery;
        queryOptions = options;
        return { data: undefined };
      },
    },
    zod: await import("zod"),
  };
  const sandbox = { module: { exports: {} }, require: (name) => modules[name] };
  sandbox.exports = sandbox.module.exports;
  runInNewContext(result.outputFiles[0].text, sandbox);

  // 先渲染一次让 useProviderSnapshot 的 useQuery 参数被抓到,再驱动 queryFn 走真实 usePaseo 快照:compact → 展开形态。
  const render = () => {
    cursor = 0;
    const leaves = [];
    const visit = (node) => {
      if (Array.isArray(node)) { node.forEach(visit); return; }
      if (!node || typeof node !== "object") return;
      if (typeof node.type === "function") { visit(node.type(node.props)); return; }
      leaves.push(node);
      visit(node.props?.children);
    };
    visit(sandbox.module.exports.SuperagentModelSettingsScreen({ host: { id: "host" }, theme: { colors: {} } }));
    return leaves;
  };
  render();
  const expanded = await queryOptions.queryFn();
  const pi = expanded.find((entry) => entry.provider === "pi");
  assert.deepEqual(
    pi.models[0].thinkingOptions.map((option) => option.id),
    ["low", "high", "max"],
    "compact thinkingSet 索引被还原成 thinkingOptions",
  );

  // 拿展开后的快照渲染设置页:三处 ThinkingPicker 都应有可选档位而不是只有 Provider 默认。
  // 设置屏在求值时解构了 useQuery,故原地改写同一模块对象而不是替换。
  const reactQuery = modules["@tanstack/react-query"];
  let query = { data: undefined };
  reactQuery.useQuery = (options) => options.queryKey?.[1] === "pi-modes" ? piModesQuery : query;
  query = { data: expanded };
  const leaves = render();
  const selects = leaves.filter((node) => node.type === "SettingsSelect" && /thinking/i.test(String(node.props.label ?? "")));
  assert.equal(selects.length, 2, "Worker and profile thinking pickers");
  const workerPicker = selects.find((node) => node.props.label.includes("默认 Worker"));
  assert.deepEqual(Array.from(workerPicker.props.options.map((option) => option.value)), ["", "low", "high", "max"]);
  assert.equal(workerPicker.props.value, "max");
  const profilePicker = selects.find((node) => node.props.label === "thinking 档位(可选)");
  assert.deepEqual(Array.from(profilePicker.props.options.map((option) => option.value)), ["", "low", "high"]);

  // 展开后的条目也满足引擎侧启动校验。
  validateProviderThinkingOption("pi/zcode-local/glm-5.3", "max", expanded);
  validateProviderThinkingOption("codex/gpt-6.1-sol", "high", expanded);
});

// 未上报 thinking 清单的 provider(copilot 等无 models、或模型无 thinkingSet):
// ThinkingPicker 退化为手工输入(SettingsInput),已保存值带入、可清空。
test("ThinkingPicker falls back to free-text input when no catalog is reported", async () => {
  const { build } = await import("esbuild");
  const { runInNewContext } = await import("node:vm");
  const { fileURLToPath } = await import("node:url");
  const result = await build({
    entryPoints: [fileURLToPath(new URL("../client/settings-screen.tsx", import.meta.url))],
    bundle: true, format: "cjs", platform: "neutral", target: "es2020", jsx: "automatic",
    external: ["react", "react/jsx-runtime", "react-native", "@getpaseo/*", "@tanstack/react-query", "zod"],
    write: false,
  });
  const entries = [
    { provider: "pi", status: "ready", models: [{ id: "glm-5.3", label: "GLM", thinkingOptions: [{ id: "high" }] }] },
    { provider: "bare-acp", status: "ready", models: [{ id: "m", label: "M" }] }, // 无 thinkingOptions
  ];
  const settings = {
    status: "ready", revision: 1, saving: false,
    values: superagentSettings.schema.parse({
      workerProvider: "bare-acp/m",
      workerThinkingOptionId: "turbo",
      workerProfiles: [{ name: "pi-worker", provider: "pi/glm-5.3", description: "Pi" }],
    }),
    save: async () => {},
  };
  const slots = []; let cursor = 0;
  const useState = (initial) => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
    return [slots[index], (value) => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
  };
  const jsx = (type, props) => ({ type, props });
  const modules = {
    react: { useState, useEffect() {}, useCallback: (fn) => fn, useMemo: (fn) => fn(), useRef: (v) => useState({ current: v })[0] },
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    "react-native": { View: "View", Text: "Text" },
    "@getpaseo/plugin": await import("@getpaseo/plugin"),
    "@getpaseo/plugin/client": {
      defineTranslations,
      useTranslation: () => ({ locale: "zh-CN", t: (key) => key }),
      useSettings: () => settings,
      usePaseo: () => ({}),
      useRpc: () => async () => ({ available: false, modes: [], defaultModeId: null }),
    },
    "@getpaseo/plugin/client/ui": Object.fromEntries(
      ["SettingsAction", "SettingsCard", "SettingsInput", "SettingsSection", "SettingsSelect", "SettingsSwitch", "TextInput"].map((n) => [n, n]),
    ),
    "@tanstack/react-query": {
      useQueryClient: () => ({ getQueryData() {} }),
      useQuery: (options) => options.queryKey?.[1] === "pi-modes"
        ? { data: { available: false, modes: [], defaultModeId: null } }
        : { data: entries },
    },
    zod: await import("zod"),
  };
  const sandbox = { module: { exports: {} }, require: (name) => modules[name] };
  sandbox.exports = sandbox.module.exports;
  runInNewContext(result.outputFiles[0].text, sandbox);
  cursor = 0;
  const leaves = [];
  const visit = (node) => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!node || typeof node !== "object") return;
    if (typeof node.type === "function") { visit(node.type(node.props)); return; }
    leaves.push(node);
    visit(node.props?.children);
  };
  visit(sandbox.module.exports.SuperagentModelSettingsScreen({ host: { id: "host" }, theme: { colors: {} } }));
  const workerThinking = leaves.find((node) => node.type === "SettingsInput" && node.props.label === "默认 Worker thinking 档位(可选)");
  assert.equal(workerThinking.props.initialValue, "turbo");
  assert.match(workerThinking.props.hint, /手工填写/);
});
