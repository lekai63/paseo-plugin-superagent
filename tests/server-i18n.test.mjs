import assert from "node:assert/strict";
import test from "node:test";
import { describeArchive, listZip } from "../server/archive.ts";
import { DingtalkSource, parseDingtalkMessage } from "../server/dingtalk.ts";
import { FeishuSource, parseFeishuContent } from "../server/feishu.ts";
import { readFilePreview } from "../server/file-preview.ts";
import { serverLanguage, setServerLanguage } from "../server/i18n.ts";
import { describePendingAttachment, describeSavedAttachment, downloadBuffer, withTimeout } from "../server/im-attachments.ts";
import { QqSource } from "../server/qq.ts";
import { WecomSource, decryptWecomFile, parseWecomContent } from "../server/wecom.ts";
import { WeixinLogin } from "../server/weixin-login.ts";
import { parseWeixinAesKey } from "../server/weixin-media.ts";

/** Runs `body` with the daemon in the given language and restores English afterwards. */
async function inLanguage(language, body) {
  const before = serverLanguage();
  setServerLanguage(language);
  try {
    await body();
  } finally {
    setServerLanguage(before);
  }
}

const file = (over = {}) => ({ kind: "file", quoted: false, name: "report.pdf", path: "/inbox/report.pdf", bytes: 2048, error: null, details: [], ...over });

test("English is the daemon default and attachment lines read naturally", () => {
  assert.equal(serverLanguage(), "en");
  assert.equal(describeSavedAttachment("feishu", file()), "[Feishu file] report.pdf (2.0 KB) saved on this machine: /inbox/report.pdf");
  assert.equal(
    describeSavedAttachment("weixin", file({ quoted: true, kind: "image" })),
    "[quoted WeChat image] report.pdf (2.0 KB) saved on this machine: /inbox/report.pdf",
  );
  assert.equal(
    describeSavedAttachment("wecom", file({ path: null, error: "HTTP 404" })),
    "[WeCom file] report.pdf download failed: HTTP 404. Ask the user to resend it.",
  );
  assert.equal(describeSavedAttachment("qq", file({ kind: "audio", path: null, name: null, error: "x" })), "[QQ voice message] download failed: x. Ask the user to resend it.");
  assert.equal(describePendingAttachment("dingtalk", { kind: "video", fileName: "a.mp4" }), "[DingTalk video] a.mp4");
  assert.equal(describePendingAttachment("feishu", { kind: "image", quoted: true }), "[quoted Feishu image]");
});

test("attachment lines follow the language at call time", async () => {
  await inLanguage("zh-CN", () => {
    assert.equal(describeSavedAttachment("feishu", file()), "[飞书文件] report.pdf(2.0 KB)已保存到本机:/inbox/report.pdf");
  });
  assert.match(describeSavedAttachment("feishu", file()), /^\[Feishu file\]/);
});

test("download errors are English", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => ({ ok: false, status: 500, headers: new Headers() });
  await assert.rejects(downloadBuffer("https://x.test/fail", { label: "CDN " }), /^Error: CDN download failed: HTTP 500$/);
  globalThis.fetch = async () => ({ ok: true, status: 200, headers: new Headers({ "content-length": String(200 * 1024 * 1024) }) });
  await assert.rejects(downloadBuffer("https://x.test/big"), /^Error: Exceeds the 100\.0 MB limit \(200\.0 MB\)$/);
  await assert.rejects(withTimeout(new Promise(() => {}), 10), /^Error: Download timed out \(0\.01 s\)$/);
  assert.throws(() => parseWeixinAesKey(Buffer.from("short").toString("base64")), /Invalid decryption key format \(5 bytes after decoding\)/);
  assert.throws(() => decryptWecomFile(Buffer.alloc(32), Buffer.alloc(8).toString("base64")), /Invalid decryption key format \(8 bytes after decoding\)/);
});

