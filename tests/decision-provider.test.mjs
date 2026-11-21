import assert from "node:assert/strict";
import { test } from "node:test";
import { pickPreferredProvider } from "../server/providers.ts";

const ENTRIES = [
  { provider: "claude", enabled: true, status: "ready", models: [{ id: "sonnet", isDefault: true }] },
  { provider: "codex", enabled: true, status: "ready", models: [{ id: "gpt-5", isDefault: true }] },
  { provider: "opencode", enabled: true, status: "ready", models: [{ id: "zen", isDefault: true }] },
];

test("an automatic Router pick honors provider priority and falls back to Pi", () => {
  const preferred = ["claude", "codex", "opencode"];
  assert.equal(pickPreferredProvider(ENTRIES.toReversed(), preferred)?.provider, "claude");
  assert.equal(pickPreferredProvider(ENTRIES.slice(1).toReversed(), preferred)?.provider, "codex");
  assert.equal(pickPreferredProvider([{ provider: "pi" }], preferred)?.provider, "pi");
  assert.equal(pickPreferredProvider([], preferred), undefined);
});
