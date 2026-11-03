import assert from "node:assert/strict";
import test from "node:test";
import { sidebarWorkerCounts } from "../shared/sidebar-status.ts";

const ticket = (id, status) => ({ id: `ticket-${id}`, workerAgentId: id, status });

test("right counts independently show running and idle Workers, using live agent state", () => {
  const tickets = [ticket("a", "running"), ticket("b", "waiting"), ticket("c", "running")];
  const agents = { a: { status: "running" }, b: { status: "running" }, c: { status: "idle" }, router: { status: "idle" } };
  assert.deepEqual(sidebarWorkerCounts(tickets, agents), { running: 2, done: 1 });
  agents.a.status = "idle";
  assert.deepEqual(sidebarWorkerCounts(tickets, agents), { running: 1, done: 2 });
});

test("right counts exclude queued, retired, missing and failed Workers and deduplicate agent ids", () => {
  const tickets = [ticket("queued", "pending"), ticket("retired", "completed"), ticket("missing", "waiting"),
    ticket("failed", "failed"), ticket("canceled", "canceled"), ticket("live", "waiting"), ticket("live", "waiting")];
  const agents = { queued: { status: "idle" }, retired: { status: "idle", archivedAt: "2026-01-01" }, missing: null,
    failed: { status: "idle" }, canceled: { status: "idle" }, live: { status: "idle" } };
  assert.deepEqual(sidebarWorkerCounts(tickets, agents), { running: 0, done: 1 });
  assert.deepEqual(sidebarWorkerCounts([], agents), { running: 0, done: 0 });
});

test("startup uses running Ticket state until live observations arrive without inventing completed Workers", () => {
  const tickets = [ticket("starting", "launching"), ticket("running", "running"), ticket("waiting", "waiting"), ticket(null, "launching")];
  assert.deepEqual(sidebarWorkerCounts(tickets, {}), { running: 2, done: 0 });
  assert.deepEqual(sidebarWorkerCounts(tickets, { starting: { status: "initializing" }, running: null }), { running: 1, done: 0 });
});
