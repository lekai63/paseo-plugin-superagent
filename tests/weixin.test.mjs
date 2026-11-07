import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseWeixinJson } from "../server/weixin-api.ts";
import { WeixinSource, extractWeixinText } from "../server/weixin.ts";
import { WeixinLogin, qrModules } from "../server/weixin-login.ts";
import { loadWeixinAccount, loadWeixinCursor, saveWeixinAccount, saveWeixinCursor } from "../server/weixin-store.ts";

const account = { botId: "bot1@im.bot", token: "secret-token", baseUrl: "https://ilink.test", userId: "owner@im.wechat", savedAt: "2026-11-06T00:00:00.000Z" };

const userMessage = (over = {}) => ({
  message_id: `${Math.floor(Math.random() * 1e9)}`,
  from_user_id: "owner@im.wechat",
  to_user_id: "bot1@im.bot",
  message_type: 1,
  message_state: 2,
  context_token: "ctx-1",
  item_list: [{ type: 1, text_item: { text: "帮我看下构建" } }],
  ...over,
});

/** fetch 替身:按路径分派;挂起的长轮询在 abort 时以 AbortError 结束。 */
function mockFetch(t, route) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    const result = await route(call, init.signal);
    return { ok: true, status: 200, text: async () => (typeof result === "string" ? result : JSON.stringify(result)) };
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

function hang(signal) {
  return new Promise((_, reject) => {
    const fail = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    if (signal?.aborted) fail();
    signal?.addEventListener("abort", fail, { once: true });
  });
}

async function until(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function tempHome(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "superagent-weixin-"));
  const previous = process.env.PASEO_HOME;
  process.env.PASEO_HOME = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previous;
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test("iLink JSON keeps uint64 message ids exact without touching string content", () => {
  const parsed = parseWeixinJson('{"ret":0,"message_id": 18446744073709551615,"msgs":[{"item_list":[{"msg_id":9007199254740993,"text_item":{"text":"{\\"message_id\\":1}"}}]}]}');
  assert.equal(parsed.message_id, "18446744073709551615");
  assert.equal(parsed.msgs[0].item_list[0].msg_id, "9007199254740993");
  assert.equal(parsed.msgs[0].item_list[0].text_item.text, '{"message_id":1}');
  assert.equal(parsed.ret, 0);
});

test("weixin private messages from the allowlist become triggers with their context token", () => {
  const source = new WeixinSource({ account, allowUsers: ["owner@im.wechat"] });
  const inbound = source.translate(userMessage({ message_id: "100" }));
  assert.equal(inbound.threadKey, "weixin:user:owner@im.wechat");
  assert.equal(inbound.text, "帮我看下构建");
  assert.equal(inbound.sender, "weixin:owner@im.wechat");
  assert.deepEqual(inbound.origin, {
    channel: "weixin", chatId: "owner@im.wechat", messageId: "100", replyRef: "ctx-1", senderId: "owner@im.wechat", senderName: null,
  });
  assert.equal(source.translate(userMessage({ message_id: "100" })), null, "duplicate deliveries are ignored");
  assert.equal(source.translate(userMessage({ from_user_id: "stranger@im.wechat" })), null, "strangers are rejected");
  assert.equal(source.translate(userMessage({ message_type: 2 })), null, "bot echoes are ignored");
  assert.equal(source.translate(userMessage({ item_list: [{ type: 2, image_item: {} }] })), null, "media-only messages carry no text");
});

test("weixin voice transcripts and quotes are kept; group messages leave a filtered record only", () => {
  assert.deepEqual(
    extractWeixinText([
      { type: 3, voice_item: { text: "语音转写" } },
      { type: 1, text_item: { text: "补充" }, ref_msg: { svr_id: "777", title: "原消息" } },
    ]),
    { text: "语音转写\n补充", replyTo: ["777"] },
  );
  const drops = [];
  const source = new WeixinSource({ account, allowUsers: ["owner@im.wechat"] });
  assert.equal(source.translate(userMessage({ group_id: "g1", context_token: "group-ctx" }), (drop) => drops.push(drop)), null);
  assert.equal(drops.length, 1);
  assert.equal(drops[0].reason, "微信群消息暂不支持");
  assert.equal(drops[0].threadKey, "weixin:group:g1");
  assert.equal(source.contextTokens.has("owner@im.wechat"), false, "a group token must never answer a private chat");
});

