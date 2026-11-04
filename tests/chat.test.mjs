import assert from "node:assert/strict";
import test from "node:test";
import { buildChatEntries, userStatusLabel } from "../shared/chat.ts";

const at = (second) => `2026-01-01T00:00:${String(second).padStart(2, "0")}.000Z`;

function trigger(id, second, extra = {}) {
  return {
    id, kind: "manual", sender: "user", threadKey: "manual:k", text: `text ${id}`, context: false,
    receivedAt: at(second), status: "evaluated", note: null, threadId: "thr", ...extra,
  };
}

function decision(id, second, outcome, extra = {}) {
  return { id, threadId: "thr", triggerIds: [], outcome, reply: null, rationale: null, ticketId: null, raw: null, createdAt: at(second), ...extra };
}

const ticket = {
  id: "tkt_1", threadId: "thr", title: "修复登录页", mandate: "m", status: "running", workerAgentId: "agent-w",
  profile: "code", attempts: 1, subscribed: true, report: "## 完成\n全部测试通过", createdAt: at(2), updatedAt: at(5),
};

test("thread records become a chronological conversation", () => {
  // 快照按时间倒序给出;同一时刻的多条裁决按写入顺序排在触发之后。
  const entries = buildChatEntries(
    [trigger("trg_report", 6, { kind: "report", sender: "worker:tkt_1", text: 'Worker report for "修复登录页":\n截断的汇报' }), trigger("trg_user", 1)],
    [decision("dec_reply2", 7, "reply", { reply: "已完成" }), decision("dec_dispatch", 2, "dispatch", { ticketId: "tkt_1" }),
      decision("dec_reply1", 2, "reply", { reply: "我先派一个 Worker" })],
    [ticket],
  );
  assert.deepEqual(entries.map((entry) => entry.id), ["trg_user", "dec_dispatch", "dec_reply1", "trg_report", "dec_reply2"]);
  assert.deepEqual(entries.map((entry) => entry.kind), ["user", "event", "reply", "event", "reply"]);
  const dispatch = entries[1];
  assert.equal(dispatch.label, "派发 Worker");
  assert.equal(dispatch.detail, "修复登录页 · code");
  assert.equal(dispatch.live, true);
  const report = entries[3];
  assert.equal(report.text, "## 完成\n全部测试通过", "the full saved report wins over the truncated trigger text");
  assert.equal(report.markdown, true);
  assert.equal(report.live, false);
});

test("a report without its ticket drops the engine prefix", () => {
  const [entry] = buildChatEntries([trigger("t", 1, { kind: "report", sender: "worker:gone", text: 'Worker report for "x":\nbody' })], [], []);
  assert.equal(entry.text, "body");
  assert.equal(entry.detail, null);
  assert.equal(entry.ticketId, null);
});

test("message sources name IM senders and delegating agents, not manual input", () => {
  const entries = buildChatEntries([
    trigger("manual", 1),
    trigger("im", 2, { kind: "feishu", sender: "feishu:ou_1", origin: { channel: "feishu", chatId: "c", senderId: "ou_1", senderName: "张三" } }),
    trigger("agent", 3, { kind: "agent", sender: "agent:0123456789abcdef" }),
  ], [], []);
  assert.deepEqual(entries.map((entry) => entry.source), [null, "飞书 · 张三", "Agent 01234567 委派"]);
});

test("empty replies are skipped and failed evaluations surface their raw output", () => {
  const entries = buildChatEntries([], [
    decision("empty", 1, "reply", { reply: "  " }),
    decision("bad", 2, "unparsed", { raw: "not json" }),
    decision("ignored", 3, "ignore"),
  ], []);
  assert.deepEqual(entries.map((entry) => entry.id), ["bad", "ignored"]);
  assert.equal(entries[0].tone, "danger");
  assert.equal(entries[0].text, "not json");
  assert.equal(entries[1].text, null, "nothing to expand without a rationale");
});

test("delivery status under a message only appears when it is not the normal case", () => {
  const [pending, delivered, evaluated, filtered] = buildChatEntries([
    trigger("a", 1, { status: "pending" }),
    trigger("b", 2, { status: "delivered" }),
    trigger("c", 3),
    trigger("d", 4, { status: "filtered", note: "too long" }),
  ], [], []);
  assert.deepEqual(userStatusLabel(pending), { label: "等待 Router", tone: "warning" });
  assert.equal(userStatusLabel(delivered).label, "已直通 Worker");
  assert.equal(userStatusLabel(evaluated), null);
  assert.equal(userStatusLabel(filtered).label, "已过滤 · too long");
});
