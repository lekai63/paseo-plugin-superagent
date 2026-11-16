import { WSClient, type BaseMessage, type ImageContent, type QuoteContent, type WsFrame } from "@wecom/aibot-node-sdk";
import { createDecipheriv } from "node:crypto";
import { truncate, type TriggerOrigin } from "../shared/model";
import type { ImSource, InboundMessage } from "./im";
import {
  describePendingAttachment,
  describeSavedAttachment,
  downloadBuffer,
  fileNameFromDisposition,
  IM_ATTACHMENT_MAX_BYTES,
  InboundQueue,
  joinLines,
  channelLabel,
  saveAttachments,
  type AttachmentKind,
  type PendingAttachment,
} from "./im-attachments";
import { t } from "./i18n";

/**
 * 企业微信触发源:官方 @wecom/aibot-node-sdk(智能机器人 WebSocket 长连接,免公网)。
 * 与 openclaw-china/wecom 同一底层 SDK 与官方通道。
 * - 单聊直接响应;群聊被 @ 才会收到事件。
 * - fast-path:allowUsers(userid)/ allowChats(chatid,群)白名单。
 * - 回复:通过 chatId 主动发送独立消息,分段不复用已完成的 req_id 流。
 * - 非文本内容:语音用平台转写文字;图片、图文混排里的图片、文件、视频按消息里的 url
 *   下载(5 分钟内有效,所以收到即下载),用 aeskey 做 AES-256-CBC 解密后存到收件目录;
 *   文件名取自下载响应头。消息本身不带附件而引用了带附件的消息时,下载被引用的那份;
 *   引用的文字附在正文后面(企微的引用不带消息 id,无法按线程归档)。
 */

type WeComClient = InstanceType<typeof WSClient>;

interface WecomConfig {
  botId: string;
  secret: string;
  allowUsers: string[];
  allowChats: string[];
  /** 附件收件根目录;每条消息现取。缺省用默认目录。 */
  inboxDir?: () => string;
}

export interface WecomResource {
  kind: AttachmentKind;
  url: string;
  aesKey?: string;
}

export interface WecomContent {
  text: string;
  resources: WecomResource[];
  note?: string;
}

const SEEN_LIMIT = 1000;
const QUOTE_MAX_CHARS = 300;

function resource(kind: AttachmentKind, media: ImageContent | undefined): WecomResource[] {
  return media?.url ? [{ kind, url: media.url, aesKey: media.aeskey || undefined }] : [];
}

/** 消息体(或引用体)→ 文字 + 可下载资源。 */
export function parseWecomContent(message: Pick<BaseMessage, "msgtype"> & Record<string, any>): WecomContent {
  switch (message.msgtype) {
    case "text":
      return { text: message.text?.content ?? "", resources: [] };
    case "voice":
      return { text: message.voice?.content ?? "", resources: [] };
    case "image":
      return { text: "", resources: resource("image", message.image) };
    case "file":
      return { text: "", resources: resource("file", message.file) };
    case "video":
      return { text: "", resources: resource("video", message.video) };
    case "mixed": {
      const parts: string[] = [];
      const resources: WecomResource[] = [];
      for (const item of message.mixed?.msg_item ?? []) {
        if (item?.msgtype === "text" && item.text?.content) parts.push(item.text.content);
        else if (item?.msgtype === "image") resources.push(...resource("image", item.image));
      }
      return { text: parts.join("\n"), resources };
    }
    default:
      return { text: "", resources: [], note: t("server.note.unsupported", { channel: channelLabel("wecom"), type: message.msgtype }) };
  }
}

/**
 * 企微附件解密:AES-256-CBC,密钥为 base64 解码后的 32 字节,IV 取前 16 字节;
 * PKCS#7 按 32 字节块填充,需手动去除(与官方 SDK 的 decryptFile 一致)。
 */
export function decryptWecomFile(encrypted: Buffer, aesKey: string): Buffer {
  const key = Buffer.from(aesKey, "base64");
  if (key.length !== 32) throw new Error(t("server.crypto.badKeyLength", { length: key.length }));
  const decipher = createDecipheriv("aes-256-cbc", key, key.subarray(0, 16));
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  const pad = decrypted[decrypted.length - 1] ?? 0;
  if (pad < 1 || pad > 32 || pad > decrypted.length || !decrypted.subarray(decrypted.length - pad).every((byte) => byte === pad)) {
    throw new Error(t("server.crypto.badPadding"));
  }
  return decrypted.subarray(0, decrypted.length - pad);
}

