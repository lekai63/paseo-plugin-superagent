import assert from "node:assert/strict";
import test from "node:test";
import * as labels from "../shared/labels.ts";
import { translator } from "../shared/i18n.ts";

// 既有断言按简体中文书写;英文见 i18n.test.mjs。
const zh = translator("zh-CN");
const { markdownPreview, triggerSenderLabel } = labels;
const relativeTime = (iso, now) => labels.relativeTime(iso, zh, now);
const threadStatus = (thread, tickets, decisions) => labels.threadStatus(thread, tickets, decisions, zh);
const watchdogNoteLabel = (note) => labels.watchdogNoteLabel(note, zh);
import { NUMBER_LIMITS, SETTINGS_DEFAULTS, superagentSettings } from "../shared/settings.ts";

const active = { state: "active", pendingTriggers: 0 };
const at = (minute) => `2026-01-01T00:${String(minute).padStart(2, "0")}:00.000Z`;

test("thread status puts what needs attention first", () => {
  assert.deepEqual(threadStatus({ state: "closed", pendingTriggers: 3 }, [{ status: "running", updatedAt: at(1) }], []), {
    label: "已关闭",
    tone: "muted",
  });
  assert.equal(threadStatus({ ...active, pendingTriggers: 2 }, [{ status: "running", updatedAt: at(1) }], []).label, "运行中");
  assert.equal(threadStatus({ ...active, pendingTriggers: 2 }, [{ status: "completed", updatedAt: at(1) }], []).label, "待评估");
  assert.deepEqual(threadStatus(active, [{ status: "waiting", updatedAt: at(1) }], []), { label: "待命", tone: "muted" });
  assert.deepEqual(threadStatus(active, [], [{ outcome: "reply", createdAt: at(1) }]), { label: "已答复", tone: "success" });
  assert.deepEqual(threadStatus(active, [], []), { label: "空闲", tone: "muted" });
});

test("a failed Router evaluation only shows when it is newer than the latest ticket", () => {
  const tickets = [
    { status: "failed", updatedAt: at(1) },
    { status: "completed", updatedAt: at(5) },
  ];
  assert.deepEqual(threadStatus(active, tickets, [{ outcome: "unparsed", createdAt: at(9) }]), {
    label: "评估失败",
    tone: "danger",
  });
  assert.deepEqual(threadStatus(active, tickets, [{ outcome: "error", createdAt: at(3) }]), {
    label: "已完成",
    tone: "success",
  });
});

test("sender labels skip redundant senders and prefer IM nicknames", () => {
  assert.equal(triggerSenderLabel({ sender: "user" }), null);
  assert.equal(triggerSenderLabel({ sender: "worker:tk_1" }), null);
  assert.equal(triggerSenderLabel({ sender: "agent:abcdef1234567890" }), "Agent abcdef12");
  assert.equal(triggerSenderLabel({ sender: "qq:10001" }), "10001");
  assert.equal(triggerSenderLabel({ sender: "feishu:ou_x", origin: { senderName: "Alice" } }), "Alice");
});

test("relative time reads naturally in Chinese", () => {
  const now = Date.parse("2026-03-10T12:00:00.000Z");
  assert.equal(relativeTime("2026-03-10T11:59:30.000Z", now), "刚刚");
  assert.equal(relativeTime("2026-03-10T11:55:00.000Z", now), "5 分钟前");
  assert.equal(relativeTime("2026-03-10T09:00:00.000Z", now), "3 小时前");
  assert.equal(relativeTime("2026-03-08T12:00:00.000Z", now), "2 天前");
  assert.match(relativeTime("2026-01-02T12:00:00.000Z", now), /^1月2日$/);
  assert.match(relativeTime("2025-01-02T12:00:00.000Z", now), /^2025年1月2日$/);
  assert.equal(relativeTime("not a date", now), "");
});

test("markdown previews read as prose", () => {
  assert.equal(
    markdownPreview("## 依赖升级清单\n\n- **react** 19.1 → 19.2\n- 见 `package.json` 与 [说明](https://x)"),
    "依赖升级清单\n\n- react 19.1 → 19.2\n- 见 package.json 与 说明",
  );
  assert.equal(markdownPreview("```ts\nconst a = 1;\n```"), "const a = 1;");
});

test("watchdog notes are translated", () => {
  assert.equal(watchdogNoteLabel(null), "一切正常");
  assert.equal(watchdogNoteLabel("reconciled 2 item(s)"), "已自动修复 2 项");
});

test("number limits drive the settings schema", () => {
  for (const [key, { min, max }] of Object.entries(NUMBER_LIMITS)) {
    const valid = (value) => superagentSettings.schema.safeParse({ ...SETTINGS_DEFAULTS, [key]: value }).success;
    assert.ok(valid(min) && valid(max), `${key} accepts its bounds`);
    assert.ok(!valid(min - 1) && !valid(max + 1), `${key} rejects values outside its bounds`);
  }
  assert.equal(SETTINGS_DEFAULTS.workerTimeoutMin, 120);
  assert.equal(SETTINGS_DEFAULTS.evalBatchMs, 1500);
});
