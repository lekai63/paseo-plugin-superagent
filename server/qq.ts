import { truncate, type TriggerOrigin } from "../shared/model";
import type { ImSource, InboundDrop, InboundMessage } from "./im";

/**
 * QQ 触发源:OneBot 11 正向 WebSocket(NapCat / Lagrange 等实现)。
 * - 私聊直接响应;群聊仅在被 @ 机器人(QQ 号 = self_id)时响应。
 * - 群聊观察模式(observeGroups):未 @ 的群消息不再丢弃,作为上下文交给 Router 判断。
 * - fast-path:allowUsers(QQ 号)/ allowGroups(群号)白名单。
 * - 回复带 reply 段引用原消息;断线指数退避重连。
 */

interface QqConfig {
  endpoint: string;
  token: string;
  allowUsers: string[];
  allowGroups: string[];
  /** 群聊观察模式:未 @ 机器人的群消息作为上下文触发(否则记 filtered 留痕)。 */
  observeGroups: boolean;
}

interface OneBotEvent {
  post_type?: string;
  message_type?: "group" | "private";
  sub_type?: string;
  group_id?: number;
  user_id?: number;
  self_id?: number;
  message_id?: number;
  message?: unknown;
  raw_message?: string;
  time?: number;
}

interface OneBotResponse {
  echo?: string;
  status?: string;
  retcode?: number;
}

const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;

type RawSegment = { type: string; data: Record<string, unknown> };

/** OneBot message 字段(段数组或 CQ 字符串)→ 纯文本 + 是否 @ 机器人。 */
function extractText(message: unknown, raw: string, selfId: string): { text: string; addressed: boolean } {
  if (Array.isArray(message)) {
    let addressed = false;
    const parts: string[] = [];
    for (const segment of message as RawSegment[]) {
      if (segment?.type === "at") {
        if (String(segment.data?.qq ?? "") === selfId) addressed = true;
        continue;
      }
      if (segment?.type === "text") parts.push(String(segment.data?.text ?? ""));
    }
    return { text: parts.join(" ").trim(), addressed };
  }
  const addressed = new RegExp(`\\[CQ:at[^\\]]*qq=${selfId}[^\\]]*\\]`).test(raw);
  const text = raw.replace(/\[CQ:[^\]]+\]/g, "").trim();
  return { text, addressed };
}

export class QqSource implements ImSource {
  readonly channel = "qq" as const;
  private socket: WebSocket | null = null;
  private stopped = false;
  private reconnectAttempts = 0;
  private echoCounter = 0;
  private readonly pending = new Map<string, { resolve(): void; reject(error: Error): void }>();

  constructor(private readonly config: QqConfig) {}

  async start(onTrigger: (message: InboundMessage) => void, onDrop?: (drop: InboundDrop) => void): Promise<void> {
    this.stopped = false;
    await this.connect(onTrigger, onDrop);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.socket?.close(1000, "superagent stop");
    this.socket = null;
    this.rejectAllPending(new Error("QQ source stopped"));
  }

  async send(origin: TriggerOrigin, text: string): Promise<void> {
    const isGroup = origin.chatId.startsWith("g:");
    const target = origin.chatId.slice(2);
    const replySegment =
      origin.messageId && Number.isFinite(Number(origin.messageId))
        ? [{ type: "reply", data: { id: Number(origin.messageId) } }]
        : [];
    const action = isGroup ? "send_group_msg" : "send_private_msg";
    const params = isGroup
      ? { group_id: Number(target), message: [...replySegment, { type: "text", data: { text } }] }
      : { user_id: Number(target), message: [...replySegment, { type: "text", data: { text } }] };
    await this.call(action, params);
  }

