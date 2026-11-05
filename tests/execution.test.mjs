import assert from "node:assert/strict";
import test from "node:test";
import { agentStatus, currentTickets, directTickets, elapsedTime, ticketPriority } from "../shared/execution.ts";

const ticket = (id, extra = {}) => ({ id, threadId: "thread", status: "running", subscribed: true, workerAgentId: `worker-${id}`, ...extra });

test("direct delivery fans out to every active subscription that has a session", () => {
  const running = ticket("one");
  assert.deepEqual(directTickets([running]).map((entry) => entry.id), ["one"]);
  assert.deepEqual(directTickets([ticket("waiting", { status: "waiting" })]).map((entry) => entry.id), ["waiting"]);
  assert.deepEqual(directTickets([]), []);
  // 缺会话的订阅不参与直通(等 Router 评估),也不会挡住其他订阅。
  assert.deepEqual(directTickets([ticket("missing", { workerAgentId: null })]), []);
  assert.deepEqual(directTickets([running, ticket("missing", { workerAgentId: null })]).map((entry) => entry.id), ["one"]);
  // 多个有会话的订阅 → 全部直通(fan-out)。
  assert.deepEqual(directTickets([running, ticket("two")]).map((entry) => entry.id), ["one", "two"]);
  for (const status of ["pending", "launching", "completed", "failed", "canceled"]) {
    assert.deepEqual(directTickets([running, ticket(status, { status })]).map((entry) => entry.id), ["one"]);
  }
  assert.deepEqual(directTickets([running, ticket("unsubscribed", { subscribed: false })]).map((entry) => entry.id), ["one"]);
});

test("session permission and provider errors remain distinct from Ticket lifecycle", () => {
  const agent = { id: "worker", status: "running", pendingPermissions: [{}] };
  assert.equal(agentStatus(agent).label, "等待权限");
  assert.equal(ticketPriority(ticket("one"), agent), 0);
  assert.equal(agentStatus({ ...agent, pendingPermissions: [], requiresAttention: true, attentionReason: "permission" }).label, "等待权限");
  assert.equal(agentStatus({ ...agent, archivedAt: "2026-01-01" }).label, "会话已关闭");
  assert.equal(agentStatus({ id: "worker", status: "idle" }).label, "会话空闲");
  const statuses = ["pending", "launching", "running", "waiting", "completed", "failed", "canceled"];
  assert.deepEqual(currentTickets(statuses.map((status) => ticket(status, { status }))).map((item) => item.status), statuses.slice(0, 4));
  assert.equal(agentStatus({ id: "worker", status: "error" }).tone, "danger");
  assert.equal(agentStatus({ id: "worker", status: "idle", providerUnavailable: true }).tone, "danger");
  assert.equal(agentStatus(null).label, "会话不存在");
});

test("elapsed time is bounded and describes this attempt rather than total task duration", () => {
  const start = "2026-01-01T00:00:00Z";
  const time = Date.parse(start);
  assert.equal(elapsedTime(start, time + 45_000), "45 秒");
  assert.equal(elapsedTime(start, time + 125_000), "2 分钟");
  assert.equal(elapsedTime(start, time + 3_725_000), "1 小时 2 分钟");
  assert.equal(elapsedTime(start, time - 1000), "0 秒");
  assert.equal(elapsedTime("invalid", time), "");
});