test("weixin replies carry the newest context token and fail on a business error", async (t) => {
  const calls = mockFetch(t, (call) => (call.body.msg.item_list[0].text_item.text === "fail" ? { ret: -2, errmsg: "bad" } : '{"ret":0,"message_id":18446744073709551615}'));
  const source = new WeixinSource({ account, allowUsers: ["owner@im.wechat"] });
  const origin = { channel: "weixin", chatId: "owner@im.wechat", senderId: "owner@im.wechat", messageId: "1", replyRef: "stored-ctx" };

  assert.equal(await source.send(origin, "hi"), "18446744073709551615");
  assert.equal(calls[0].body.msg.context_token, "stored-ctx", "falls back to the token saved with the trigger");
  source.translate(userMessage({ message_id: "2", context_token: "fresh-ctx" }));
  await source.send(origin, "again");
  const [, second] = calls;
  assert.equal(second.url, "https://ilink.test/ilink/bot/sendmessage");
  assert.equal(second.headers.Authorization, "Bearer secret-token");
  assert.equal(second.headers.AuthorizationType, "ilink_bot_token");
  assert.equal(second.headers["iLink-App-Id"], "bot");
  assert.match(second.headers["X-WECHAT-UIN"], /^[A-Za-z0-9+/=]+$/);
  assert.equal(second.body.msg.context_token, "fresh-ctx");
  assert.equal(second.body.msg.to_user_id, "owner@im.wechat");
  assert.equal(second.body.msg.message_type, 2);
  assert.equal(second.body.msg.message_state, 2);
  assert.ok(second.body.base_info.channel_version);
  await assert.rejects(source.send(origin, "fail"), /weixin send rejected \(-2\)/);
});

test("weixin long-poll dispatches messages, persists the cursor and resumes from it", async (t) => {
  await tempHome(t);
  let polls = 0;
  const calls = mockFetch(t, (call, signal) => {
    if (call.url.endsWith("getupdates")) {
      polls += 1;
      if (polls === 1) return { ret: 0, msgs: [userMessage({ message_id: "500" })], get_updates_buf: "cursor-1" };
      return hang(signal);
    }
    return { ret: 0 };
  });
  const triggers = [];
  const source = new WeixinSource({ account, allowUsers: ["owner@im.wechat"] });
  await source.start((message) => triggers.push(message));
  await until(() => polls >= 2);
  assert.equal(triggers.length, 1);
  assert.equal(triggers[0].origin.messageId, "500");
  assert.equal(source.status().state, "polling");
  await source.stop();
  assert.equal(source.status().state, "stopped");
  assert.equal(await loadWeixinCursor(account.botId), "cursor-1");
  assert.equal(await loadWeixinCursor("another@im.bot"), "", "cursors belong to one bot");
  assert.ok(calls.some((call) => call.url.endsWith("msg/notifystart")));
  assert.ok(calls.some((call) => call.url.endsWith("msg/notifystop")));

  const resumed = new WeixinSource({ account, allowUsers: ["owner@im.wechat"] });
  await resumed.start(() => {});
  await until(() => polls >= 3);
  await resumed.stop();
  const lastPoll = calls.filter((call) => call.url.endsWith("getupdates")).at(-1);
  assert.equal(lastPoll.body.get_updates_buf, "cursor-1");
});

test("a stale weixin token pauses polling instead of hammering the server", async (t) => {
  await tempHome(t);
  let polls = 0;
  mockFetch(t, (call) => {
    if (call.url.endsWith("getupdates")) { polls += 1; return { ret: -14, errmsg: "session timeout" }; }
    return { ret: 0 };
  });
  const source = new WeixinSource({ account, allowUsers: ["owner@im.wechat"] });
  await source.start(() => {});
  await until(() => source.status().state === "paused");
  assert.ok(source.status().pausedUntil);
  assert.match(source.status().lastError, /重新扫码/);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(polls, 1);
  await source.stop();
});

