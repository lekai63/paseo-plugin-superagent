import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import {
  downloadBuffer,
  fileNameFromDisposition,
  InboundQueue,
  readStream,
  saveAttachments,
} from "../server/im-attachments.ts";
import { FeishuSource, parseFeishuContent } from "../server/feishu.ts";
import { DingtalkSource, parseDingtalkMessage } from "../server/dingtalk.ts";
import { WecomSource, decryptWecomFile, parseWecomContent } from "../server/wecom.ts";
import { zipOf } from "./zip-fixture.mjs";

async function tempInbox(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "superagent-im-inbox-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** fetch 替身:route 返回 Response(或 undefined 表示 404);记录每次调用。 */
function mockFetch(t, route) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    return (await route(call, init.signal)) ?? new Response("not found", { status: 404 });
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

const savedPath = (line) => line.split("已保存到本机:")[1]?.split("\n")[0];

// ---- 通用 ----

test("content-disposition file names: RFC 5987 first, then quoted or bare", () => {
  assert.equal(fileNameFromDisposition("attachment; filename*=UTF-8''%E5%8F%91%E7%A5%A8.pdf; filename=\"x.pdf\""), "发票.pdf");
  assert.equal(fileNameFromDisposition('attachment; filename="report 2026.xlsx"'), "report 2026.xlsx");
  assert.equal(fileNameFromDisposition("attachment; filename=a.zip"), "a.zip");
  assert.equal(fileNameFromDisposition("inline"), undefined);
  assert.equal(fileNameFromDisposition(null), undefined);
});

test("downloads stream with a size cap, a timeout and a labelled HTTP error", async (t) => {
  mockFetch(t, (call, signal) => {
    if (call.url.endsWith("/ok")) return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-disposition": "attachment; filename=a.bin" } });
    if (call.url.endsWith("/big")) return new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(1024)); } }));
    if (call.url.endsWith("/hang")) {
      // 与真实 fetch 一致:已取消的信号立即失败,否则等到取消。
      return new Promise((_, reject) => {
        const fail = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        if (signal.aborted) return fail();
        signal.addEventListener("abort", fail, { once: true });
      });
    }
    return new Response("x", { status: 500 });
  });
  const ok = await downloadBuffer("https://x.test/ok");
  assert.deepEqual([...ok.data], [1, 2, 3]);
  assert.equal(ok.headers.get("content-disposition"), "attachment; filename=a.bin");
  await assert.rejects(downloadBuffer("https://x.test/big", { maxBytes: 4096 }), /超过 100\.0 MB 上限/);
  await assert.rejects(downloadBuffer("https://x.test/hang", { timeoutMs: 20 }), /下载超时/);
  await assert.rejects(downloadBuffer("https://x.test/fail", { label: "CDN " }), /^Error: CDN 下载失败:HTTP 500$/);
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(downloadBuffer("https://x.test/hang", { signal: cancelled.signal }), /下载被取消/);
});

test("SDK streams are read with the same cap", async () => {
  assert.equal((await readStream(Readable.from([Buffer.from("ab"), Buffer.from("cd")]))).toString(), "abcd");
  await assert.rejects(readStream(Readable.from([Buffer.alloc(10), Buffer.alloc(10)]), { maxBytes: 15 }), /上限/);
});

test("saved attachments get sniffed names, archive listings and per-item failures", async (t) => {
  const inbox = await tempInbox(t);
  const ogg = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(20)]);
  const zip = zipOf([{ name: "a.pdf", size: 10 }]);
  const saved = await saveAttachments("feishu", "om_1", [
    { kind: "audio", quoted: false, download: async () => ({ data: ogg }) },
    { kind: "file", quoted: false, download: async () => ({ data: zip, fileName: "批量.zip" }) },
    { kind: "file", fileName: "x.pdf", quoted: true, download: async () => { throw new Error("boom"); } },
  ], { inboxDir: inbox });
  assert.match(saved[0].path, new RegExp(`^${inbox}/feishu/\\d{4}-\\d{2}-\\d{2}/om_1/audio-1\\.ogg$`));
  assert.equal(saved[1].name, "批量.zip", "the server-provided name is used when the message has none");
  assert.deepEqual(saved[1].details, ["  zip 压缩包内 1 个文件,解压后共 10 B:", "  - a.pdf(10 B)"]);
  assert.deepEqual({ ...saved[2], details: undefined }, { kind: "file", quoted: true, name: "x.pdf", path: null, bytes: null, error: "boom", details: undefined });
});

