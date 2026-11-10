import { randomUUID } from "node:crypto";
import { clearTimeout, setTimeout } from "node:timers";
import { truncate, type TriggerOrigin } from "../shared/model";
import type { ImSource, InboundDrop, InboundMessage } from "./im";
import {
  baseInfo,
  isAbortError,
  weixinPost,
  WEIXIN_STALE_TOKEN_ERRCODE,
  WeixinItemType,
  WeixinMessageState,
  WeixinMessageType,
  type GetUpdatesResponse,
  type SendMessageResponse,
  type WeixinMessage,
  type WeixinMessageItem,
} from "./weixin-api";
import {
  describeWeixinAttachment,
  describeWeixinMediaRef,
  saveWeixinAttachments,
  weixinMediaRefs,
} from "./weixin-media";
import { loadWeixinCursor, saveWeixinCursor, type WeixinAccount } from "./weixin-store";

/**
 * 微信触发源:腾讯官方 iLink Bot 协议(微信 ClawBot),HTTP 长轮询,免公网。
 * - 扫码登录得到 bot 凭证(见 weixin-login.ts);一个 bot 对应一个微信个人号,仅支持私聊。
 * - fast-path:allowUsers(xxx@im.wechat)白名单,扫码人自动在内。
 * - 回复必须带入站消息的 context_token:按用户记最新一枚,重启后回落到触发记录里保存的那枚。
 * - 群消息(group_id)官方插件也未支持:白名单命中时记 filtered 留痕,不触发。
 * - 图片/文件/视频下载解密到本机收件目录,路径写进触发正文(见 weixin-media.ts)。
 */

interface WeixinConfig {
  account: WeixinAccount;
  allowUsers: string[];
  /** 附件收件根目录;每条消息现取,改设置不必重启通道。缺省用默认目录。 */
  inboxDir?: () => string;
}

export interface WeixinSourceStatus {
  state: "starting" | "polling" | "retrying" | "paused" | "stopped";
  lastError: string | null;
  lastPollAt: string | null;
  lastInboundAt: string | null;
  pausedUntil: string | null;
}

const SEEN_LIMIT = 1000;
const DEFAULT_LONG_POLL_MS = 35_000;
/** 客户端超时比服务端挂起时长多留一点,避免恰好在返回前中断。 */
const LONG_POLL_MARGIN_MS = 5_000;
const SEND_TIMEOUT_MS = 15_000;
const NOTIFY_TIMEOUT_MS = 3_000;
const RETRY_DELAY_MS = 2_000;
const BACKOFF_DELAY_MS = 30_000;
const MAX_CONSECUTIVE_FAILURES = 3;
/** token 失效(-14)后的暂停时长,与官方插件一致。 */
const STALE_PAUSE_MS = 60 * 60_000;

type TriggerHandler = (message: InboundMessage) => void;
type DropHandler = (drop: InboundDrop) => void;

function businessError(response: { ret?: number; errcode?: number }): number | null {
  if (typeof response.ret === "number" && response.ret !== 0) return response.ret;
  if (typeof response.errcode === "number" && response.errcode !== 0) return response.errcode;
  return null;
}

