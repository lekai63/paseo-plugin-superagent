import test from "node:test";
import assert from "node:assert/strict";
import { DecisionBudget, DECISION_TOOL_LIMIT, DECISION_REPEAT_LIMIT } from "../server/decision-budget.ts";
import { imDay } from "../shared/im-threads.ts";

test("recall budget rejects repeated calls and total distinct calls independently", async () => {
  const repeated = new DecisionBudget();
  for (let i = 0; i < DECISION_REPEAT_LIMIT; i++) assert.equal(repeated.check("read", { id: "ticket" }), null);
  assert.match(repeated.check("read", { id: "ticket" }), /budget exceeded/);
  await assert.rejects(repeated.failed, /budget exceeded/);
  const distinct = new DecisionBudget();
  for (let i = 0; i < DECISION_TOOL_LIMIT; i++) assert.equal(distinct.check("read", { id: String(i) }), null);
  assert.match(distinct.check("search", { query: "more" }), /budget exceeded/);
  await assert.rejects(distinct.failed, /budget exceeded/);
  const next = new DecisionBudget();
  assert.equal(next.check("read", { id: "ticket" }), null);
});

test("IM day uses Beijing midnight regardless of the host timezone", () => {
  assert.equal(imDay(new Date("2026-11-13T15:59:59Z")), "2026-11-13");
  assert.equal(imDay(new Date("2026-11-13T16:00:00Z")), "2026-11-14");
});