test("weixin credentials stay private on disk and a new bot drops the old cursor", async (t) => {
  const home = await tempHome(t);
  await saveWeixinAccount(account);
  await saveWeixinCursor(account.botId, "cursor-a");
  const file = path.join(home, "plugin-data", "superagent", "weixin", "account.json");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await loadWeixinAccount(), account);
  await saveWeixinAccount({ ...account, botId: "bot2@im.bot" });
  assert.equal(await loadWeixinCursor("bot2@im.bot"), "");
  assert.equal(await loadWeixinCursor(account.botId), "");
  assert.match(await readFile(file, "utf-8"), /bot2@im\.bot/);
});

test("qr matrix is a square grid of modules", () => {
  const rows = qrModules("https://liteapp.weixin.qq.com/q/abc?qrcode=0123456789abcdef&bot_type=3");
  assert.ok(rows.length >= 21);
  assert.ok(rows.every((row) => row.length === rows.length && /^[01]+$/.test(row)));
  assert.equal(rows[0].slice(0, 7), "1111111", "finder pattern in the corner");
});

test("weixin QR login handles the verify code and saves the confirmed account", async (t) => {
  const statuses = [];
  const calls = mockFetch(t, (call) => {
    if (call.url.includes("get_bot_qrcode")) return { qrcode: "qr-1", qrcode_img_content: "https://liteapp.weixin.qq.com/q/one" };
    if (call.url.includes("get_qrcode_status")) {
      const next = statuses.shift() ?? { status: "wait" };
      return typeof next === "function" ? next(call) : next;
    }
    return {};
  });
  const confirmed = [];
  const login = new WeixinLogin({
    loadAccount: async () => null,
    onConfirmed: async (saved) => { confirmed.push(saved); },
  }, 0);

  statuses.push({ status: "need_verifycode" });
  const started = await login.start();
  assert.equal(started.qrUrl, "https://liteapp.weixin.qq.com/q/one");
  assert.ok(started.qrModules.length >= 21);
  assert.equal(calls[0].method, "POST");
  assert.deepEqual(calls[0].body, { local_token_list: [] });
  await until(() => login.snapshot().phase === "need_verify");

  statuses.push(
    (call) => {
      assert.match(call.url, /verify_code=4321/);
      return { status: "scaned" };
    },
    { status: "confirmed", bot_token: "new-token", ilink_bot_id: "bot9@im.bot", baseurl: "https://idc.ilink.test", ilink_user_id: "owner@im.wechat" },
  );
  assert.equal(login.verify("4321").phase, "verifying");
  await until(() => login.snapshot().phase === "confirmed");
  assert.equal(confirmed.length, 1);
  assert.deepEqual({ ...confirmed[0], savedAt: "x" }, {
    botId: "bot9@im.bot", token: "new-token", baseUrl: "https://idc.ilink.test", userId: "owner@im.wechat", savedAt: "x",
  });
  assert.equal(login.snapshot().qrModules, null, "the QR is withdrawn once login finishes");
  assert.ok(!JSON.stringify(login.snapshot()).includes("new-token"), "the token never reaches the snapshot");
});

test("weixin QR login refreshes an expired code, then gives up after three codes", async (t) => {
  let issued = 0;
  mockFetch(t, (call) => {
    if (call.url.includes("get_bot_qrcode")) { issued += 1; return { qrcode: `qr-${issued}`, qrcode_img_content: `https://liteapp.weixin.qq.com/q/${issued}` }; }
    return { status: "expired" };
  });
  const login = new WeixinLogin({ loadAccount: async () => account, onConfirmed: async () => {} }, 0);
  await login.start();
  await until(() => login.snapshot().phase === "failed");
  assert.equal(issued, 3);
  assert.match(login.snapshot().message, /多次失效/);
});

test("cancelling a weixin QR login stops polling", async (t) => {
  let polls = 0;
  mockFetch(t, (call, signal) => {
    if (call.url.includes("get_bot_qrcode")) return { qrcode: "qr", qrcode_img_content: "https://liteapp.weixin.qq.com/q/x" };
    polls += 1;
    return hang(signal);
  });
  const login = new WeixinLogin({ loadAccount: async () => null, onConfirmed: async () => {} }, 0);
  await login.start();
  await until(() => polls === 1);
  assert.equal(login.cancel().phase, "idle");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(polls, 1);
});