  private connect(onTrigger: (message: InboundMessage) => void, onDrop?: (drop: InboundDrop) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.stopped) return reject(new Error("stopped"));
      const socket = new WebSocket(this.config.endpoint, this.config.token ? ["Bearer", this.config.token] : undefined);
      this.socket = socket;
      let opened = false;
      socket.addEventListener("open", () => {
        opened = true;
        this.reconnectAttempts = 0;
        console.log(`[superagent] QQ OneBot connected: ${this.config.endpoint}`);
        resolve();
      });
      socket.addEventListener("message", (event) => {
        this.handleFrame(String(event.data), onTrigger, onDrop);
      });
      socket.addEventListener("close", () => {
        this.rejectAllPending(new Error("QQ OneBot connection closed"));
        if (this.stopped) return;
        const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempts, RECONNECT_MAX_MS);
        this.reconnectAttempts += 1;
        console.warn(`[superagent] QQ OneBot closed; reconnect in ${delay}ms`);
        setTimeout(() => {
          if (this.stopped) return;
          this.connect(onTrigger, onDrop).catch((error) => {
            console.error("[superagent] QQ OneBot reconnect failed", error);
          });
        }, delay);
        if (!opened) reject(new Error(`QQ OneBot connect failed: ${this.config.endpoint}`));
      });
      socket.addEventListener("error", () => {
        /* close handler 负责 reconnect 与 reject */
      });
    });
  }

  private handleFrame(raw: string, onTrigger: (message: InboundMessage) => void, onDrop?: (drop: InboundDrop) => void): void {
    let frame: OneBotEvent & OneBotResponse;
    try {
      frame = JSON.parse(raw) as OneBotEvent & OneBotResponse;
    } catch {
      return;
    }
    if (frame.echo !== undefined) {
      const waiter = this.pending.get(frame.echo);
      if (waiter) {
        this.pending.delete(frame.echo);
        if (frame.status === "ok" || frame.retcode === 0) waiter.resolve();
        else waiter.reject(new Error(`OneBot ${frame.echo} failed: ${frame.status ?? frame.retcode}`));
      }
      return;
    }
    if (frame.post_type !== "message") return;
    const inbound = this.translate(frame, onDrop);
    if (inbound) onTrigger(inbound);
  }

  /** 事件 → InboundMessage;fast-path 拒绝返回 null;准入丢弃经 onDrop 留痕。 */
  private translate(event: OneBotEvent, onDrop?: (drop: InboundDrop) => void): InboundMessage | null {
    const userId = event.user_id !== undefined ? String(event.user_id) : "";
    if (!userId) return null;
    if (!this.config.allowUsers.includes(userId)) return null;
    const selfId = event.self_id !== undefined ? String(event.self_id) : "";
    const raw = event.raw_message ?? "";
    const { text, addressed } = extractText(event.message, raw, selfId);
    if (event.message_type === "group") {
      const groupId = event.group_id !== undefined ? String(event.group_id) : "";
      if (!groupId || !this.config.allowGroups.includes(groupId)) return null;
      // 群聊准入:被 @ 直接放行;未 @ 时观察模式作上下文候选,否则留痕丢弃。
      if (!addressed) {
        if (this.config.observeGroups) {
          if (!text) return null;
          return {
            origin: {
              channel: "qq",
              chatId: `g:${groupId}`,
              messageId: event.message_id !== undefined ? String(event.message_id) : null,
              senderId: userId,
              senderName: null,
            },
            threadKey: `qq:group:${groupId}`,
            title: `QQ群 ${truncate(text, 40)}`,
            text,
            sender: `qq:${userId}`,
            context: true,
          };
        }
        onDrop?.({
          origin: {
            channel: "qq",
            chatId: `g:${groupId}`,
            messageId: event.message_id !== undefined ? String(event.message_id) : null,
            senderId: userId,
            senderName: null,
          },
          threadKey: `qq:group:${groupId}`,
          title: `QQ群 ${truncate(text, 40)}`,
          text,
          sender: `qq:${userId}`,
          reason: "群消息未 @ 机器人",
        });
        return null;
      }
      if (!text) return null;
      const origin: TriggerOrigin = {
        channel: "qq",
        chatId: `g:${groupId}`,
        messageId: event.message_id !== undefined ? String(event.message_id) : null,
        senderId: userId,
        senderName: null,
      };
      return {
        origin,
        threadKey: `qq:group:${groupId}`,
        title: `QQ群 ${truncate(text, 40)}`,
        text,
        sender: `qq:${userId}`,
      };
    }
    if (event.message_type === "private") {
      if (!text) return null;
      const origin: TriggerOrigin = {
        channel: "qq",
        chatId: `u:${userId}`,
        messageId: event.message_id !== undefined ? String(event.message_id) : null,
        senderId: userId,
        senderName: null,
      };
      return {
        origin,
        threadKey: `qq:friend:${userId}`,
        title: `QQ私聊 ${truncate(text, 40)}`,
        text,
        sender: `qq:${userId}`,
      };
    }
    return null;
  }

  private call(action: string, params: Record<string, unknown>): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("QQ OneBot socket is not open"));
    }
    const echo = `superagent-${++this.echoCounter}`;
    return new Promise((resolve, reject) => {
      this.pending.set(echo, { resolve, reject });
      socket.send(JSON.stringify({ action, params, echo }));
      setTimeout(() => {
        if (this.pending.delete(echo)) reject(new Error(`OneBot ${action} timed out`));
      }, 15_000);
    });
  }

  private rejectAllPending(error: Error): void {
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }
}
