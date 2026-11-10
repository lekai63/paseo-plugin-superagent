import path from "node:path";
import type { TriggerOrigin } from "../shared/model";
import type { ReplySink } from "./engine";
import { resolvePaseoHome } from "./store";

/**
 * IM 附件的收件根目录(各通道再分子目录,如 `weixin/`)。设置 imInboxDir 留空或不是
 * 绝对路径时用默认的 `$PASEO_HOME/plugin-data/superagent/inbox`。
 */
export function resolveImInboxDir(configured: string | undefined): string {
  const value = configured?.trim() ?? "";
  if (value && path.isAbsolute(value)) return path.resolve(value);
  if (value) console.warn(`[superagent] imInboxDir ${JSON.stringify(value)} is not an absolute path; using the default inbox`);
  return path.join(resolvePaseoHome(), "plugin-data", "superagent", "inbox");
}

/** IM 入站消息(经 fast-path 白名单后)交给引擎的统一形状。 */
export interface InboundMessage {
  origin: TriggerOrigin;
  /** 稳定线程键:同键消息归属同一 Thread。 */
  threadKey: string;
  /** 新线程标题(仅首次建线程时使用)。 */
  title: string;
  text: string;
  sender: string;
  /** 上下文补充(观察模式的未 @ 群消息):不单独要求行动,Router 只做判断。 */
  context?: boolean;
  /**
   * 这条消息引用/回复的平台消息 id(直接父消息在前,回复链根消息在后)。引擎据此
   * 把回复归入被引用消息所在的线程,并把被引用内容内联给 Router(§3.3)。
   */
  replyTo?: string[];
}

/**
 * fast-path 丢弃留痕(§3.1):白名单已命中但被准入规则挡下的消息(如群聊未 @)。
 * 携带完整触发信息,引擎记为 filtered 触发,不再静默丢弃。
 */
export interface InboundDrop {
  origin: TriggerOrigin;
  threadKey: string;
  title: string;
  text: string;
  sender: string;
  reason: string;
  replyTo?: string[];
}

export type TriggerHandler = (message: InboundMessage) => void;
export type DropHandler = (drop: InboundDrop) => void;

export interface ImSource {
  readonly channel: TriggerOrigin["channel"];
  start(onTrigger: TriggerHandler, onDrop?: DropHandler): Promise<void>;
  stop(): Promise<void>;
  /** 发送一段答复;通道回执带消息 id 时返回它(供引用回复时找回线程),否则返回空。 */
  send(origin: TriggerOrigin, text: string): Promise<string | null | void>;
}

/** 多源管理:按设置启停各 channel,并作为引擎的 ReplySink。 */
export class ImManager implements ReplySink {
  private sources = new Map<string, ImSource>();
  private onTrigger: TriggerHandler | null = null;
  private onDrop: DropHandler | null = null;

  setHandler(onTrigger: TriggerHandler): void {
    this.onTrigger = onTrigger;
  }

  /** 准入丢弃的留痕回调:engine.dispatchFiltered 的入口。 */
  setDropHandler(onDrop: DropHandler): void {
    this.onDrop = onDrop;
  }

  has(channel: string): boolean {
    return this.sources.has(channel);
  }

  async register(source: ImSource): Promise<void> {
    const existing = this.sources.get(source.channel);
    if (existing) await this.stopChannel(source.channel);
    this.sources.set(source.channel, source);
    await source.start(
      (message) => this.onTrigger?.(message),
      (drop) => this.onDrop?.(drop),
    );
    console.log(`[superagent] IM source started: ${source.channel}`);
  }

  async stopChannel(channel: string): Promise<void> {
    const source = this.sources.get(channel);
    if (!source) return;
    this.sources.delete(channel);
    try {
      await source.stop();
    } catch (error) {
      console.error(`[superagent] IM source stop failed: ${source.channel}`, error);
    }
  }

  async stopAll(): Promise<void> {
    for (const channel of [...this.sources.keys()]) await this.stopChannel(channel);
  }

  async send(origin: TriggerOrigin, text: string): Promise<string | null> {
    const source = this.sources.get(origin.channel);
    if (!source) throw new Error(`IM channel ${origin.channel} is not running`);
    return (await source.send(origin, text)) ?? null;
  }
}
