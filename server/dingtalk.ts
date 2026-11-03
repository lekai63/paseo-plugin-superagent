import { DWClient, TOPIC_ROBOT, type DWClientDownStream, type RobotTextMessage } from "dingtalk-stream";
import { truncate, type TriggerOrigin } from "../shared/model";
import type { ImSource, InboundMessage } from "./im";

/**
 * 钉钉触发源:官方 dingtalk-stream SDK(Stream 模式 WebSocket,免公网)。
 * 与 openclaw-china/dingtalk 同一底层 SDK 与官方通道。
 * - 单聊直接响应;群聊被 @ 才会收到事件(钉钉机器人机制),去 @ 文本后取剩余。
 * - fast-path:allowUsers(staffId)/ allowChats(conversationId)白名单。
 * - 回复:消息自带的 sessionWebhook(POST,带过期时间)。
 */

interface DingtalkConfig {
  clientId: string;
  clientSecret: string;
  allowUsers: string[];
  allowChats: string[];
}

const SEEN_LIMIT = 1000;

export class DingtalkSource implements ImSource {
  readonly channel = "dingtalk" as const;
  private client: DWClient | null = null;
  private stopped = false;
  private seen = new Set<string>();

  constructor(private readonly config: DingtalkConfig) {}

  async start(onTrigger: (message: InboundMessage) => void): Promise<void> {
    this.stopped = false;
    const client = new DWClient({
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      debug: false,
      keepAlive: true,
    });
    client.registerCallbackListener(TOPIC_ROBOT, (downstream: DWClientDownStream) => {
      this.ack(downstream);
      const inbound = this.translate(downstream);
      if (inbound) onTrigger(inbound);
    });
    this.client = client;
    await client.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    try {
      this.client?.disconnect();
    } catch (error) {
      console.error("[superagent] dingtalk disconnect failed", error);
    }
    this.client = null;
  }

  async send(origin: TriggerOrigin, text: string): Promise<void> {
    // replyRef = 消息自带的 sessionWebhook(有过期时间,晚到回复可能失败)。
    if (!origin.replyRef) throw new Error("dingtalk reply missing sessionWebhook");
    const response = await fetch(origin.replyRef, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msgtype: "text", text: { content: text } }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`dingtalk webhook reply failed: HTTP ${response.status}`);
    }
    const result = await response.json() as { errcode?: number };
    if (result.errcode !== 0) throw new Error(`dingtalk reply rejected (${result.errcode})`);
  }

  /** 服务端依赖回调 ACK 防重推(60s 未响应会重发)。 */
  private ack(downstream: DWClientDownStream): void {
    const messageId = downstream.headers?.messageId;
    if (messageId) this.client?.socketCallBackResponse(messageId, {});
  }

  private translate(downstream: DWClientDownStream): InboundMessage | null {
    if (this.stopped) return null;
    let message: RobotTextMessage;
    try {
      message = JSON.parse(downstream.data) as RobotTextMessage;
    } catch {
      return null;
    }
    if (message.msgtype !== "text" || !message.conversationId || !message.senderStaffId) return null;
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

    // 群聊被 @ 时 content 带 "@机器人名 " 前缀;去掉首个 @ 词。
    const text = (message.text?.content ?? "")
      .replace(/^@\S+\s?/, "")
      .trim();
    if (!text) return null;

    const isGroup = message.conversationType === "2";
    const origin: TriggerOrigin = {
      channel: "dingtalk",
      chatId: message.conversationId,
      messageId: message.msgId,
      replyRef: message.sessionWebhook ?? null,
      senderId: message.senderStaffId,
      senderName: message.senderNick ?? null,
    };
    return {
      origin,
      threadKey: `dingtalk:conv:${message.conversationId}`,
      title: `${isGroup ? "钉钉群" : "钉钉私聊"} ${truncate(text, 40)}`,
      text,
      sender: `dingtalk:${message.senderStaffId}`,
    };
  }
}
