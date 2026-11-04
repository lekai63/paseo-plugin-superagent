import assert from "node:assert/strict";
import test from "node:test";
import {
  closeChatTab, defaultChatTabs, entryChatTab, MAX_CHAT_TABS, openChatTab, pruneChatTabs,
} from "../shared/chat-tabs.ts";
import { parseUiBaseFontSize, resolveUiFontSize, scaleFontSize } from "../shared/host-font.ts";

test("opening a conversation appends one tab and remembers it as the last viewed", () => {
  const empty = { open: [], last: null };
  const one = openChatTab(empty, "a");
  assert.deepEqual(one, { open: ["a"], last: "a" });
  const two = openChatTab(one, "b");
  assert.deepEqual(two, { open: ["a", "b"], last: "b" });
  assert.deepEqual(openChatTab(two, "a"), { open: ["a", "b"], last: "a" });
  assert.equal(openChatTab(two, "b"), two, "re-opening the current tab changes nothing");
  // 发送期间已切走:只加标签,不改最后查看。
  assert.deepEqual(openChatTab(two, "c", false), { open: ["a", "b", "c"], last: "b" });
});

test("the tab bar is capped by dropping the oldest tab that is neither new nor last viewed", () => {
  let tabs = { open: [], last: null };
  for (let i = 0; i < MAX_CHAT_TABS; i++) tabs = openChatTab(tabs, `t${i}`);
  tabs = openChatTab(tabs, "t0");
  const next = openChatTab(tabs, "new", false);
  assert.equal(next.open.length, MAX_CHAT_TABS);
  assert.ok(next.open.includes("t0"), "the last viewed tab is kept");
  assert.ok(!next.open.includes("t1"));
  assert.equal(next.open.at(-1), "new");
});

test("closing the current tab moves to its right neighbour, then left, then a new conversation", () => {
  const tabs = { open: ["a", "b", "c"], last: "b" };
  assert.deepEqual(closeChatTab(tabs, "b", "b"), { tabs: { open: ["a", "c"], last: "c" }, next: "c" });
  assert.deepEqual(closeChatTab(tabs, "c", "c"), { tabs: { open: ["a", "b"], last: "b" }, next: "b" });
  assert.deepEqual(closeChatTab({ open: ["a"], last: "a" }, "a", "a"), { tabs: { open: [], last: null }, next: null });
  // 关的不是当前标签:停在当前。
  assert.deepEqual(closeChatTab(tabs, "a", "b"), { tabs: { open: ["b", "c"], last: "b" }, next: "b" });
  // 当前对话不在标签里(找不到的线程):回到最后一个标签。
  assert.deepEqual(closeChatTab(tabs, "gone", "gone").next, "c");
});

test("entering the screen resumes the last viewed conversation instead of a new one", () => {
  assert.equal(entryChatTab({ open: ["a", "b"], last: "a" }), "a");
  assert.equal(entryChatTab({ open: ["a", "b"], last: "removed" }), "b");
  assert.equal(entryChatTab({ open: [], last: null }), null);
});

test("pruning drops tabs whose threads were cleaned up", () => {
  const tabs = { open: ["a", "b"], last: "b" };
  assert.equal(pruneChatTabs(tabs, new Set(["a", "b"])), tabs);
  assert.deepEqual(pruneChatTabs(tabs, new Set(["a"])), { open: ["a"], last: null });
});

test("initial tabs are recent open conversations started from the UI, not IM or agent delegations", () => {
  const thread = (id, createdAt, updatedAt, state = "active") => ({ id, state, createdAt, updatedAt });
  const now = Date.parse("2026-01-10T00:00:00Z");
  const trigger = (threadId, kind, sender, receivedAt) => ({ threadId, kind, sender, receivedAt });
  const threads = [
    thread("ui-1", "2026-01-01", "2026-01-05"), thread("ui-2", "2026-01-02", "2026-01-03"),
    thread("closed", "2026-01-03", "2026-01-09", "closed"), thread("im", "2026-01-04", "2026-01-09"),
    thread("agent", "2026-01-05", "2026-01-09"),
  ];
  const triggers = [
    trigger("ui-1", "manual", "user", "2026-01-01"), trigger("ui-1", "report", "worker:t", "2026-01-04"),
    trigger("ui-2", "manual", "user", "2026-01-02"), trigger("closed", "manual", "user", "2026-01-03"),
    trigger("im", "feishu", "ou_x", "2026-01-04"), trigger("agent", "manual", "agent:abc", "2026-01-05"),
  ];
  // 日期都在 now 之前 5 天以上:全部过旧。
  assert.deepEqual(defaultChatTabs(threads, triggers, now), { open: [], last: null });
  assert.deepEqual(defaultChatTabs(threads, triggers, Date.parse("2026-01-05T12:00:00Z")), { open: ["ui-1"], last: "ui-1" });
  assert.deepEqual(defaultChatTabs(threads, triggers, Date.parse("2026-01-04T00:00:00Z")), { open: ["ui-1", "ui-2"], last: "ui-1" });
  assert.deepEqual(defaultChatTabs([], [], now), { open: [], last: null });
});

test("initial tabs keep only the few most recently active conversations, in the order they were started", () => {
  const now = Date.parse("2026-01-10T12:00:00Z");
  const threads = [1, 2, 3, 4, 5, 6].map((n) => ({
    id: `t${n}`, state: "active", createdAt: `2026-01-10T0${n}:00:00Z`, updatedAt: `2026-01-10T${String(12 - n).padStart(2, "0")}:00:00Z`,
  }));
  const triggers = threads.map((thread) => ({ threadId: thread.id, kind: "manual", sender: "user", receivedAt: thread.createdAt }));
  // 最近更新的是 t1(11:00)… t4(08:00);t5、t6 被上限挤掉。
  assert.deepEqual(defaultChatTabs(threads, triggers, now), { open: ["t1", "t2", "t3", "t4"], last: "t1" });
});

test("the count font follows Paseo's interface size like the host's own type ramp", () => {
  assert.equal(parseUiBaseFontSize(JSON.stringify({ uiBaseFontSize: 16 })), 16);
  assert.equal(parseUiBaseFontSize(JSON.stringify({ uiBaseFontSize: "17.9" })), 17);
  assert.equal(parseUiBaseFontSize(JSON.stringify({ uiBaseFontSize: 40 })), 21);
  assert.equal(parseUiBaseFontSize(JSON.stringify({ uiBaseFontSize: 2 })), 10);
  assert.equal(parseUiBaseFontSize("not json"), null);
  assert.equal(parseUiBaseFontSize(JSON.stringify([16])), null);
  assert.equal(parseUiBaseFontSize(null), null);
  // 当前键缺失或损坏时用旧键,都没有时用平台默认(Web 14,原生 15)。
  assert.equal(resolveUiFontSize("{bad", JSON.stringify({ uiBaseFontSize: 18 }), "web"), 18);
  assert.equal(resolveUiFontSize(null, null, "web"), 14);
  assert.equal(resolveUiFontSize(null, null, "ios"), 15);
  assert.equal(scaleFontSize(12, 14), 12);
  assert.equal(scaleFontSize(12, 15), 13);
  assert.equal(scaleFontSize(12, 18), 15);
});
