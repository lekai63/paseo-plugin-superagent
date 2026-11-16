import { truncate, type TriggerOrigin } from "../shared/model";
import type { DropHandler, ImSource, InboundDrop, InboundMessage } from "./im";
import {
  describePendingAttachment,
  describeSavedAttachment,
  fileNameFromDisposition,
  InboundQueue,
  joinLines,
  readStream,
  saveAttachments,
  withTimeout,
  channelLabel,
  type AttachmentKind,
  type PendingAttachment,
} from "./im-attachments";
import { t } from "./i18n";

/**
 * 飞书触发源:官方 SDK 长连接(WSClient),无需公网回调。
 * - 私聊直接响应;群聊仅在被 @ 机器人时响应(去 @ 后取剩余文本)。
 * - 群聊观察模式(observeGroups):未 @ 的群消息不再丢弃,作为上下文交给 Router 判断。
 * - fast-path:allowUsers(open_id)/ allowChats(chat_id)白名单,命中即放行。
 * - 回复用 message.reply 引用回复,来源消息去重(message_id 环形集)。
 * - 非文本内容:富文本(post)取文字与图片/视频;图片、文件、语音、视频经
 *   messageResource.get 下载到收件目录;合并转发经 message.get 列出子消息文字(飞书不允许
 *   机器人下载合并转发里的附件);消息本身不带附件而回复了一条带附件的消息时,下载被回复的那份。
 *   卡片(interactive,如转发来的审批卡片):事件里只有降级内容,经 message.get 取原始卡片转成文字。
 *   群里未 @ 的消息(观察模式上下文、留痕)只写附件描述,不下载。
 *
 * SDK 以动态 import 懒加载:其模块作用域读取 __dirname 探测自身版本(仅用于
 * User-Agent,失败静默回退 'unknown'),而插件包以 ESM 执行没有 __dirname——
 * 加载前预置一个无害占位即可。
 */

type LarkModule = typeof import("@larksuiteoapi/node-sdk");
let larkModule: LarkModule | null = null;

async function loadLark(): Promise<LarkModule> {
  if (larkModule) return larkModule;
  (globalThis as { __dirname?: string }).__dirname ??= process.cwd();
  larkModule = (await import("@larksuiteoapi/node-sdk")) as LarkModule;
  return larkModule;
}

interface FeishuConfig {
  appId: string;
  appSecret: string;
  allowUsers: string[];
  allowChats: string[];
  /** 群聊观察模式:未 @ 机器人的群消息作为上下文触发(否则记 filtered 留痕)。 */
  observeGroups: boolean;
  /** 附件收件根目录;每条消息现取。缺省用默认目录。 */
  inboxDir?: () => string;
}

interface LarkMessageEvent {
  sender?: { sender_id?: { open_id?: string }; sender_type?: string };
  message?: {
    message_id?: string;
    root_id?: string | null;
    parent_id?: string | null;
    chat_id?: string;
    chat_type?: string;
    message_type?: string;
    content?: string;
    mentions?: Array<{ key?: string; id?: { open_id?: string }; name?: string }>;
  };
}

/** message.get 的真实返回是 data.items[](SDK 类型声明写成了单条)。 */
interface LarkApiMessage {
  message_id?: string;
  msg_type?: string;
  upper_message_id?: string;
  body?: { content?: string };
}

/** 消息里的一份资源:image_key 用 type=image 下载,其余 file_key 用 type=file。 */
export interface FeishuResource {
  kind: AttachmentKind;
  key: string;
  type: "image" | "file";
  fileName?: string;
}

export interface FeishuContent {
  text: string;
  resources: FeishuResource[];
  /** 不能下载、只能说明的内容(名片、位置、文件夹、暂不支持的类型)。 */
  note?: string;
  /** 表情包等无需交给 Router 的内容。 */
  ignore?: boolean;
}

const SEEN_LIMIT = 1000;
const MERGE_FORWARD_LISTED = 50;
const MERGE_FORWARD_LINE_CHARS = 300;

type LarkClient = InstanceType<LarkModule["Client"]>;
type LarkWsClient = InstanceType<LarkModule["WSClient"]>;

