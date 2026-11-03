import { WSClient, type TextMessage, type WsFrame } from "@wecom/aibot-node-sdk";
import { truncate, type TriggerOrigin } from "../shared/model";
import type { ImSource, InboundMessage } from "./im";

/**
 * 企业微信触发源:官方 @wecom/aibot-node-sdk(智能机器人 WebSocket 长连接,免公网)。
 * 与 openclaw-china/wecom 同一底层 SDK 与官方通道。
 * - 单聊直接响应;群聊被 @ 才会收到事件。
 * - fast-path:allowUsers(userid)/ allowChats(chatid,群)白名单。
 * - 回复:通过 chatId 主动发送独立消息,分段不复用已完成的 req_id 流。
 */

type WeComClient = InstanceType<typeof WSClient>;

interface WecomConfig {
  botId: string;
  secret: string;
  allowUsers: string[];
  allowChats: string[];
}

const SEEN_LIMIT = 1000;

export class WecomSource implements ImSource {
  readonly channel = "wecom" as const;
  private client: WeComClient | null = null;
  private stopped = false;
  private seen = new Set<string>();

  constructor(private readonly config: WecomConfig) {}

  async start(onTrigger: (message: InboundMessage) => void): Promise<void> {
    this.stopped = false;
    const client = new WSClient({
      botId: this.config.botId,
      secret: this.config.secret,
      maxReconnectAttempts: -1,
    });
    client.on("message.text", (frame: WsFrame<TextMessage>) => {
      const inbound = this.translate(frame);
      if (inbound) onTrigger(inbound);
    });
    this.client = client;
    client.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    try {
      this.client?.disconnect();
    } catch (error) {
      console.error("[superagent] wecom disconnect failed", error);
    }
    this.client = null;
  }

  async send(origin: TriggerOrigin, text: string): Promise<void> {
    const client = this.client;
    if (!client) throw new Error("wecom source is not started");
    const result = await client.sendMessage(origin.chatId, { msgtype: "markdown", markdown: { content: text } });
    if (result.errcode !== 0) throw new Error(`wecom send rejected (${result.errcode})`);
  }

  private translate(frame: WsFrame<TextMessage>): InboundMessage | null {
    if (this.stopped) return null;
    const message = frame?.body;
    const reqId = frame?.headers?.req_id;
    if (!message || typeof reqId !== "string") return null;
    if (!message.from?.userid) return null;
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

    // 群聊被 @ 时可能带 @机器人名 前缀;去掉首个 @ 词。
    const text = (message.text?.content ?? "")
      .replace(/^@\S+\s?/, "")
      .trim();
    if (!text) return null;

    const origin: TriggerOrigin = {
      channel: "wecom",
      chatId,
      messageId: message.msgid,
      replyRef: reqId,
      senderId: message.from.userid,
      senderName: null,
    };
    return {
      origin,
      threadKey: `wecom:chat:${chatId}`,
      title: `${isGroup ? "企微群" : "企微私聊"} ${truncate(text, 40)}`,
      text,
      sender: `wecom:${message.from.userid}`,
    };
  }
}
