import assert from "node:assert/strict";
import test from "node:test";
import { FeishuSource } from "../server/feishu.ts";
import { DingtalkSource } from "../server/dingtalk.ts";
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