test("archive listings and errors are English", () => {
  assert.throws(() => listZip(Buffer.from("not a zip at all, definitely not")), /Not a valid zip file \(central directory not found\)/);
  const entry = (name, size, over = {}) => ({ name, size, directory: false, encrypted: false, symlink: false, ...over });
  const entries = [
    ...Array.from({ length: 33 }, (_, i) => entry(`inv/${String(i).padStart(2, "0")}.pdf`, 1024)),
    entry("nested.rar", 100),
    entry("a.bin", 5, { encrypted: true }),
    entry("../../etc/cron.d/x", 1),
    entry("ln", 1, { symlink: true }),
    entry("__MACOSX/._a", 1),
    entry(".DS_Store", 1),
  ];
  const lines = describeArchive({ format: "zip", entries, truncated: false }, 10_000);
  assert.equal(lines[0], "  zip archive with 37 files, 33.1 KB when extracted:");
  assert.equal(lines[1], "  - inv/00.pdf (1.0 KB)");
  assert.ok(lines.includes("  - …7 more files not listed"));
  assert.ok(lines.includes("  Contains 1 nested archive; one more extraction layer needed: nested.rar"));
  assert.ok(lines.includes("  ⚠ 1 file is encrypted; a password is needed to extract"));
  assert.ok(lines.includes("  ⚠ Paths would escape the extraction directory; exclude them when extracting: ../../etc/cron.d/x"));
  assert.ok(lines.includes("  ⚠ Contains symbolic links; exclude them when extracting: ln"));
  assert.ok(lines.includes("  (2 other macOS/Windows packaging metadata items, can be ignored)"));

  const several = describeArchive({ format: "zip", entries: [entry("a.zip", 1), entry("b.zip", 1), entry("c.zip", 1), entry("d.zip", 1), entry("e.zip", 1, { encrypted: true })], truncated: true }, 10);
  assert.equal(several[0], "  zip archive with at least 5 files, 5 B when extracted:");
  assert.ok(several.includes("  Contains 4 nested archives; one more extraction layer needed: a.zip, b.zip, c.zip and more (5 items)") || several.some((line) => line.startsWith("  Contains 5 nested archives")));

  const bomb = describeArchive({ format: "zip", truncated: false, entries: [entry("zeros.bin", 3 * 1024 ** 3)] }, 3 * 1024 ** 2);
  assert.ok(bomb.includes("  ⚠ 3.00 GB when extracted, 1024x the archive size; likely a zip bomb, do not extract directly"));
  assert.deepEqual(describeArchive({ format: "7z", entries: [], truncated: false }, 1), ["  7z archive contains no files"]);
  assert.deepEqual(
    describeArchive({ format: "7z", entries: [entry("d/", 0, { directory: true })], truncated: false }, 1),
    ["  7z archive contains no files (only directories or system metadata)"],
  );
  const all = describeArchive({ format: "zip", entries: [entry("a", 1, { encrypted: true })], truncated: false }, 1);
  assert.ok(all.includes("  ⚠ All files are encrypted; a password is needed to extract"));
});

test("Feishu notes, cards and merge-forward markers are English", () => {
  assert.equal(parseFeishuContent("location", '{"name":"Hangzhou East"}').note, "[Feishu location] Hangzhou East");
  assert.equal(
    parseFeishuContent("folder", '{"file_key":"f","file_name":"March"}').note,
    "[Feishu folder] March (folders cannot be downloaded; send them as an archive)",
  );
  assert.equal(parseFeishuContent("vote", "{}").note, "[Feishu vote message, content not supported yet]");
  assert.equal(parseFeishuContent("text", "not json").note, "[Feishu text message, content could not be parsed]");
  assert.equal(parseFeishuContent("merge_forward", "").note, "[Feishu merged forward]");
  assert.equal(parseFeishuContent("share_chat", "{}").note, "[Feishu group contact card]");
  assert.equal(parseFeishuContent("share_user", "{}").note, "[Feishu personal contact card]");
  assert.equal(parseFeishuContent("interactive", "{}").note, "[Feishu card] empty content");

  const card = parseFeishuContent("interactive", JSON.stringify({
    header: { title: { tag: "plain_text", content: "Weekly" } },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: "<at id=all></at> and <at id=x></at> please submit" } },
      { tag: "img", img_key: "k" },
      { tag: "action", actions: [{ tag: "button", text: { tag: "plain_text", content: "Later" } }] },
    ],
    card_link: { url: "https://x.test/card" },
  }));
  assert.equal(card.note, "[Feishu card] Weekly\n@everyone and @user please submit\n[Card image]\n[Button] Later\n[Open card](https://x.test/card)");
});

test("Feishu merge-forward listings are English", async () => {
  const source = new FeishuSource({ appId: "a", appSecret: "b", allowUsers: ["ou_1"], allowChats: [], observeGroups: false });
  const child = (id, msg_type, content) => ({ message_id: id, msg_type, body: { content: JSON.stringify(content) } });
  source.fetchMessages = async () => [
    { message_id: "m" },
    ...Array.from({ length: 2 }, (_, i) => child(`c${i}`, "text", { text: `hello ${i}` })),
    child("img", "image", { image_key: "k" }),
  ];
  const lines = await source.mergeForwardLines("m");
  assert.deepEqual(lines, [
    "[Feishu merged forward] 3 messages:",
    "  - hello 0",
    "  - hello 1",
    "  - [Feishu image]",
    "  (Feishu does not let bots download images and files inside a merged forward; send them separately if needed)",
  ]);
  source.fetchMessages = async () => null;
  assert.deepEqual(await source.mergeForwardLines("m"), ["[Feishu merged forward] failed to read"]);
  source.fetchMessages = async () => { throw new Error("boom"); };
  assert.deepEqual(await source.mergeForwardLines("m"), ["[Feishu merged forward] failed to read: boom"]);
});

