import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DECISION_ONLY_EXCLUDED_PROVIDERS,
  decisionOnlyProviderError,
  providerCanDecideOnly,
  providerNameOf,
} from "../shared/decision-provider.ts";
import { pickDecisionProvider, resolveProviderSelection } from "../server/providers.ts";

const ENTRIES = [
  { provider: "claude", enabled: true, status: "ready", models: [{ id: "sonnet", isDefault: true }] },
  { provider: "codex", enabled: true, status: "ready", models: [{ id: "gpt-5", isDefault: true }] },
  { provider: "opencode", enabled: true, status: "ready", models: [{ id: "zen", isDefault: true }] },
];

test("provider names are read from a provider or provider/model selection", () => {
  assert.equal(providerNameOf("codex"), "codex");
  assert.equal(providerNameOf("codex/gpt-5"), "codex");
  assert.equal(providerNameOf(" zcode-acp/builtin:plan\\GLM "), "zcode-acp");
  assert.equal(providerNameOf(""), "");
});

test("only providers that can withhold tools may run as a decision-only session", () => {
  assert.deepEqual([...DECISION_ONLY_EXCLUDED_PROVIDERS], ["codex"]);
  assert.equal(providerCanDecideOnly("codex/gpt-5"), false);
  assert.equal(providerCanDecideOnly("codex"), false);
  assert.equal(providerCanDecideOnly("claude/sonnet"), true);
  assert.equal(providerCanDecideOnly("pi"), true);
  // 空选择表示自动挑选,由引擎跳过受限 provider。
  assert.equal(providerCanDecideOnly(""), true);
});

test("the refusal names the provider and what to do instead", () => {
  const message = decisionOnlyProviderError("Router/watchdog", "codex/gpt-5");
  assert.match(message, /codex\/gpt-5/);
  assert.match(message, /cannot run as a decision-only session/);
  assert.match(message, /always exposes tools/);
  assert.match(message, /leave the setting empty/);
});

test("the Router role refuses codex while the Worker role accepts it", () => {
  const router = resolveProviderSelection("codex/gpt-5", ENTRIES, "router");
  assert.ok("error" in router);
  assert.match(router.error, /exec_1|cannot run as a decision-only session/);

  const worker = resolveProviderSelection("codex/gpt-5", ENTRIES, "worker");
  assert.deepEqual(worker, { selection: "codex/gpt-5" });

  // 默认参数是 Worker,保持旧调用方行为。
  assert.deepEqual(resolveProviderSelection("codex/gpt-5", ENTRIES), { selection: "codex/gpt-5" });
});

test("an automatic pick skips codex and prefers the configured order", () => {
  const preferred = ["claude", "codex", "opencode"];
  assert.equal(pickDecisionProvider(ENTRIES, preferred)?.provider, "claude");
  // 首选不可用时落到下一个能关闭工具的 provider,而不是 codex 之外随便挑。
  assert.equal(pickDecisionProvider(ENTRIES.slice(1), preferred)?.provider, "opencode");
  // 只有受限 provider 时无解,交由调用方报错。
  assert.equal(pickDecisionProvider([ENTRIES[1]], preferred), undefined);
});
