import { DWClient, TOPIC_ROBOT, type DWClientDownStream } from "dingtalk-stream";
import { clearTimeout, setTimeout } from "node:timers";
import { truncate, type TriggerOrigin } from "../shared/model";
import type { ImSource, InboundMessage } from "./im";
import {
  describePendingAttachment,
  describeSavedAttachment,
  downloadBuffer,
  fileNameFromDisposition,
  InboundQueue,
  joinLines,
  saveAttachments,
  type AttachmentKind,
  type PendingAttachment,
} from "./im-attachments";

/**
 * 钉钉触发源:官方 dingtalk-stream SDK(Stream 模式 WebSocket,免公网)。
 * 与 openclaw-china/dingtalk 同一底层 SDK 与官方通道。
 * - 单聊直接响应;群聊被 @ 才会收到事件(钉钉机器人机制),去 @ 文本后取剩余。
 * - fast-path:allowUsers(staffId)/ allowChats(conversationId)白名单。
 * - 回复:消息自带的 sessionWebhook(POST,带过期时间)。
 * - 非文本内容:富文本(richText)取文字与图片;图片、文件、视频用消息里的 downloadCode
 *   经 /v1.0/robot/messageFiles/download 换临时地址下载到收件目录;语音优先用自带的
 *   转写文字(recognition),没有转写才下载音频。
 */

interface DingtalkConfig {
  clientId: string;
  clientSecret: string;
  allowUsers: string[];
  allowChats: string[];
  /** 附件收件根目录;每条消息现取。缺省用默认目录。 */
  inboxDir?: () => string;
}

/** 机器人回调的消息体(SDK 只声明了 text,其余按官方文档补齐)。 */
export interface DingtalkRobotMessage {
  msgId: string;
  msgtype: string;
  conversationId: string;
  conversationType?: string;
  senderStaffId?: string;
  senderNick?: string;
  sessionWebhook?: string;
  robotCode?: string;
  text?: { content?: string };
  /** 非文本消息的内容;可能是对象,也可能是 JSON 字符串。 */
  content?: unknown;
}

export interface DingtalkResource {
  kind: AttachmentKind;
  downloadCode: string;
  fileName?: string;
}

export interface DingtalkContent {
  text: string;
  resources: DingtalkResource[];
  note?: string;
}

const SEEN_LIMIT = 1000;
const API_BASE = "https://api.dingtalk.com";
const API_TIMEOUT_MS = 15_000;
/** access token 提前这么久视为过期。 */
const TOKEN_EARLY_REFRESH_MS = 5 * 60_000;