function parseJson(content: string | undefined): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(content ?? "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** 富文本:事件里是 {title, content:[[…]]};部分接口按语言再包一层 {zh_cn:{…}}。 */
function parsePost(body: Record<string, unknown>): FeishuContent {
  let post = body;
  if (!Array.isArray(post.content)) {
    const localized = Object.values(body).find(
      (value): value is Record<string, unknown> => Boolean(value && typeof value === "object" && Array.isArray((value as { content?: unknown }).content)),
    );
    if (localized) post = localized;
  }
  const resources: FeishuResource[] = [];
  const lines: string[] = [];
  const title = str(post.title).trim();
  if (title) lines.push(title);
  for (const paragraph of Array.isArray(post.content) ? post.content : []) {
    let line = "";
    for (const element of Array.isArray(paragraph) ? (paragraph as Array<Record<string, unknown>>) : []) {
      switch (element?.tag) {
        case "text":
        case "md":
          line += str(element.text);
          break;
        case "a":
          line += element.href && element.href !== element.text ? `${str(element.text)}(${str(element.href)})` : str(element.text);
          break;
        case "at":
          // 与纯文本消息一致:@ 占位在后面统一去掉。
          line += str(element.user_id);
          break;
        case "code_block":
          line += `\n\`\`\`${str(element.language).toLowerCase()}\n${str(element.text)}\n\`\`\`\n`;
          break;
        case "hr":
          line += "\n---\n";
          break;
        case "img":
          if (str(element.image_key)) resources.push({ kind: "image", key: str(element.image_key), type: "image" });
          break;
        case "media":
          if (str(element.file_key)) resources.push({ kind: "video", key: str(element.file_key), type: "file" });
          break;
        default:
          break; // emotion 等装饰性元素。
      }
    }
    if (line.trim()) lines.push(line.trim());
  }
  return { text: lines.join("\n"), resources };
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => Boolean(value && typeof value === "object" && !Array.isArray(value));

/** 卡片里只是控件、没有可读内容的元素。 */
const CARD_SKIP_TAGS = new Set([
  "hr", "chart", "input", "overflow", "date_picker", "picker_time", "picker_datetime",
  "select_static", "multi_select_static", "select_person", "multi_select_person", "select_img",
]);

/** lark_md 内联标签:@ 换成名字,<br> 换行,其余样式标签去掉只留文字。 */
function cleanCardMarkdown(text: string, names: Record<string, string>): string {
  return text
    .replace(/<at\s+(?:id|user_id|open_id)=["']?([^"'\s>]+)["']?\s*>([^<]*)<\/at>/g, (_, id: string, inner: string) =>
      `@${inner.trim() || names[id] || (id === "all" ? t("server.feishu.card.everyone") : t("server.feishu.card.user"))}`)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(?:font|text_tag|link|local_datetime|number_tag|u|s|i|b|strong|em)\b[^>]*>/gi, "");
}

/** 第一个链接:用户态 url / multi_url / behaviors[].default_url,原始渲染树 actions[].action.url,卡片 card_link / cardLink。 */
function findCardUrl(node: unknown, depth = 0): string {
  if (depth > 4) return "";
  if (Array.isArray(node)) {
    for (const item of node) {
      const url = findCardUrl(item, depth + 1);
      if (url) return url;
    }
    return "";
  }
  if (!isObject(node)) return "";
  for (const key of ["url", "default_url", "pc_url", "pcURL"]) {
    if (/^https?:\/\//.test(str(node[key]))) return str(node[key]);
  }
  for (const key of ["multi_url", "behaviors", "actions", "action", "property"]) {
    const url = findCardUrl(node[key], depth + 1);
    if (url) return url;
  }
  return "";
}

/**
 * 卡片 → 文字行。同时认用户态卡片 JSON(1.0 elements / 2.0 body.elements)与原始渲染树
 * (节点属性包在 property 里);只从文字类节点取字,其余结构原样往下找。
 */
class CardText {
  readonly lines: string[] = [];
  hasLink = false;

  constructor(private readonly names: Record<string, string>) {}

  /** 文字类节点 → 内联文字;不是文字节点返回 null。 */
  inline(node: unknown): string | null {
    if (!isObject(node)) return null;
    const prop = isObject(node.property) ? node.property : node;
    switch (node.tag) {
      case "plain_text":
      case "lark_md":
      case "markdown":
      case "text":
        if (typeof prop.content === "string") return cleanCardMarkdown(prop.content, this.names);
        if (typeof prop.text === "string") return prop.text;
        if (Array.isArray(prop.elements)) return prop.elements.map((child) => this.inline(child) ?? "").join("");
        return "";
      case "at":
      case "person": {
        const id = str(prop.userID) || str(prop.user_id) || str(prop.id);
        return `@${this.names[id] || str(prop.user_name) || t("server.feishu.card.user")}`;
      }
      case "a":
      case "link": {
        const label = str(prop.content) || str(prop.text);
        const url = findCardUrl(prop);
        return url && url !== label ? `${label}(${url})` : label;
      }
      default:
        return null;
    }
  }

  walk(node: unknown, depth = 0): void {
    if (depth > 40) return;
    if (Array.isArray(node)) {
      for (const child of node) this.walk(child, depth + 1);
      return;
    }
    if (!isObject(node)) return;
    const text = this.inline(node);
    if (text !== null) {
      if (text.trim()) this.lines.push(text.trim());
      return;
    }
    const tag = str(node.tag);
    if (CARD_SKIP_TAGS.has(tag)) return;
    const prop = isObject(node.property) ? node.property : node;
    switch (tag) {
      case "img":
      case "image":
      case "img_combination":
        this.lines.push(t("server.feishu.card.image"));
        return;
      case "button": {
        const label = this.inline(prop.text)?.trim() || t("server.feishu.card.button");
        const url = findCardUrl(prop);
        if (url) this.hasLink = true;
        this.lines.push(url ? `[${label}](${url})` : t("server.feishu.card.buttonNoLink", { label }));
        return;
      }
      case "div":
        // 标签(text)在字段(fields)前面,原始渲染树里键序相反。
        this.walk(prop.text, depth + 1);
        this.walk(prop.fields, depth + 1);
        this.walk(prop.extra, depth + 1);
        return;
      default:
        break;
    }
    for (const [key, value] of Object.entries(prop)) {
      if (key === "config") continue;
      // 多语言:只取中文(没有则取第一种),否则每种语言各读一遍。
      if (/^i18n/i.test(key)) {
        if (isObject(value)) this.walk(value.zh_cn ?? Object.values(value)[0], depth + 1);
        continue;
      }
      this.walk(value, depth + 1);
    }
  }
}

const CARD_TEXT_CHARS = 4000;

/**
 * 卡片消息内容 → 说明文字;读不出任何内容返回 null。认三种形态:
 * - 原始卡片(message.get card_msg_content_type=raw_card_content):{json_card, json_attachment};
 * - 用户态卡片 JSON:{header, elements} 或 {schema:"2.0", header, body};
 * - 事件推送的降级内容:{title, elements:[[…]], card_link}——复杂卡片(如审批)这里只剩标题。
 */
export function parseFeishuCard(body: Json): string | null {
  let card = body;
  const names: Record<string, string> = {};
  if (typeof body.json_card === "string") {
    card = parseJson(body.json_card) ?? {};
    const atUsers = isObject(body.json_attachment) ? body.json_attachment.at_users : null;
    for (const [id, user] of Object.entries(isObject(atUsers) ? atUsers : {})) {
      if (isObject(user) && str(user.content)) names[id] = str(user.content);
    }
  }
  let title: string;
  let lines: string[];
  let hasLink = false;
  if (typeof card.title === "string" && Array.isArray(card.elements) && card.elements.every(Array.isArray)) {
    const post = parsePost({ title: "", content: card.elements });
    title = card.title.trim();
    lines = post.text ? post.text.split("\n") : [];
  } else {
    const header = new CardText(names);
    header.walk(card.header);
    const content = new CardText(names);
    content.walk(Object.fromEntries(Object.entries(card).filter(([key]) => key !== "header")));
    title = header.lines.join(" ");
    lines = content.lines;
    hasLink = content.hasLink;
  }
  if (!hasLink) {
    const link = findCardUrl(card.card_link) || (isObject(card.config) ? findCardUrl(card.config.cardLink ?? card.config.card_link) : "");
    if (link) lines.push(t("server.feishu.card.open", { link }));
  }
  if (!title && lines.length === 0) return null;
  return truncate(joinLines([t("server.feishu.card.header", { title: title ? ` ${title}` : "" }), ...lines]), CARD_TEXT_CHARS);
}

/** 消息内容 → 文字 + 可下载资源(+ 只能说明的部分)。 */
export function parseFeishuContent(messageType: string, content: string | undefined): FeishuContent {
  // 只看类型即可判断的消息(合并转发的 content 不是 JSON 对象)。
  switch (messageType) {
    case "sticker":
      return { text: "", resources: [], ignore: true };
    case "merge_forward":
      return { text: "", resources: [], note: t("server.feishu.mergeForward") };
    case "share_chat":
      return { text: "", resources: [], note: t("server.feishu.groupCard") };
    case "share_user":
      return { text: "", resources: [], note: t("server.feishu.userCard") };
    default:
      break;
  }
  const body = parseJson(content);
  if (!body) return { text: "", resources: [], note: t("server.note.unparsable", { channel: channelLabel("feishu"), type: messageType }) };
  switch (messageType) {
    case "text":
      return { text: str(body.text), resources: [] };
    case "post":
      return parsePost(body);
    case "image":
      return { text: "", resources: str(body.image_key) ? [{ kind: "image", key: str(body.image_key), type: "image" }] : [] };
    case "file":
      return {
        text: "",
        resources: str(body.file_key) ? [{ kind: "file", key: str(body.file_key), type: "file", fileName: str(body.file_name) || undefined }] : [],
      };
    case "audio":
      return { text: "", resources: str(body.file_key) ? [{ kind: "audio", key: str(body.file_key), type: "file" }] : [] };
    case "media":
      return {
        text: "",
        resources: str(body.file_key) ? [{ kind: "video", key: str(body.file_key), type: "file", fileName: str(body.file_name) || undefined }] : [],
      };
    case "location":
      return { text: "", resources: [], note: t("server.feishu.location", { name: str(body.name) }).trim() };
    case "folder": {
      const name = str(body.file_name);
      return { text: "", resources: [], note: t("server.feishu.folder", { name: name ? ` ${name}` : "" }) };
    }
    case "interactive":
      return { text: "", resources: [], note: parseFeishuCard(body) ?? t("server.feishu.cardEmpty") };
    default:
      return { text: "", resources: [], note: t("server.note.unsupported", { channel: channelLabel("feishu"), type: messageType }) };
  }
}

/** 会话标题:单行,40 字以内。 */
function titleText(text: string): string {
  return truncate(text.replace(/\s+/g, " ").trim(), 40);
}

function stripMentions(text: string): string {
  return text.replace(/@_user_\d+/g, "").trim();
}

export class FeishuSource implements ImSource {
  readonly channel = "feishu" as const;
  private client: LarkClient | null = null;
  private wsClient: LarkWsClient | null = null;
  private stopped = false;
  private seen = new Set<string>();
  private inbound = new InboundQueue("feishu");
  private abort: AbortController | null = null;

  constructor(private readonly config: FeishuConfig) {}

  async start(onTrigger: (message: InboundMessage) => void, onDrop?: (drop: InboundDrop) => void): Promise<void> {
    this.stopped = false;
    const abort = new AbortController();
    this.abort = abort;
    const lark = await loadLark();
    // 说明:SDK 未包装 GET /bot/v3/info,群聊判定退化为"任意 @"——
    // mentions 仅在有人被 @ 时出现,叠加 chat 白名单,误触发面可接受。
    this.client = new lark.Client({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      appType: lark.AppType.SelfBuild,
      domain: lark.Domain.Feishu,
    });
    this.wsClient = new lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      loggerLevel: lark.LoggerLevel.warn,
      domain: lark.Domain.Feishu,
    });
    const dispatcher = new lark.EventDispatcher({}).register({
      // 立即返回(长连接要求 3 秒内处理完,否则重推);附件下载在队列里按到达顺序进行。
      "im.message.receive_v1": async (data: LarkMessageEvent) => {
        void this.inbound.push(async () => {
          const inbound = await this.translate(data, onDrop, abort.signal);
          if (inbound) onTrigger(inbound);
        });
      },
    });
    await this.wsClient.start({ eventDispatcher: dispatcher });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.abort?.abort();
    this.abort = null;
    try {
      this.wsClient?.close({ force: true });
    } finally {
      this.wsClient = null;
      this.client = null;
    }
  }

  async send(origin: TriggerOrigin, text: string): Promise<string | null> {
    const client = this.requireClient();
    if (origin.messageId) {
      const result = await client.im.v1.message.reply({
        path: { message_id: origin.messageId },
        data: { msg_type: "text", content: JSON.stringify({ text }) },
      });
      if (result.code !== 0) throw new Error(`feishu reply rejected (${result.code})`);
      return result.data?.message_id ?? null;
    }
    const result = await client.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: origin.chatId,
        msg_type: "text",
        content: JSON.stringify({ text }),
      },
    });
    if (result.code !== 0) throw new Error(`feishu send rejected (${result.code})`);
    return result.data?.message_id ?? null;
  }

  private requireClient(): LarkClient {
    if (!this.client) throw new Error("feishu source is not started");
    return this.client;
  }

  /** message.get:失败返回 null(调用方降级为说明文字)。卡片取原始内容(含字段标签与 @ 的人名)。 */
  private async fetchMessages(messageId: string): Promise<LarkApiMessage[] | null> {
    const request = this.requireClient().im.v1.message.get({
      path: { message_id: messageId },
      params: { card_msg_content_type: "raw_card_content" },
    });
    const result = (await withTimeout(request, 15_000)) as unknown as {
      code?: number;
      data?: { items?: LarkApiMessage[] };
    };
    return result.code === 0 ? (result.data?.items ?? []) : null;
  }

  private pending(messageId: string, resource: FeishuResource, quoted: boolean): PendingAttachment {
    return {
      kind: resource.kind,
      fileName: resource.fileName,
      quoted,
      download: async (signal) => {
        const response = await withTimeout(
          this.requireClient().im.v1.messageResource.get({
            path: { message_id: messageId, file_key: resource.key },
            params: { type: resource.type },
          }),
        );
        const data = await readStream(response.getReadableStream(), { signal });
        const headers = (response.headers ?? {}) as Record<string, string | undefined>;
        return { data, fileName: fileNameFromDisposition(headers["content-disposition"]) };
      },
    };
  }

  /** 事件推送的卡片是降级内容(审批等复杂卡片只剩标题):按 id 取完整卡片,取不到沿用事件内容。 */
  private async fullCard(messageId: string, fallback: FeishuContent): Promise<FeishuContent> {
    try {
      const item = (await this.fetchMessages(messageId))?.[0];
      const body = item?.msg_type === "interactive" ? parseJson(item.body?.content) : null;
      const note = body ? parseFeishuCard(body) : null;
      if (note) return { text: "", resources: [], note };
    } catch (error) {
      console.warn(`[superagent] feishu card ${messageId} lookup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return fallback;
  }

  /** 合并转发:列出子消息文字;附件只能说明(飞书不允许机器人下载合并转发里的资源)。 */
  private async mergeForwardLines(messageId: string): Promise<string[]> {
    let items: LarkApiMessage[] | null;
    try {
      items = await this.fetchMessages(messageId);
    } catch (error) {
      return [t("server.feishu.forwardReadFailedWith", { error: error instanceof Error ? error.message : String(error) })];
    }
    if (!items) return [t("server.feishu.forwardReadFailed")];
    const children = items.filter((item) => item.message_id !== messageId);
    const lines = [t("server.feishu.forwardHeader", { count: children.length })];
    let hasAttachments = false;
    for (const child of children.slice(0, MERGE_FORWARD_LISTED)) {
      const parsed = parseFeishuContent(child.msg_type ?? "", child.body?.content);
      if (parsed.ignore) continue;
      if (parsed.resources.length > 0) hasAttachments = true;
      const summary = [
        stripMentions(parsed.text),
        parsed.note,
        ...parsed.resources.map((resource) => describePendingAttachment("feishu", resource)),
      ]
        .filter(Boolean)
        .join(" ")
        .replace(/\s*\n\s*/g, " ");
      if (summary) lines.push(`  - ${truncate(summary, MERGE_FORWARD_LINE_CHARS)}`);
    }
    if (children.length > MERGE_FORWARD_LISTED) lines.push(t("server.feishu.forwardMore", { count: children.length - MERGE_FORWARD_LISTED }));
    if (hasAttachments) lines.push(t("server.feishu.forwardNoAttachments"));
    return lines;
  }

  /** 回复(引用)了一条带附件的消息:取回那条消息的资源,以被引用消息的 id 下载。 */
  private async quotedAttachments(parentId: string): Promise<PendingAttachment[]> {
    try {
      const parent = (await this.fetchMessages(parentId))?.[0];
      if (!parent || parent.msg_type === "merge_forward") return [];
      return parseFeishuContent(parent.msg_type ?? "", parent.body?.content).resources.map((resource) =>
        this.pending(parentId, resource, true),
      );
    } catch (error) {
      console.warn(`[superagent] feishu quoted message ${parentId} lookup failed: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  /** 事件 → InboundMessage(附件已落盘);fast-path 拒绝返回 null;准入丢弃经 onDrop 留痕。 */
  async translate(data: LarkMessageEvent, onDrop?: DropHandler, signal?: AbortSignal): Promise<InboundMessage | null> {
    if (this.stopped) return null;
    const message = data.message;
    const senderOpenId = data.sender?.sender_id?.open_id;
    if (!message?.chat_id || !message.message_id || !senderOpenId) return null;
    if (data.sender?.sender_type && data.sender.sender_type !== "user") return null;
    if (this.seen.has(message.message_id)) return null;
    this.seen.add(message.message_id);
    if (this.seen.size > SEEN_LIMIT) {
      const excess = this.seen.size - SEEN_LIMIT;
      for (const id of [...this.seen].slice(0, excess)) this.seen.delete(id);
    }
    // fast-path 白名单:发送者与会话至少一项命中。
    const allowed =
      this.config.allowUsers.includes(senderOpenId) ||
      this.config.allowChats.includes(message.chat_id);
    if (!allowed) return null;

    const messageType = message.message_type ?? "";
    let parsed = parseFeishuContent(messageType, message.content);
    if (parsed.ignore) return null;
    if (messageType === "interactive") parsed = await this.fullCard(message.message_id, parsed);
    const text = stripMentions(parsed.text);
    const mentions = message.mentions ?? [];
    const isGroup = message.chat_type === "group";
    // 引用链:直接父消息优先,其次回复链根消息(去重)。
    const replyTo = [...new Set([message.parent_id, message.root_id].filter((id): id is string => Boolean(id)))];
    const threadKey = message.root_id
      ? `feishu:chat:${message.chat_id}:root:${message.root_id}`
      : `feishu:chat:${message.chat_id}`;
    const origin: TriggerOrigin = {
      channel: "feishu",
      accountId: this.config.appId,
      chatId: message.chat_id,
      messageId: message.message_id,
      senderId: senderOpenId,
      senderName: null,
    };
    // 不下载时的摘要:群里未 @ 的消息只作留痕/上下文。
    const summary = joinLines([
      text,
      parsed.note,
      ...parsed.resources.map((resource) => describePendingAttachment("feishu", resource)),
    ]);

    // 群聊准入:被 @ 直接放行;未 @ 时观察模式作上下文候选,否则留痕丢弃。
    const observe = isGroup && mentions.length === 0;
    if (observe && !this.config.observeGroups) {
      if (summary) {
        onDrop?.({
          origin,
          threadKey,
          title: t("server.title.feishuGroup", { text: titleText(summary) }),
          text: summary,
          sender: `feishu:${senderOpenId}`,
          reason: t("server.filter.notMentioned"),
          replyTo,
        });
      }
      return null;
    }
    const chatTitle = (text: string) => t(isGroup ? "server.title.feishuGroup" : "server.title.feishuDirect", { text });
    if (observe) {
      if (!summary) return null;
      return {
        origin, threadKey, title: chatTitle(titleText(summary)), text: summary,
        sender: `feishu:${senderOpenId}`, context: true, replyTo,
      };
    }

    const forwarded = messageType === "merge_forward" ? await this.mergeForwardLines(message.message_id) : [];
    let pending = parsed.resources.map((resource) => this.pending(message.message_id!, resource, false));
    if (pending.length === 0 && message.parent_id) pending = await this.quotedAttachments(message.parent_id);
    const saved = pending.length > 0
      ? await saveAttachments("feishu", message.message_id, pending, { signal, inboxDir: this.config.inboxDir?.() })
      : [];
    const body = joinLines([
      text,
      ...(forwarded.length > 0 ? forwarded : [parsed.note]),
      ...saved.map((attachment) => describeSavedAttachment("feishu", attachment)),
    ]);
    if (!body) return null;
    const headline = text || summary || body;
    return {
      origin,
      threadKey,
      title: chatTitle(titleText(headline)),
      text: body,
      sender: `feishu:${senderOpenId}`,
      replyTo,
    };
  }
}
