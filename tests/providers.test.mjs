import assert from "node:assert/strict";
import test from "node:test";
import { resolveProviderSelection, validateProviderMode } from "../server/providers.ts";

const entries = [
  { provider: "codex", enabled: true, status: "ready", models: [{ id: "gpt", isDefault: false }, { id: "gpt-mini", isDefault: true }] },
  {
    provider: "zcode-acp", enabled: true, status: "ready",
    models: [{ id: "builtin:bigmodel-coding-plan\\GLM-5.3" }, { id: "builtin:bigmodel-coding-plan\\GLM-5.3-Flash" }],
  },
  { provider: "pi", enabled: false, status: "ready", models: [{ id: "x" }] },
  { provider: "custom", enabled: true, status: "loading", models: [] },
];

test("an exact provider/model selection passes through", () => {
  assert.deepEqual(resolveProviderSelection(" codex/gpt ", entries), { selection: "codex/gpt" });
  assert.deepEqual(
    resolveProviderSelection("zcode-acp/builtin:bigmodel-coding-plan\\GLM-5.3-Flash", entries),
    { selection: "zcode-acp/builtin:bigmodel-coding-plan\\GLM-5.3-Flash" },
  );
});

test("JSON-escaped backslashes in a model id are collapsed when that matches a real model", () => {
  const result = resolveProviderSelection("zcode-acp/builtin:bigmodel-coding-plan\\\\GLM-5.3-Flash", entries);
  assert.equal(result.selection, "zcode-acp/builtin:bigmodel-coding-plan\\GLM-5.3-Flash");
  assert.match(result.note, /normalized/);
});

test("a bare provider picks its default model", () => {
  assert.deepEqual(resolveProviderSelection("codex", entries), { selection: "codex/gpt-mini" });
  assert.deepEqual(resolveProviderSelection("zcode-acp", entries), {
    selection: "zcode-acp/builtin:bigmodel-coding-plan\\GLM-5.3",
  });
});

test("unknown models list the available ids", () => {
  const result = resolveProviderSelection("zcode-acp/GLM-5.3-Flash", entries);
  assert.match(result.error, /model "GLM-5\.3-Flash" is not offered by provider "zcode-acp"/);
  assert.match(result.error, /builtin:bigmodel-coding-plan\\GLM-5\.3-Flash/);
});

test("unknown and disabled providers are rejected", () => {
  assert.match(resolveProviderSelection("nope/x", entries).error, /provider "nope" is not available on this host \(known: codex, zcode-acp, pi, custom\)/);
  assert.match(resolveProviderSelection("pi/x", entries).error, /disabled/);
});

test("providers without a model list accept an explicit model but need one", () => {
  assert.deepEqual(resolveProviderSelection("custom/m", entries), { selection: "custom/m" });
  assert.match(resolveProviderSelection("custom", entries).error, /reports no models \(status: loading\)/);
});

test("mode IDs are validated against their own provider, including ACP URL IDs", () => {
  const acpMode = "https://agentclientprotocol.com/protocol/session-modes#agent";
  const catalog = [
    { provider: "codex", status: "ready", modes: [{ id: "full-access" }] },
    { provider: "custom-acp", status: "ready", modes: [{ id: "ask" }, { id: acpMode }] },
    { provider: "no-modes", status: "ready", modes: [] },
  ];
  assert.doesNotThrow(() => validateProviderMode("custom-acp/model/with/slashes", acpMode, catalog));
  assert.doesNotThrow(() => validateProviderMode("codex/gpt", "", catalog));
  assert.throws(() => validateProviderMode("custom-acp/model", "full-access", catalog), /not offered by provider "custom-acp"/);
  assert.throws(() => validateProviderMode("no-modes/model", "ask", catalog), /available: none/);
  // Discovery failures must not silently replace the explicitly selected mode with a default.
  assert.doesNotThrow(() => validateProviderMode("custom-acp/model", acpMode, []));
  assert.doesNotThrow(() => validateProviderMode("custom-acp/model", acpMode, [{ provider: "custom-acp", status: "loading", modes: [] }]));
});