test("the inbound queue keeps arrival order while downloads take time", async () => {
  const queue = new InboundQueue("feishu");
  const order = [];
  void queue.push(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); order.push("slow file"); });
  void queue.push(async () => { throw new Error("one bad message does not stall the queue"); });
  await queue.push(async () => { order.push("quick text"); });
  assert.deepEqual(order, ["slow file", "quick text"]);
});

// ---- 飞书 ----

test("feishu content: post text, links, code and media; files, audio, video; notes for the rest", () => {
  const post = parseFeishuContent("post", JSON.stringify({
    title: "报销",
    content: [
      [{ tag: "at", user_id: "@_user_1" }, { tag: "text", text: " 看下 " }, { tag: "a", text: "单据", href: "https://x.test/d" }],
      [{ tag: "img", image_key: "img_1" }, { tag: "emotion", emoji_type: "SMILE" }],
      [{ tag: "code_block", language: "PYTHON", text: "print(1)" }],
      [{ tag: "media", file_key: "file_v", image_key: "img_cover" }],
    ],
  }));
  assert.equal(post.text, "报销\n@_user_1 看下 单据(https://x.test/d)\n```python\nprint(1)\n```");
  assert.deepEqual(post.resources, [{ kind: "image", key: "img_1", type: "image" }, { kind: "video", key: "file_v", type: "file" }]);
  assert.equal(parseFeishuContent("post", JSON.stringify({ zh_cn: { title: "", content: [[{ tag: "text", text: "多语言包一层" }]] } })).text, "多语言包一层");

  assert.deepEqual(parseFeishuContent("image", '{"image_key":"img_2"}').resources, [{ kind: "image", key: "img_2", type: "image" }]);
  assert.deepEqual(parseFeishuContent("file", '{"file_key":"file_1","file_name":"发票.zip"}').resources, [{ kind: "file", key: "file_1", type: "file", fileName: "发票.zip" }]);
  assert.deepEqual(parseFeishuContent("audio", '{"file_key":"file_a","duration":3000}').resources, [{ kind: "audio", key: "file_a", type: "file" }]);
  assert.deepEqual(parseFeishuContent("media", '{"file_key":"file_m","image_key":"img_c","file_name":"a.mp4"}').resources, [{ kind: "video", key: "file_m", type: "file", fileName: "a.mp4" }]);
  assert.equal(parseFeishuContent("sticker", '{"file_key":"s"}').ignore, true);
  assert.equal(parseFeishuContent("location", '{"name":"杭州东站","latitude":"30.29","longitude":"120.21"}').note, "[飞书位置] 杭州东站");
  assert.equal(parseFeishuContent("folder", '{"file_key":"f","file_name":"三月"}').note, "[飞书文件夹] 三月(文件夹无法下载,请打包成压缩包再发)");
  assert.equal(parseFeishuContent("vote", "{}").note, "[飞书vote消息,暂不支持读取内容]");
  assert.equal(parseFeishuContent("text", "not json").note, "[飞书text消息,内容无法解析]");
});

const feishuEvent = (message, sender = "ou_1") => ({
  sender: { sender_id: { open_id: sender }, sender_type: "user" },
  message: { message_id: `om_${Math.random().toString(36).slice(2, 10)}`, chat_id: "oc_p2p", chat_type: "p2p", mentions: [], ...message },
});

