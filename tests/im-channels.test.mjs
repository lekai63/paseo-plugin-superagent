import assert from "node:assert/strict";
import test from "node:test";
import { FeishuSource } from "../server/feishu.ts";
import { DingtalkSource } from "../server/dingtalk.ts";
import { QqSource } from "../server/qq.ts";
import { WecomSource } from "../server/wecom.ts";

const origin = { chatId: "chat", senderId: "user", messageId: "msg", replyRef: "https://invalid.test/webhook" };

test("Feishu delivery requires a successful business receipt for both reply and send", async () => {
  const source = new FeishuSource({ appId: "mock", appSecret: "mock", allowUsers: [], allowChats: [] });
  let code = 0;
  const sent = [];
  source.client = { im: { v1: { message: {
    reply: async (input) => { sent.push(input); return { code }; },
    create: async (input) => { sent.push(input); return { code }; },
  } } } };
  await source.send({ ...origin, channel: "feishu" }, "first");
  code = 400;
  await assert.rejects(source.send({ ...origin, channel: "feishu" }, "second"), /feishu reply rejected/);
  await assert.rejects(source.send({ ...origin, messageId: null, channel: "feishu" }, "third"), /feishu send rejected/);
  assert.equal(sent.length, 3);
});

test("Dingtalk HTTP success with a business error does not acknowledge a delivery", async (t) => {
  const source = new DingtalkSource({ clientId: "mock", clientSecret: "mock", allowUsers: [], allowChats: [] });
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let errcode = 0;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ errcode }) });
  await source.send({ ...origin, channel: "dingtalk" }, "first");
  errcode = 310000;
  await assert.rejects(source.send({ ...origin, channel: "dingtalk" }, "second"), /dingtalk reply rejected/);
});

test("Wecom sends independent parts to the chat without reusing a finished callback stream", async () => {
  const source = new WecomSource({ botId: "mock", secret: "mock", allowUsers: [], allowChats: [] });
  const sent = [];
  let errcode = 0;
  source.client = { sendMessage: async (...args) => { sent.push(args); return { errcode }; } };
  await source.send({ ...origin, channel: "wecom", replyRef: null }, "[1/2] first");
  await source.send({ ...origin, channel: "wecom", replyRef: null }, "[2/2] second");
  assert.deepEqual(sent, [
    ["chat", { msgtype: "markdown", markdown: { content: "[1/2] first" } }],
    ["chat", { msgtype: "markdown", markdown: { content: "[2/2] second" } }],
  ]);
  errcode = 400;
  await assert.rejects(source.send({ ...origin, channel: "wecom" }, "failed"), /wecom send rejected/);
});

// 群聊准入:未 @ 消息在观察模式下作上下文候选,否则经 onDrop 留痕(§3.1)。

const feishuEvent = (over = {}) => ({
  sender: { sender_id: { open_id: "ou_1" }, sender_type: "user" },
  message: {
    message_id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    chat_id: "oc_group",
    chat_type: "group",
    message_type: "text",
    content: JSON.stringify({ text: "群里闲聊,没有 @ 机器人" }),
    mentions: [],
    ...over,
  },
});

test("feishu group messages without a mention drop with a record, or become context in observe mode", async () => {
  const drops = [];
  const strict = new FeishuSource({ appId: "a", appSecret: "b", allowUsers: [], allowChats: ["oc_group"], observeGroups: false });
  assert.equal(await strict.translate(feishuEvent(), (drop) => drops.push(drop)), null);
  assert.equal(drops.length, 1);
  assert.equal(drops[0].reason, "群消息未 @ 机器人");
  assert.equal(drops[0].threadKey, "feishu:chat:oc_group");
  assert.ok(drops[0].text.includes("群里闲聊"));
  assert.equal(drops[0].origin.chatId, "oc_group");

  const observing = new FeishuSource({ appId: "a", appSecret: "b", allowUsers: [], allowChats: ["oc_group"], observeGroups: true });
  const observed = [];
  const inbound = await observing.translate(feishuEvent(), (drop) => observed.push(drop));
  assert.equal(observed.length, 0, "observe mode does not drop");
  assert.equal(inbound.context, true);
  assert.ok(inbound.text.includes("群里闲聊"));

  // 被 @ 的群消息与私聊行为不变:正常触发、非上下文。
  const mentioned = await observing.translate(
    feishuEvent({ content: JSON.stringify({ text: "@_user_1 帮我查一下" }), mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" } }] }),
    () => {},
  );
  assert.equal(mentioned.context, undefined);
  assert.equal(mentioned.text, "帮我查一下");
  const direct = await observing.translate(
    feishuEvent({ chat_type: "p2p" }),
    () => {},
  );
  assert.equal(direct.context, undefined);
});

test("qq group messages without a mention drop with a record, or become context in observe mode", () => {
  const drops = [];
  const strict = new QqSource({ endpoint: "ws://x", token: "", allowUsers: ["10001"], allowGroups: ["20001"], observeGroups: false });
  const groupEvent = {
    post_type: "message",
    message_type: "group",
    group_id: 20001,
    user_id: 10001,
    self_id: 99999,
    message_id: 7,
    message: [{ type: "text", data: { text: "没 @ 的群消息" } }],
    raw_message: "没 @ 的群消息",
  };
  assert.equal(strict.translate(groupEvent, (drop) => drops.push(drop)), null);
  assert.equal(drops.length, 1);
  assert.equal(drops[0].reason, "群消息未 @ 机器人");
  assert.equal(drops[0].threadKey, "qq:group:20001");
  assert.ok(drops[0].text.includes("没 @ 的群消息"));

  const observing = new QqSource({ endpoint: "ws://x", token: "", allowUsers: ["10001"], allowGroups: ["20001"], observeGroups: true });
  const observedDrops = [];
  const inbound = observing.translate(groupEvent, (drop) => observedDrops.push(drop));
  assert.equal(observedDrops.length, 0);
  assert.equal(inbound.context, true);
  assert.ok(inbound.text.includes("没 @ 的群消息"));
});
