import type { TriggerOrigin } from "../shared/model";
import type { ReplySink } from "./engine";

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
}

export type TriggerHandler = (message: InboundMessage) => void;
export type DropHandler = (drop: InboundDrop) => void;

export interface ImSource {
  readonly channel: TriggerOrigin["channel"];
  start(onTrigger: TriggerHandler, onDrop?: DropHandler): Promise<void>;
  stop(): Promise<void>;
  send(origin: TriggerOrigin, text: string): Promise<void>;
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

  async send(origin: TriggerOrigin, text: string): Promise<void> {
    const source = this.sources.get(origin.channel);
    if (!source) throw new Error(`IM channel ${origin.channel} is not running`);
    await source.send(origin, text);
  }
}
