import assert from "node:assert/strict";
import { test } from "node:test";
import { isDecisionProviderExcluded } from "../shared/decision-provider.ts";
import { pickDecisionProvider } from "../server/providers.ts";

const ENTRIES = [
  { provider: "claude", enabled: true, status: "ready", models: [{ id: "sonnet", isDefault: true }] },
  { provider: "codex", enabled: true, status: "ready", models: [{ id: "gpt-5", isDefault: true }] },
  { provider: "opencode", enabled: true, status: "ready", models: [{ id: "zen", isDefault: true }] },
];

test("the exclusion checks the provider segment of a selection", () => {
  assert.equal(isDecisionProviderExcluded("codex"), true);
  assert.equal(isDecisionProviderExcluded(" codex /gpt-5 "), true);
  assert.equal(isDecisionProviderExcluded("claude/codex"), false);
  assert.equal(isDecisionProviderExcluded("pi"), false);
  assert.equal(isDecisionProviderExcluded(""), false);
});

test("an automatic pick skips codex and prefers the configured order", () => {
  const preferred = ["claude", "codex", "opencode"];
  assert.equal(pickDecisionProvider(ENTRIES.toReversed(), preferred)?.provider, "claude");
  assert.equal(pickDecisionProvider(ENTRIES.slice(1), preferred)?.provider, "opencode");
  // 只有受限 provider 时无解,交由调用方报错。
  assert.equal(pickDecisionProvider([ENTRIES[1]], preferred), undefined);
});