function pending(item: WecomResource, quoted: boolean): PendingAttachment {
  return {
    kind: item.kind,
    quoted,
    download: async (signal) => {
      // 密文比明文多至多 32 字节填充。
      const { data, headers } = await downloadBuffer(item.url, { signal, maxBytes: IM_ATTACHMENT_MAX_BYTES + 32 });
      return {
        data: item.aesKey ? decryptWecomFile(data, item.aesKey) : data,
        fileName: fileNameFromDisposition(headers?.get("content-disposition")),
      };
    },
  };
}

/** 去掉群聊里 @机器人 的首个 @ 词。 */
function stripLeadingMention(text: string): string {
  return text.replace(/^@\S+\s?/, "").trim();
}

export class WecomSource implements ImSource {
  readonly channel = "wecom" as const;
  private client: WeComClient | null = null;
  private stopped = false;
  private seen = new Set<string>();
  private inbound = new InboundQueue("wecom");
  private abort: AbortController | null = null;

  constructor(private readonly config: WecomConfig) {}

  async start(onTrigger: (message: InboundMessage) => void): Promise<void> {
    this.stopped = false;
    const abort = new AbortController();
    this.abort = abort;
    const client = new WSClient({
      botId: this.config.botId,
      secret: this.config.secret,
      maxReconnectAttempts: -1,
    });
    // "message" 覆盖所有消息回调(text/image/mixed/voice/file/video 及以后新增的类型)。
    client.on("message", (frame: WsFrame<BaseMessage>) => {
      void this.inbound.push(async () => {
        const inbound = await this.translate(frame, abort.signal);
        if (inbound) onTrigger(inbound);
      });
    });
    this.client = client;
    client.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.abort?.abort();
    this.abort = null;
    try {
      this.client?.disconnect();
    } catch (error) {
      console.error("[superagent] wecom disconnect failed", error);
    }
    this.client = null;
  }

  async send(origin: TriggerOrigin, text: string): Promise<null> {
    const client = this.client;
    if (!client) throw new Error("wecom source is not started");
    const result = await client.sendMessage(origin.chatId, { msgtype: "markdown", markdown: { content: text } });
    if (result.errcode !== 0) throw new Error(`wecom send rejected (${result.errcode})`);
    return null;
  }

  async translate(frame: WsFrame<BaseMessage>, signal?: AbortSignal): Promise<InboundMessage | null> {
    if (this.stopped) return null;
    const message = frame?.body;
    const reqId = frame?.headers?.req_id;
    if (!message || typeof reqId !== "string") return null;
    if (!message.from?.userid || !message.msgid) return null;
    if (this.seen.has(message.msgid)) return null;
    this.seen.add(message.msgid);
    if (this.seen.size > SEEN_LIMIT) {
      const excess = this.seen.size - SEEN_LIMIT;
      for (const id of [...this.seen].slice(0, excess)) this.seen.delete(id);
    }
    const isGroup = message.chattype === "group";
    const chatId = isGroup ? message.chatid : message.from.userid;
    if (!chatId) return null;
    const allowed =
      this.config.allowUsers.includes(message.from.userid) ||
      (isGroup && this.config.allowChats.includes(chatId));
    if (!allowed) return null;

    const parsed = parseWecomContent(message);
    const text = stripLeadingMention(parsed.text);
    const quote = message.quote as QuoteContent | undefined;
    const quoted = quote ? parseWecomContent(quote) : null;
    let attachments = parsed.resources.map((item) => pending(item, false));
    if (attachments.length === 0 && quoted) attachments = quoted.resources.map((item) => pending(item, true));
    const saved = attachments.length > 0
      ? await saveAttachments("wecom", message.msgid, attachments, { signal, inboxDir: this.config.inboxDir?.() })
      : [];
    const quoteText = quoted?.text.trim();
    const body = joinLines([
      text,
      parsed.note,
      ...saved.map((attachment) => describeSavedAttachment("wecom", attachment)),
      quoteText ? t("server.note.quotedMessage", { text: truncate(quoteText.replace(/\s*\n\s*/g, " "), QUOTE_MAX_CHARS) }) : null,
    ]);
    if (!body) return null;
    const headline = text || parsed.note || attachments.map((item) => describePendingAttachment("wecom", item)).join(" ") || body;

    const origin: TriggerOrigin = {
      channel: "wecom",
      accountId: this.config.botId,
      chatId,
      messageId: message.msgid,
      replyRef: reqId,
      senderId: message.from.userid,
      senderName: null,
    };
    return {
      origin,
      threadKey: `wecom:chat:${chatId}`,
      title: t(isGroup ? "server.title.wecomGroup" : "server.title.wecomDirect", { text: truncate(headline, 40) }),
      text: body,
      sender: `wecom:${message.from.userid}`,
    };
  }
}
