import test from "node:test";
import assert from "node:assert/strict";
import { DecisionBudget, DECISION_TOOL_LIMIT, DECISION_REPEAT_LIMIT, DECISION_OVERFLOW_LIMIT } from "../server/decision-budget.ts";
import { imDay } from "../shared/im-threads.ts";

const settled = async (promise) => {
  let state = "pending";
  promise.then(() => { state = "resolved"; }, () => { state = "rejected"; });
  await new Promise((resolve) => setImmediate(resolve));
  return state;
};

test("recall budget refuses calls past the limit without stopping the run, then stops a model that keeps calling", async () => {
  const distinct = new DecisionBudget();
  for (let i = 0; i < DECISION_TOOL_LIMIT; i++) assert.equal(distinct.check("read", { id: String(i) }), null);
  assert.equal(distinct.used, DECISION_TOOL_LIMIT);
  assert.equal(distinct.exhausted, true);
  assert.match(distinct.usage(), /all 12 calls used.*reply now with the JSON verdict/);
  for (let i = 0; i < DECISION_OVERFLOW_LIMIT; i++) {
    assert.match(distinct.check("search", { query: `more ${i}` }), /Recall budget exhausted .*reply now with the JSON verdict/);
  }
  assert.equal(await settled(distinct.failed), "pending", "refusals alone do not stop the run");
  assert.equal(distinct.error, null);
  assert.match(distinct.check("search", { query: "again" }), /recall budget exhausted: 12 recall calls ran and 5 more were refused/);
  await assert.rejects(distinct.failed, /recall budget exhausted/);
});

test("identical calls are refused after the repeat limit while other recalls stay available", async () => {
  const repeated = new DecisionBudget();
  for (let i = 0; i < DECISION_REPEAT_LIMIT; i++) assert.equal(repeated.check("read", { id: "ticket" }), null);
  assert.equal(repeated.exhausted, true, "a saturated signature marks the budget as the likely stop cause");
  assert.match(repeated.check("read", { id: "ticket" }), /already ran 3 times/);
  assert.equal(repeated.check("read", { id: "other" }), null);
  assert.match(repeated.usage(), /4 of 12 calls used in this evaluation, 8 left/);
  assert.equal(new DecisionBudget().exhausted, false);
});

test("closing the budget for the verdict run refuses every recall and re-arms the stop", async () => {
  const budget = new DecisionBudget();
  for (let i = 0; i < DECISION_TOOL_LIMIT; i++) budget.check("read", { id: String(i) });
  for (let i = 0; i <= DECISION_OVERFLOW_LIMIT; i++) budget.check("search", { query: String(i) });
  await assert.rejects(budget.failed);
  budget.closeForVerdict();
  assert.equal(budget.error, null);
  assert.equal(await settled(budget.failed), "pending", "the verdict run races a fresh failure promise");
  assert.match(budget.check("list", {}), /Recall budget exhausted \(12 recall calls used/);
  assert.equal(budget.used, DECISION_TOOL_LIMIT, "refused calls are not counted as used");
  const early = new DecisionBudget();
  early.check("read", { id: "one" });
  early.closeForVerdict();
  assert.match(early.check("read", { id: "two" }), /Recall budget exhausted \(1 recall calls used/);
});

test("IM day uses Beijing midnight regardless of the host timezone", () => {
  assert.equal(imDay(new Date("2026-11-13T15:59:59Z")), "2026-11-13");
  assert.equal(imDay(new Date("2026-11-13T16:00:00Z")), "2026-11-14");
});