/** 飞书 client 替身:资源按 file_key 给内容(可带 Content-Disposition),message.get 按 id 给 items。 */
function fakeFeishuClient({ resources = {}, messages = {} }) {
  const downloads = [];
  const lookups = [];
  return {
    downloads,
    lookups,
    im: { v1: {
      messageResource: { get: async (payload) => {
        downloads.push(payload);
        const entry = resources[payload.path.file_key];
        if (!entry) throw new Error("Request failed with status code 400");
        const { data, disposition } = Buffer.isBuffer(entry) ? { data: entry } : entry;
        return { getReadableStream: () => Readable.from([data]), headers: disposition ? { "content-disposition": disposition } : {} };
      } },
      message: { get: async (payload) => {
        lookups.push(payload.path.message_id);
        const items = messages[payload.path.message_id];
        return items ? { code: 0, data: { items } } : { code: 230002, msg: "not found" };
      } },
    } },
  };
}

test("feishu private files, images in posts and audio are downloaded into the inbox", async (t) => {
  const inbox = await tempInbox(t);
  const source = new FeishuSource({ appId: "a", appSecret: "b", allowUsers: ["ou_1"], allowChats: ["oc_g"], observeGroups: false, inboxDir: () => inbox });
  const client = fakeFeishuClient({ resources: {
    file_1: { data: Buffer.from("%PDF-1.7"), disposition: 'attachment; filename="file_v3_00ab"' },
    img_1: Buffer.from([0xff, 0xd8, 0xff, 0x00]),
    file_a: { data: Buffer.from("OggS...."), disposition: 'attachment; filename="file_v3_00cd"' },
  } });
  source.client = client;

  const file = await source.translate(feishuEvent({ message_id: "om_file", message_type: "file", content: '{"file_key":"file_1","file_name":"发票.pdf"}' }));
  assert.deepEqual(client.downloads[0], { path: { message_id: "om_file", file_key: "file_1" }, params: { type: "file" } });
  assert.match(file.text, /^\[飞书文件\] 发票\.pdf\(8 B\)已保存到本机:/);
  assert.equal(file.title, "飞书私聊 [飞书文件] 发票.pdf");
  assert.deepEqual(await readFile(savedPath(file.text)), Buffer.from("%PDF-1.7"));

  const post = await source.translate(feishuEvent({
    message_id: "om_post", chat_id: "oc_g", chat_type: "group",
    message_type: "post",
    content: JSON.stringify({ title: "", content: [[{ tag: "at", user_id: "@_user_1" }, { tag: "text", text: " 识别这张发票" }], [{ tag: "img", image_key: "img_1" }]] }),
    mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" } }],
  }));
  assert.equal(client.downloads[1].params.type, "image");
  const [line1, line2] = post.text.split("\n");
  assert.equal(line1, "识别这张发票");
  assert.match(line2, /^\[飞书图片\] image-1\.jpg\(4 B\)已保存到本机:.*\/feishu\/.*\/om_post\/image-1\.jpg$/);

  const audio = await source.translate(feishuEvent({ message_type: "audio", content: '{"file_key":"file_a","duration":2000}' }));
  assert.match(audio.text, /^\[飞书语音\] file_v3_00cd\.ogg\(/, "a served name without an extension gets the sniffed one");

  const broken = await source.translate(feishuEvent({ message_type: "file", content: '{"file_key":"gone","file_name":"x.xlsx"}' }));
  assert.equal(broken.text, "[飞书文件] x.xlsx 下载失败:Request failed with status code 400,请让用户重新发送");
  assert.equal(await source.translate(feishuEvent({ message_type: "sticker", content: '{"file_key":"s"}' })), null, "stickers are not worth a Router turn");
});

test("feishu group attachments without a mention are described, never downloaded", async () => {
  const drops = [];
  const strict = new FeishuSource({ appId: "a", appSecret: "b", allowUsers: [], allowChats: ["oc_g"], observeGroups: false });
  strict.client = fakeFeishuClient({});
  const event = feishuEvent({ chat_id: "oc_g", chat_type: "group", message_type: "file", content: '{"file_key":"f","file_name":"群文件.pdf"}' }, "ou_9");
  assert.equal(await strict.translate(event, (drop) => drops.push(drop)), null);
  assert.equal(drops[0].text, "[飞书文件] 群文件.pdf");

  const observing = new FeishuSource({ appId: "a", appSecret: "b", allowUsers: [], allowChats: ["oc_g"], observeGroups: true });
  observing.client = fakeFeishuClient({});
  const context = await observing.translate(feishuEvent({ chat_id: "oc_g", chat_type: "group", message_type: "image", content: '{"image_key":"i"}' }, "ou_9"));
  assert.equal(context.context, true);
  assert.equal(context.text, "[飞书图片]");
  assert.equal(strict.client.downloads.length + observing.client.downloads.length, 0);
});

test("feishu replies to a file download the quoted file; merge-forwards list their messages", async (t) => {
  const inbox = await tempInbox(t);
  const source = new FeishuSource({ appId: "a", appSecret: "b", allowUsers: ["ou_1"], allowChats: [], observeGroups: false, inboxDir: () => inbox });
  source.client = fakeFeishuClient({
    resources: { file_q: Buffer.from("quoted") },
    messages: {
      om_parent: [{ message_id: "om_parent", msg_type: "file", body: { content: '{"file_key":"file_q","file_name":"台账.xlsx"}' } }],
      om_text_parent: [{ message_id: "om_text_parent", msg_type: "text", body: { content: '{"text":"hi"}' } }],
      om_mf: [
        { message_id: "om_mf", msg_type: "merge_forward", body: { content: "Merged and Forwarded Message" } },
        { message_id: "om_c1", upper_message_id: "om_mf", msg_type: "text", body: { content: '{"text":"第一条\\n换行"}' } },
        { message_id: "om_c2", upper_message_id: "om_mf", msg_type: "image", body: { content: '{"image_key":"img_x"}' } },
        { message_id: "om_c3", upper_message_id: "om_mf", msg_type: "sticker", body: { content: '{"file_key":"s"}' } },
      ],
    },
  });

  const reply = await source.translate(feishuEvent({ message_type: "text", content: '{"text":"把这个做成台账"}', parent_id: "om_parent", root_id: "om_parent" }));
  assert.deepEqual(source.client.downloads.at(-1).path, { message_id: "om_parent", file_key: "file_q" }, "downloads with the quoted message id");
  assert.match(reply.text, /^把这个做成台账\n\[引用的飞书文件\] 台账\.xlsx\(6 B\)已保存到本机:/);
  assert.deepEqual(reply.replyTo, ["om_parent"]);

  const plainReply = await source.translate(feishuEvent({ message_type: "text", content: '{"text":"好的"}', parent_id: "om_text_parent" }));
  assert.equal(plainReply.text, "好的");

  const merged = await source.translate(feishuEvent({ message_id: "om_mf", message_type: "merge_forward", content: '"Merged and Forwarded Message"' }));
  assert.deepEqual(merged.text.split("\n"), [
    "[飞书合并转发] 共 3 条消息:",
    "  - 第一条 换行",
    "  - [飞书图片]",
    "  (合并转发里的图片和文件飞书不允许机器人下载,需要的话请单独发送)",
  ]);
  assert.equal(merged.title, "飞书私聊 [飞书合并转发]");
});

// ---- 钉钉 ----

test("dingtalk content: rich text, pictures, files, videos, voice transcripts", () => {
  const base = { msgId: "m", conversationId: "c" };
  assert.deepEqual(parseDingtalkMessage({ ...base, msgtype: "richText", content: { richText: [{ text: "看看" }, { type: "picture", downloadCode: "dc1" }, { type: "text", text: "这张" }] } }),
    { text: "看看这张", resources: [{ kind: "image", downloadCode: "dc1" }] });
  assert.deepEqual(parseDingtalkMessage({ ...base, msgtype: "richText", content: JSON.stringify({ richText: JSON.stringify([{ type: "picture", pictureDownloadCode: "dc2" }]) }) }).resources,
    [{ kind: "image", downloadCode: "dc2" }], "content and richText may both arrive as JSON strings");
  assert.deepEqual(parseDingtalkMessage({ ...base, msgtype: "picture", content: { pictureDownloadCode: "p" } }).resources, [{ kind: "image", downloadCode: "p" }]);
  assert.deepEqual(parseDingtalkMessage({ ...base, msgtype: "file", content: { downloadCode: "f", fileName: "发票.zip" } }).resources, [{ kind: "file", downloadCode: "f", fileName: "发票.zip" }]);
  assert.equal(parseDingtalkMessage({ ...base, msgtype: "file", content: { fileName: "x.pdf" } }).note, "[钉钉文件] x.pdf 消息未带下载码");
  assert.deepEqual(parseDingtalkMessage({ ...base, msgtype: "video", content: { videoDownloadCode: "v" } }).resources, [{ kind: "video", downloadCode: "v" }]);
  assert.deepEqual(parseDingtalkMessage({ ...base, msgtype: "audio", content: { recognition: " 明天开会 ", downloadCode: "a" } }), { text: "明天开会", resources: [] });
  assert.deepEqual(parseDingtalkMessage({ ...base, msgtype: "audio", content: { downloadCode: "a" } }).resources, [{ kind: "audio", downloadCode: "a" }]);
  assert.equal(parseDingtalkMessage({ ...base, msgtype: "chatRecord", content: {} }).note, "[钉钉chatRecord消息,暂不支持读取内容]");
});

test("dingtalk files are fetched through a cached token and the robot download API", async (t) => {
  const inbox = await tempInbox(t);
  const calls = mockFetch(t, (call) => {
    if (call.url === "https://api.dingtalk.com/v1.0/oauth2/accessToken") return Response.json({ accessToken: "tok-1", expireIn: 7200 });
    if (call.url === "https://api.dingtalk.com/v1.0/robot/messageFiles/download") return Response.json({ downloadUrl: `https://oss.test/${call.body.downloadCode}` });
    if (call.url === "https://oss.test/dc-file") return new Response("PK-not-really");
    if (call.url === "https://oss.test/dc-pic") return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    return undefined;
  });
  const source = new DingtalkSource({ clientId: "ding-app", clientSecret: "secret", allowUsers: ["staff1"], allowChats: [], inboxDir: () => inbox });
  const downstream = (message) => ({ data: JSON.stringify({ conversationId: "cid", senderStaffId: "staff1", senderNick: "王", sessionWebhook: "https://hook", ...message }) });

  const file = await source.translate(downstream({ msgId: "msgA", msgtype: "file", robotCode: "robot-9", content: { downloadCode: "dc-file", fileName: "资料.docx" } }));
  assert.match(file.text, /^\[钉钉文件\] 资料\.docx\(13 B\)已保存到本机:.*\/dingtalk\/.*\/msgA\/资料\.docx$/);
  assert.equal(file.title, "钉钉私聊 [钉钉文件] 资料.docx");
  const exchange = calls.find((call) => call.url.endsWith("messageFiles/download"));
  assert.deepEqual(exchange.body, { downloadCode: "dc-file", robotCode: "robot-9" });
  assert.equal(exchange.headers["x-acs-dingtalk-access-token"], "tok-1");

  const rich = await source.translate(downstream({
    msgId: "msgB", msgtype: "richText", conversationType: "2",
    content: { richText: [{ text: "@机器人 帮我看" }, { type: "picture", downloadCode: "dc-pic" }] },
  }));
  assert.match(rich.text, /^帮我看\n\[钉钉图片\] image-1\.png\(4 B\)/);
  assert.equal(calls.filter((call) => call.url.endsWith("oauth2/accessToken")).length, 1, "the token is cached");
  assert.equal(calls.filter((call) => call.url.endsWith("messageFiles/download")).at(-1).body.robotCode, "ding-app", "robotCode falls back to the app key");

  const voice = await source.translate(downstream({ msgId: "msgC", msgtype: "audio", content: { recognition: "收到", downloadCode: "x" } }));
  assert.equal(voice.text, "收到");
});

// ---- 企业微信 ----

/** 与企微相同的加密:AES-256-CBC,IV = 密钥前 16 字节,PKCS#7 填充到 32 字节。 */
function encryptWecom(plain, key) {
  const pad = 32 - (plain.length % 32);
  const cipher = createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(Buffer.concat([plain, Buffer.alloc(pad, pad)])), cipher.final()]);
}

