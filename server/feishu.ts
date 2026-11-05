import { truncate, type TriggerOrigin } from "../shared/model";
import type { DropHandler, ImSource, InboundDrop, InboundMessage } from "./im";

/**
 * 飞书触发源:官方 SDK 长连接(WSClient),无需公网回调。
 * - 私聊直接响应;群聊仅在被 @ 机器人时响应(去 @ 后取剩余文本)。
 * - 群聊观察模式(observeGroups):未 @ 的群消息不再丢弃,作为上下文交给 Router 判断。
 * - fast-path:allowUsers(open_id)/ allowChats(chat_id)白名单,命中即放行。
 * - 回复用 message.reply 引用回复,来源消息去重(message_id 环形集)。
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
}

interface LarkMessageEvent {
  sender?: { sender_id?: { open_id?: string }; sender_type?: string };
  message?: {
    message_id?: string;
    root_id?: string | null;
    chat_id?: string;
    chat_type?: string;
    message_type?: string;
    content?: string;
    mentions?: Array<{ key?: string; id?: { open_id?: string }; name?: string }>;
  };
}

const SEEN_LIMIT = 1000;

type LarkClient = InstanceType<LarkModule["Client"]>;
type LarkWsClient = InstanceType<LarkModule["WSClient"]>;

export class FeishuSource implements ImSource {
  readonly channel = "feishu" as const;
  private client: LarkClient | null = null;
  private wsClient: LarkWsClient | null = null;
  private stopped = false;
  private seen = new Set<string>();

  constructor(private readonly config: FeishuConfig) {}

  async start(onTrigger: (message: InboundMessage) => void, onDrop?: (drop: InboundDrop) => void): Promise<void> {
    this.stopped = false;
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
      "im.message.receive_v1": async (data: LarkMessageEvent) => {
        const inbound = this.translate(data, onDrop);
        if (inbound) onTrigger(inbound);
      },
    });
    await this.wsClient.start({ eventDispatcher: dispatcher });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    try {
      this.wsClient?.close({ force: true });
    } finally {
      this.wsClient = null;
      this.client = null;
    }
  }

  async send(origin: TriggerOrigin, text: string): Promise<void> {
    const client = this.requireClient();
    if (origin.messageId) {
      const result = await client.im.v1.message.reply({
        path: { message_id: origin.messageId },
        data: { msg_type: "text", content: JSON.stringify({ text }) },
      });
      if (result.code !== 0) throw new Error(`feishu reply rejected (${result.code})`);
      return;
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
  }

  private requireClient(): LarkClient {
    if (!this.client) throw new Error("feishu source is not started");
    return this.client;
  }

  /** 事件 → InboundMessage;fast-path 拒绝返回 null;准入丢弃经 onDrop 留痕。 */
  private translate(data: LarkMessageEvent, onDrop?: (drop: InboundDrop) => void): InboundMessage | null {
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
    if (message.message_type !== "text") return null;

    let text = "";
    try {
      const parsed = JSON.parse(message.content ?? "{}") as { text?: string };
      text = parsed.text ?? "";
    } catch {
      return null;
    }
    const mentions = message.mentions ?? [];
    const isGroup = message.chat_type === "group";
    // 群聊准入:被 @ 直接放行;未 @ 时观察模式作上下文候选,否则留痕丢弃。
    const observe = isGroup && mentions.length === 0;
    if (observe && !this.config.observeGroups) {
      onDrop?.({
        origin: {
          channel: "feishu",
          chatId: message.chat_id,
          messageId: message.message_id,
          senderId: senderOpenId,
          senderName: null,
        },
        threadKey: message.root_id
          ? `feishu:chat:${message.chat_id}:root:${message.root_id}`
          : `feishu:chat:${message.chat_id}`,
        title: `飞书群 ${truncate(text, 40)}`,
        text,
        sender: `feishu:${senderOpenId}`,
        reason: "群消息未 @ 机器人",
      });
      return null;
    }
    // 去掉所有 @_user_N 占位。
    text = text.replace(/@_user_\d+/g, "").trim();
    if (!text) return null;

    const chatLabel = isGroup ? "飞书群" : "飞书私聊";
    const origin: TriggerOrigin = {
      channel: "feishu",
      chatId: message.chat_id,
      messageId: message.message_id,
      senderId: senderOpenId,
      senderName: null,
    };
    const threadKey = message.root_id
      ? `feishu:chat:${message.chat_id}:root:${message.root_id}`
      : `feishu:chat:${message.chat_id}`;
    return {
      origin,
      threadKey,
      title: `${chatLabel} ${truncate(text, 40)}`,
      text,
      sender: `feishu:${senderOpenId}`,
      context: observe || undefined,
    };
  }
}