test("DingTalk and WeCom placeholders are English", () => {
  const base = { msgId: "m", conversationId: "c" };
  assert.equal(parseDingtalkMessage({ ...base, msgtype: "file", content: { fileName: "x.pdf" } }).note, "[DingTalk file] x.pdf message has no download code");
  assert.equal(parseDingtalkMessage({ ...base, msgtype: "chatRecord", content: {} }).note, "[DingTalk chatRecord message, content not supported yet]");
  assert.equal(parseWecomContent({ msgtype: "location" }).note, "[WeCom location message, content not supported yet]");
});

test("WeCom quoted notes and chat titles are English", async () => {
  const source = new WecomSource({ botId: "b", secret: "s", allowUsers: ["u1"], allowChats: [] });
  const inbound = await source.translate({
    headers: { req_id: "r1" },
    body: {
      aibotid: "b", msgid: "w1", msgtype: "text", chattype: "single", from: { userid: "u1" },
      text: { content: "approve" }, quote: { msgtype: "text", text: { content: "ship it tomorrow?" } },
    },
  });
  assert.equal(inbound.text, "approve\n(quoted message: ship it tomorrow?)");
  assert.equal(inbound.title, "WeCom DM approve");
});

test("chat titles and filter reasons are English", async () => {
  let counter = 0;
  const feishuEvent = (over = {}) => ({
    sender: { sender_id: { open_id: "ou_1" }, sender_type: "user" },
    message: { message_id: `m${++counter}`, chat_id: "oc_group", chat_type: "group", message_type: "text", content: JSON.stringify({ text: "idle chatter" }), mentions: [], ...over },
  });
  const drops = [];
  const strict = new FeishuSource({ appId: "a", appSecret: "b", allowUsers: [], allowChats: ["oc_group"], observeGroups: false });
  assert.equal(await strict.translate(feishuEvent(), (drop) => drops.push(drop)), null);
  assert.equal(drops[0].reason, "Group message did not @ the bot");
  assert.equal(drops[0].title, "Feishu group idle chatter");
  const observing = new FeishuSource({ appId: "a", appSecret: "b", allowUsers: ["ou_1"], allowChats: ["oc_group"], observeGroups: true });
  assert.equal((await observing.translate(feishuEvent(), () => {})).title, "Feishu group idle chatter");
  assert.equal((await observing.translate(feishuEvent({ chat_type: "p2p" }), () => {})).title, "Feishu DM idle chatter");

  const qq = new QqSource({ endpoint: "ws://x", token: "", allowUsers: ["10001"], allowGroups: ["20001"], observeGroups: false });
  const qqDrops = [];
  const groupEvent = {
    post_type: "message", message_type: "group", group_id: 20001, user_id: 10001, self_id: 99999, message_id: 7,
    message: [{ type: "text", data: { text: "hello" } }], raw_message: "hello",
  };
  assert.equal(qq.translate(groupEvent, (drop) => qqDrops.push(drop)), null);
  assert.equal(qqDrops[0].reason, "Group message did not @ the bot");
  assert.equal(qqDrops[0].title, "QQ group hello");
  const privateEvent = { ...groupEvent, message_type: "private" };
  assert.equal(qq.translate(privateEvent, () => {}).title, "QQ DM hello");

  assert.equal(new DingtalkSource({ clientId: "c", clientSecret: "s", allowUsers: [], allowChats: [] }).constructor.name, "DingtalkSource");
});

test("file-preview errors are English", async () => {
  assert.equal((await readFilePreview("relative/path")).message, "Only absolute paths can be previewed");
  assert.equal((await readFilePreview("/definitely/not/here.txt")).message, "File not found (it may have been deleted or moved)");
});

test("WeChat login status messages are English and follow the language", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => { throw new Error("offline"); };
  const login = new WeixinLogin({ loadAccount: async () => null, onConfirmed: async () => {} }, 0);
  const failed = await login.start();
  assert.equal(failed.phase, "failed");
  assert.equal(failed.message, "Failed to fetch the QR code: offline");
  assert.equal(login.cancel().message, failed.message, "nothing to cancel keeps the last status");
  await inLanguage("zh-CN", async () => {
    assert.equal((await login.start()).message, "获取二维码失败:offline");
  });
});
