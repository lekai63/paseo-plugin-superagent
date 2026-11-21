import assert from "node:assert/strict";
import { test } from "node:test";
import { superagentSettings } from "../shared/settings.ts";

test("legacy decision providers do not become inference model IDs when upgrading settings", () => {
  const values = superagentSettings.schema.parse({
    routerProvider: "claude/sonnet",
    watchdogProvider: "codex/gpt-5",
    workerProvider: "pi/glm",
  });
  assert.equal(values.inferenceBaseUrl, "");
  assert.equal(values.routerModel, "");
  assert.equal(values.watchdogModel, "");
  assert.equal(values.workerProvider, "pi/glm");
});