function contentObject(content: unknown): Record<string, unknown> {
  if (typeof content === "string") {
    try {
      const parsed = JSON.parse(content) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return content && typeof content === "object" && !Array.isArray(content) ? (content as Record<string, unknown>) : {};
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** 回调消息 → 文字 + 可下载资源。 */
export function parseDingtalkMessage(message: DingtalkRobotMessage): DingtalkContent {
  const content = contentObject(message.content);
  const code = (...keys: string[]) => keys.map((key) => str(content[key])).find(Boolean) ?? "";
  switch (message.msgtype) {
    case "text":
      return { text: message.text?.content ?? "", resources: [] };
    case "richText": {
      let elements: unknown = content.richText;
      if (typeof elements === "string") {
        try {
          elements = JSON.parse(elements);
        } catch {
          elements = [];
        }
      }
      const parts: string[] = [];
      const resources: DingtalkResource[] = [];
      for (const element of Array.isArray(elements) ? (elements as Array<Record<string, unknown>>) : []) {
        const type = str(element?.type);
        if ((!type || type === "text") && typeof element.text === "string") parts.push(element.text);
        else if (type === "picture") {
          const downloadCode = str(element.downloadCode) || str(element.pictureDownloadCode);
          if (downloadCode) resources.push({ kind: "image", downloadCode });
        }
      }
      return { text: parts.join(""), resources };
    }
    case "picture": {
      const downloadCode = code("downloadCode", "pictureDownloadCode");
      return { text: "", resources: downloadCode ? [{ kind: "image", downloadCode }] : [] };
    }
    case "file": {
      const downloadCode = code("downloadCode");
      const fileName = str(content.fileName) || undefined;
      return {
        text: "",
        resources: downloadCode ? [{ kind: "file", downloadCode, fileName }] : [],
        note: downloadCode ? undefined : `[钉钉文件]${fileName ? ` ${fileName}` : ""} 消息未带下载码`,
      };
    }
    case "video": {
      const downloadCode = code("downloadCode", "videoDownloadCode");
      return { text: "", resources: downloadCode ? [{ kind: "video", downloadCode }] : [] };
    }
    case "audio": {
      const recognition = str(content.recognition).trim();
      if (recognition) return { text: recognition, resources: [] };
      const downloadCode = code("downloadCode");
      return { text: "", resources: downloadCode ? [{ kind: "audio", downloadCode }] : [] };
    }
    default:
      return { text: "", resources: [], note: `[钉钉${message.msgtype}消息,暂不支持读取内容]` };
  }
}

export class DingtalkSource implements ImSource {
  readonly channel = "dingtalk" as const;
  private client: DWClient | null = null;
  private stopped = false;
  private seen = new Set<string>();
  private inbound = new InboundQueue("dingtalk");
  private abort: AbortController | null = null;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly config: DingtalkConfig) {}

  async start(onTrigger: (message: InboundMessage) => void): Promise<void> {
    this.stopped = false;
    const abort = new AbortController();
    this.abort = abort;
    const client = new DWClient({
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      debug: false,
      keepAlive: true,
    });
    client.registerCallbackListener(TOPIC_ROBOT, (downstream: DWClientDownStream) => {
      this.ack(downstream);
      void this.inbound.push(async () => {
        const inbound = await this.translate(downstream, abort.signal);
        if (inbound) onTrigger(inbound);
      });
    });
    this.client = client;
    await client.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.abort?.abort();
    this.abort = null;
    try {
      this.client?.disconnect();
    } catch (error) {
      console.error("[superagent] dingtalk disconnect failed", error);
    }
    this.client = null;
  }

  async send(origin: TriggerOrigin, text: string): Promise<null> {
    // replyRef = 消息自带的 sessionWebhook(有过期时间,晚到回复可能失败)。
    if (!origin.replyRef) throw new Error("dingtalk reply missing sessionWebhook");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    timeout.unref();
    try {
      const response = await fetch(origin.replyRef, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ msgtype: "text", text: { content: text } }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`dingtalk webhook reply failed: HTTP ${response.status}`);
      }
      const result = await response.json() as { errcode?: number };
      if (result.errcode !== 0) throw new Error(`dingtalk reply rejected (${result.errcode})`);
    } finally {
      clearTimeout(timeout);
    }
    // sessionWebhook 回执不带消息 id。
    return null;
  }

  /** 服务端依赖回调 ACK 防重推(60s 未响应会重发)。 */
  private ack(downstream: DWClientDownStream): void {
    const messageId = downstream.headers?.messageId;
    if (messageId) this.client?.socketCallBackResponse(messageId, {});
  }

  private async postJson<T>(path: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    timer.unref?.();
    try {
      const response = await fetch(`${API_BASE}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      // 错误响应体可能回显凭据,只带状态码。
      if (!response.ok) throw new Error(`钉钉接口 ${path} 返回 HTTP ${response.status}`);
      return (await response.json()) as T;
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`钉钉接口 ${path} 超时`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 企业内部应用 access token(新版接口),缓存到过期前 5 分钟。 */
  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now()) return this.token.value;
    const result = await this.postJson<{ accessToken?: string; expireIn?: number }>("/v1.0/oauth2/accessToken", {
      appKey: this.config.clientId,
      appSecret: this.config.clientSecret,
    });
    if (!result.accessToken) throw new Error("钉钉没有返回 access token");
    const lifetimeMs = (result.expireIn ?? 7200) * 1000;
    this.token = { value: result.accessToken, expiresAt: Date.now() + Math.max(lifetimeMs - TOKEN_EARLY_REFRESH_MS, 60_000) };
    return result.accessToken;
  }

  private pending(resource: DingtalkResource, robotCode: string): PendingAttachment {
    return {
      kind: resource.kind,
      fileName: resource.fileName,
      quoted: false,
      download: async (signal) => {
        const token = await this.accessToken();
        const { downloadUrl } = await this.postJson<{ downloadUrl?: string }>(
          "/v1.0/robot/messageFiles/download",
          { downloadCode: resource.downloadCode, robotCode },
          { "x-acs-dingtalk-access-token": token },
        );
        if (!downloadUrl) throw new Error("钉钉没有返回下载地址");
        const { data, headers } = await downloadBuffer(downloadUrl, { signal });
        return { data, fileName: fileNameFromDisposition(headers?.get("content-disposition")) };
      },
    };
  }

  async translate(downstream: DWClientDownStream, signal?: AbortSignal): Promise<InboundMessage | null> {
    if (this.stopped) return null;
    let message: DingtalkRobotMessage;
    try {
      message = JSON.parse(downstream.data) as DingtalkRobotMessage;
    } catch {
      return null;
    }
    if (!message.conversationId || !message.senderStaffId || !message.msgId) return null;
    if (this.seen.has(message.msgId)) return null;
    this.seen.add(message.msgId);
    if (this.seen.size > SEEN_LIMIT) {
      const excess = this.seen.size - SEEN_LIMIT;
      for (const id of [...this.seen].slice(0, excess)) this.seen.delete(id);
    }
    const allowed =
      this.config.allowUsers.includes(message.senderStaffId) ||
      this.config.allowChats.includes(message.conversationId);
    if (!allowed) return null;

    const parsed = parseDingtalkMessage(message);
    // 群聊被 @ 时文字带 "@机器人名 " 前缀;去掉首个 @ 词。
    const text = parsed.text.replace(/^@\S+\s?/, "").trim();
    const robotCode = message.robotCode || this.config.clientId;
    const saved = parsed.resources.length > 0
      ? await saveAttachments("dingtalk", message.msgId, parsed.resources.map((resource) => this.pending(resource, robotCode)), {
          signal,
          inboxDir: this.config.inboxDir?.(),
        })
      : [];
    const body = joinLines([text, parsed.note, ...saved.map((attachment) => describeSavedAttachment("dingtalk", attachment))]);
    if (!body) return null;
    const headline = text || parsed.note || parsed.resources.map((item) => describePendingAttachment("dingtalk", item)).join(" ");

    const isGroup = message.conversationType === "2";
    const origin: TriggerOrigin = {
      channel: "dingtalk",
      accountId: this.config.clientId,
      chatId: message.conversationId,
      messageId: message.msgId,
      replyRef: message.sessionWebhook ?? null,
      senderId: message.senderStaffId,
      senderName: message.senderNick ?? null,
    };
    return {
      origin,
      threadKey: `dingtalk:conv:${message.conversationId}`,
      title: `${isGroup ? "钉钉群" : "钉钉私聊"} ${truncate(headline, 40)}`,
      text: body,
      sender: `dingtalk:${message.senderStaffId}`,
    };
  }
}
