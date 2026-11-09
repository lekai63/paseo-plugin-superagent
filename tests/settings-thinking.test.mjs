import assert from "node:assert/strict";
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

test("settings v12: thinking fields default empty, parse, trim and round-trip", () => {
  assert.equal(SETTINGS_DEFAULTS.routerThinkingOptionId, "");
  assert.equal(SETTINGS_DEFAULTS.workerThinkingOptionId, "");
  assert.deepEqual(SETTINGS_DEFAULTS.workerProfiles, []);
  // v11 旧值照常解析,新字段补默认空串。
  const legacy = superagentSettings.schema.parse({ workerProvider: "pi/glm-5.3" });
  assert.equal(legacy.routerThinkingOptionId, "");
  assert.equal(legacy.workerThinkingOptionId, "");
  const configured = superagentSettings.schema.parse({
    routerThinkingOptionId: " high ",
    workerThinkingOptionId: "max",
    workerProfiles: [{ name: "code", provider: "pi/glm-5.3", description: "code", thinkingOptionId: "low" }],
  });
  assert.equal(configured.routerThinkingOptionId, "high");
  assert.equal(configured.workerThinkingOptionId, "max");
  assert.equal(configured.workerProfiles[0].thinkingOptionId, "low");
  assert.equal(configured.workerProfiles[0].modeId, "");
  assert.deepEqual(superagentSettings.schema.parse(configured), configured);
});

test("settings v12 rejects malformed thinking ids", () => {
  assert.equal(superagentSettings.schema.safeParse({ routerThinkingOptionId: "High" }).success, false);
  assert.equal(superagentSettings.schema.safeParse({ workerThinkingOptionId: "a b" }).success, false);
  const issues = (values) =>
    superagentSettings.schema.safeParse(values).error?.issues.map((issue) => issue.path.join("."));
  assert.deepEqual(
    issues({ workerProfiles: [{ name: "code", provider: "pi/glm-5.3", description: "d", thinkingOptionId: "UPPER" }] }),
    ["workerProfiles.0.thinkingOptionId"],
  );
});