/** 文本段 + 语音转写拼成正文;引用(ref_msg)的平台消息 id 作为 replyTo。 */
export function extractWeixinText(items: WeixinMessageItem[] = []): { text: string; replyTo: string[] } {
  const parts: string[] = [];
  const replyTo: string[] = [];
  for (const item of items) {
    if (item.type === WeixinItemType.TEXT && item.text_item?.text) parts.push(item.text_item.text);
    else if (item.type === WeixinItemType.VOICE && item.voice_item?.text) parts.push(item.voice_item.text);
    const ref = item.ref_msg;
    const refId = ref?.svr_id?.trim() || ref?.message_item?.msg_id?.trim();
    if (refId && !replyTo.includes(refId)) replyTo.push(refId);
  }
  return { text: parts.join("\n").trim(), replyTo };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export class WeixinSource implements ImSource {
  readonly channel = "weixin" as const;
  private abort: AbortController | null = null;
  private loop: Promise<void> | null = null;
  private seen = new Set<string>();
  /** 用户 → 最近一条私聊消息的 context_token。 */
  private contextTokens = new Map<string, string>();
  private current: WeixinSourceStatus = {
    state: "stopped", lastError: null, lastPollAt: null, lastInboundAt: null, pausedUntil: null,
  };

  constructor(private readonly config: WeixinConfig) {}

  status(): WeixinSourceStatus {
    return { ...this.current };
  }

  async start(onTrigger: TriggerHandler, onDrop?: DropHandler): Promise<void> {
    const abort = new AbortController();
    this.abort = abort;
    this.current = { ...this.current, state: "starting", lastError: null, pausedUntil: null };
    void this.notify("ilink/bot/msg/notifystart");
    this.loop = this.run(abort.signal, onTrigger, onDrop).catch((error) => {
      console.error("[superagent] weixin poll loop crashed", error);
      this.current = { ...this.current, state: "stopped", lastError: "轮询异常退出,请查看 daemon 日志" };
    });
  }

  async stop(): Promise<void> {
    const abort = this.abort;
    if (!abort) return;
    this.abort = null;
    abort.abort();
    await this.loop;
    this.loop = null;
    this.current = { ...this.current, state: "stopped" };
    await this.notify("ilink/bot/msg/notifystop");
  }

  async send(origin: TriggerOrigin, text: string): Promise<string | null> {
    const { account } = this.config;
    const contextToken = this.contextTokens.get(origin.chatId) ?? origin.replyRef ?? undefined;
    const response = await weixinPost<SendMessageResponse>(
      account.baseUrl,
      "ilink/bot/sendmessage",
      {
        msg: {
          from_user_id: "",
          to_user_id: origin.chatId,
          client_id: `superagent-${randomUUID()}`,
          message_type: WeixinMessageType.BOT,
          message_state: WeixinMessageState.FINISH,
          context_token: contextToken,
          item_list: [{ type: WeixinItemType.TEXT, text_item: { text } }],
        },
        base_info: baseInfo(),
      },
      { token: account.token, timeoutMs: SEND_TIMEOUT_MS },
    );
    const code = businessError(response);
    if (code !== null) throw new Error(`weixin send rejected (${code})`);
    return response.message_id != null ? String(response.message_id) : null;
  }

  /** 生命周期通知:失败只记日志,不影响启停。 */
  private async notify(endpoint: string): Promise<void> {
    const { account } = this.config;
    try {
      const response = await weixinPost<{ ret?: number; errcode?: number }>(
        account.baseUrl, endpoint, { base_info: baseInfo() }, { token: account.token, timeoutMs: NOTIFY_TIMEOUT_MS },
      );
      const code = businessError(response);
      if (code !== null) console.warn(`[superagent] weixin ${endpoint} returned ${code}`);
    } catch (error) {
      console.warn(`[superagent] weixin ${endpoint} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async run(signal: AbortSignal, onTrigger: TriggerHandler, onDrop?: DropHandler): Promise<void> {
    const { account } = this.config;
    let cursor = await loadWeixinCursor(account.botId).catch(() => "");
    let longPollMs = DEFAULT_LONG_POLL_MS;
    let failures = 0;
    const fail = async (message: string) => {
      failures += 1;
      this.current = { ...this.current, state: "retrying", lastError: message };
      console.warn(`[superagent] weixin getupdates: ${message} (${failures}/${MAX_CONSECUTIVE_FAILURES})`);
      const backoff = failures >= MAX_CONSECUTIVE_FAILURES;
      if (backoff) failures = 0;
      await sleep(backoff ? BACKOFF_DELAY_MS : RETRY_DELAY_MS, signal);
    };

    while (!signal.aborted) {
      let response: GetUpdatesResponse;
      try {
        response = await weixinPost<GetUpdatesResponse>(
          account.baseUrl,
          "ilink/bot/getupdates",
          { get_updates_buf: cursor, base_info: baseInfo() },
          { token: account.token, timeoutMs: longPollMs + LONG_POLL_MARGIN_MS, signal },
        );
      } catch (error) {
        if (signal.aborted) break;
        // 客户端长轮询超时:正常,直接下一轮。
        if (isAbortError(error)) continue;
        await fail(error instanceof Error ? error.message : String(error));
        continue;
      }
      if (typeof response.longpolling_timeout_ms === "number" && response.longpolling_timeout_ms > 0) {
        longPollMs = response.longpolling_timeout_ms;
      }
      const code = businessError(response);
      if (code === WEIXIN_STALE_TOKEN_ERRCODE) {
        failures = 0;
        const pausedUntil = new Date(Date.now() + STALE_PAUSE_MS).toISOString();
        this.current = {
          ...this.current,
          state: "paused",
          pausedUntil,
          lastError: "微信会话已失效(-14),暂停 1 小时后重试;持续失效请重新扫码登录",
        };
        console.warn("[superagent] weixin bot token is stale; pausing for 1 hour");
        await sleep(STALE_PAUSE_MS, signal);
        continue;
      }
      if (code !== null) {
        await fail(`getupdates 返回 ${code}${response.errmsg ? ` ${response.errmsg}` : ""}`);
        continue;
      }
      failures = 0;
      const now = new Date().toISOString();
      this.current = { ...this.current, state: "polling", lastError: null, pausedUntil: null, lastPollAt: now };
      for (const message of response.msgs ?? []) {
        if (signal.aborted) return;
        try {
          // 附件在这里同步下载完再派发,保证同一用户的消息按到达顺序进入 Router。
          const inbound = await this.translate(message, onDrop, signal);
          if (!inbound) continue;
          this.current = { ...this.current, lastInboundAt: now };
          onTrigger(inbound);
        } catch (error) {
          console.error("[superagent] weixin inbound message handling failed", error);
        }
      }
      if (response.get_updates_buf) {
        cursor = response.get_updates_buf;
        await saveWeixinCursor(account.botId, cursor).catch((error) => {
          console.error("[superagent] weixin cursor persist failed", error);
        });
      }
    }
  }

  /** 消息 → InboundMessage(附件已落盘);fast-path 拒绝返回 null;群消息经 onDrop 留痕。 */
  async translate(message: WeixinMessage, onDrop?: DropHandler, signal?: AbortSignal): Promise<InboundMessage | null> {
    if (message.message_type !== WeixinMessageType.USER) return null;
    const from = message.from_user_id?.trim();
    if (!from) return null;
    const messageId =
      message.message_id?.trim() || message.item_list?.map((item) => item.msg_id?.trim()).find(Boolean) || null;
    if (messageId) {
      if (this.seen.has(messageId)) return null;
      this.seen.add(messageId);
      if (this.seen.size > SEEN_LIMIT) {
        const excess = this.seen.size - SEEN_LIMIT;
        for (const id of [...this.seen].slice(0, excess)) this.seen.delete(id);
      }
    }
    if (!this.config.allowUsers.includes(from)) return null;
    const { text, replyTo } = extractWeixinText(message.item_list);
    const media = weixinMediaRefs(message.item_list);
    const sender = `weixin:${from}`;

    const groupId = message.group_id?.trim();
    if (groupId) {
      // 群里的 context_token 属于群会话,不能拿来回私聊,因此不记;群附件也不下载。
      const summary = [text, ...media.map(describeWeixinMediaRef)].filter(Boolean).join("\n");
      if (summary) {
        onDrop?.({
          origin: { channel: "weixin", chatId: groupId, messageId, senderId: from, senderName: null },
          threadKey: `weixin:group:${groupId}`,
          title: `微信群 ${truncate(summary, 40)}`,
          text: summary,
          sender,
          reason: "微信群消息暂不支持",
          replyTo,
        });
      }
      return null;
    }
    if (message.context_token) this.contextTokens.set(from, message.context_token);
    if (!text && media.length === 0) {
      const types = (message.item_list ?? []).map((item) => item.type ?? "?").join(",") || "none";
      console.log(`[superagent] weixin message ${messageId ?? "?"} ignored: no text or attachment (item types: ${types})`);
      return null;
    }
    const attachments = media.length > 0 ? await saveWeixinAttachments(media, messageId, { signal, inboxDir: this.config.inboxDir?.() }) : [];
    for (const attachment of attachments) {
      if (attachment.path) console.log(`[superagent] weixin ${attachment.kind} saved: ${attachment.path} (${attachment.bytes} bytes)`);
      else console.warn(`[superagent] weixin ${attachment.kind} ${attachment.name ?? ""} download failed: ${attachment.error}`);
    }
    const body = [text, ...attachments.map(describeWeixinAttachment)].filter(Boolean).join("\n");
    const headline = text || media.map(describeWeixinMediaRef).join(" ");
    return {
      origin: {
        channel: "weixin",
        chatId: from,
        messageId,
        replyRef: message.context_token ?? null,
        senderId: from,
        senderName: null,
      },
      threadKey: `weixin:user:${from}`,
      title: `微信 ${truncate(headline, 40)}`,
      text: body,
      sender,
      replyTo,
    };
  }
}
