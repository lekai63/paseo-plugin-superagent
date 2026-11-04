import assert from "node:assert/strict";
import test from "node:test";
import { routerStatusMark, sidebarWorkerCounts } from "../shared/sidebar-status.ts";

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

test("router mark maps the live session state onto the five dots", () => {
  assert.deepEqual(routerStatusMark([{ status: "running" }]), { kind: "running", count: 1 });
  assert.deepEqual(routerStatusMark([{ status: "initializing" }]), { kind: "running", count: 1 });
  assert.deepEqual(routerStatusMark([{ status: "idle", requiresAttention: true, attentionReason: "finished" }]), { kind: "finished", count: 1 });
  assert.deepEqual(routerStatusMark([{ status: "idle", pendingPermissions: [{}] }]), { kind: "permission", count: 1 });
  assert.deepEqual(routerStatusMark([{ status: "idle", requiresAttention: true, attentionReason: "permission" }]), { kind: "permission", count: 1 });
  assert.deepEqual(routerStatusMark([{ status: "error" }]), { kind: "error", count: 1 });
  assert.deepEqual(routerStatusMark([{ status: "idle", requiresAttention: true, attentionReason: "error" }]), { kind: "error", count: 1 });
  assert.deepEqual(routerStatusMark([{ status: "idle", providerUnavailable: true }]), { kind: "error", count: 1 });
  assert.deepEqual(routerStatusMark([{ status: "idle" }]), { kind: "idle", count: 1 });
});

test("router mark stays blank for closed, archived and missing sessions", () => {
  assert.equal(routerStatusMark([{ status: "closed" }]), null);
  assert.equal(routerStatusMark([{ status: "idle", archivedAt: "2026-01-01" }]), null);
  assert.equal(routerStatusMark([null, undefined]), null);
  assert.equal(routerStatusMark([]), null);
  // 关闭的会话不把唯一可显示的状态挤掉。
  assert.deepEqual(routerStatusMark([{ status: "closed" }, { status: "running" }]), { kind: "running", count: 1 });
});

test("router mark prefers the most urgent state and counts only routers in that state", () => {
  // 优先级沿用宿主 agent 状态序:权限 > 出错 > 运行 > 完成待查看 > 空闲。
  assert.deepEqual(routerStatusMark([{ status: "running" }, { status: "error" }]), { kind: "error", count: 1 });
  assert.deepEqual(routerStatusMark([{ status: "running" }, { status: "idle", pendingPermissions: [{}] }]), { kind: "permission", count: 1 });
  assert.deepEqual(routerStatusMark([{ status: "running" }, { status: "initializing" }]), { kind: "running", count: 2 });
  assert.deepEqual(routerStatusMark([{ status: "idle" }, { status: "idle" }]), { kind: "idle", count: 2 });
  assert.deepEqual(routerStatusMark([{ status: "idle" }, { status: "running" }]), { kind: "running", count: 1 });
});