test("wecom content: voice transcripts, mixed text and images, decryption", () => {
  assert.deepEqual(parseWecomContent({ msgtype: "voice", voice: { content: "语音转写" } }), { text: "语音转写", resources: [] });
  assert.deepEqual(parseWecomContent({
    msgtype: "mixed",
    mixed: { msg_item: [{ msgtype: "text", text: { content: "@机器人 看图" } }, { msgtype: "image", image: { url: "https://u/1", aeskey: "k" } }] },
  }), { text: "@机器人 看图", resources: [{ kind: "image", url: "https://u/1", aesKey: "k" }] });
  assert.equal(parseWecomContent({ msgtype: "location" }).note, "[企微location消息,暂不支持读取内容]");

  const key = randomBytes(32);
  const plain = Buffer.from("x".repeat(70));
  assert.deepEqual(decryptWecomFile(encryptWecom(plain, key), key.toString("base64")), plain);
  assert.throws(() => decryptWecomFile(Buffer.alloc(32), randomBytes(16).toString("base64")), /密钥格式不对/);
});

test("wecom files are decrypted with their per-link key and named from the response header", async (t) => {
  const inbox = await tempInbox(t);
  const key = randomBytes(32);
  const pdf = Buffer.from("%PDF-1.4 企微");
  mockFetch(t, (call) => {
    if (call.url === "https://wecom.test/file") {
      return new Response(encryptWecom(pdf, key), { headers: { "content-disposition": "attachment; filename*=UTF-8''%E5%8F%91%E7%A5%A8.pdf" } });
    }
    if (call.url === "https://wecom.test/quoted") return new Response(encryptWecom(Buffer.from("old"), key));
    return undefined;
  });
  const source = new WecomSource({ botId: "b", secret: "s", allowUsers: ["zhang"], allowChats: [], inboxDir: () => inbox });
  const frame = (body) => ({ headers: { req_id: "r1" }, body: { aibotid: "b", chattype: "single", from: { userid: "zhang" }, ...body } });

  const file = await source.translate(frame({ msgid: "w1", msgtype: "file", file: { url: "https://wecom.test/file", aeskey: key.toString("base64") } }));
  assert.match(file.text, /^\[企微文件\] 发票\.pdf\(.*\)已保存到本机:.*\/wecom\/.*\/w1\/发票\.pdf$/);
  assert.deepEqual(await readFile(savedPath(file.text)), pdf);
  assert.equal(file.title, "企微私聊 [企微文件]");

  const voice = await source.translate(frame({ msgid: "w2", msgtype: "voice", voice: { content: "帮我订会议室" } }));
  assert.equal(voice.text, "帮我订会议室");

  const quoting = await source.translate(frame({
    msgid: "w3", msgtype: "text", text: { content: "处理这个" },
    quote: { msgtype: "file", file: { url: "https://wecom.test/quoted", aeskey: key.toString("base64") } },
  }));
  assert.match(quoting.text, /^处理这个\n\[引用的企微文件\] file-1\.bin\(3 B\)已保存到本机:/);

  const quotedText = await source.translate(frame({ msgid: "w4", msgtype: "text", text: { content: "同意" }, quote: { msgtype: "text", text: { content: "明天\n上午开会?" } } }));
  assert.equal(quotedText.text, "同意\n(引用的消息:明天 上午开会?)");

  const expired = await source.translate(frame({ msgid: "w5", msgtype: "image", image: { url: "https://wecom.test/expired", aeskey: key.toString("base64") } }));
  assert.equal(expired.text, "[企微图片] 下载失败:下载失败:HTTP 404,请让用户重新发送");
});
