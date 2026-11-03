import assert from "node:assert/strict";
import test from "node:test";
import { emptyState, SuperagentStateSchema } from "../shared/model.ts";
import { recentResults, threadResult } from "../shared/results.ts";

const old = "2026-01-01T00:00:00Z";
const newer = "2026-01-01T00:01:00Z";
const thread = { id: "thread", key: "manual:thread", title: "Finished task", state: "closed", createdAt: old, updatedAt: newer };

function legacyState() {
  const state = emptyState();
  state.threads.push({ ...thread });
  state.tickets.push({ id: "ticket", threadId: thread.id, title: "Task", status: "canceled", report: "Saved original report", workspaceId: "old-worktree" });
  state.triggers.push({ id: "report", threadId: thread.id, kind: "report", sender: "worker:ticket", text: "Truncated trigger", receivedAt: old });
  state.decisions.push({ id: "reply", threadId: thread.id, outcome: "reply", reply: "Router conclusion", triggerIds: ["report"], createdAt: newer });
  return state;
}

test("legacy closed tasks expose the Router reply and identify the original report", () => {
  const state = legacyState();
  const result = threadResult(state.threads[0], state);
  assert.equal(result.kind, "router_reply");
  assert.equal(result.text, "Router conclusion");
  assert.deepEqual(result.ticketIds, ["ticket"]);
  const projected = recentResults(state)[0];
  assert.equal(projected.threadId, "thread");
  assert.deepEqual(projected.workspaceIds, ["old-worktree"]);
  assert.equal(state.threads[0].latestResult, undefined);
});

test("a newer Worker report wins over an earlier acknowledgement until the Router replies", () => {
  const state = legacyState();
  state.triggers[0].receivedAt = newer;
  state.decisions[0].createdAt = old;
  state.decisions[0].reply = "Starting the task";
  const result = threadResult(state.threads[0], state);
  assert.equal(result.kind, "worker_report");
  assert.equal(result.text, "Saved original report");
});

test("a saved result survives state reload, native agent removal and activity pruning", () => {
  const state = emptyState();
  state.threads.push({ ...thread, latestResult: {
    id: "saved", kind: "router_reply", text: "Retained conclusion", createdAt: newer, ticketIds: ["removed-worker-ticket"],
  } });
  const reloaded = SuperagentStateSchema.parse(JSON.parse(JSON.stringify(state)));
  assert.equal(recentResults(reloaded)[0].text, "Retained conclusion");
  assert.deepEqual(recentResults(reloaded, "other-thread"), []);
});

test("original ticket reports remain usable when the legacy activity window was already trimmed", () => {
  const state = legacyState();
  state.decisions = [];
  state.triggers = [];
  assert.equal(threadResult(state.threads[0], state).text, "Saved original report");
});
