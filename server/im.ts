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
}

export interface ImSource {
  readonly channel: TriggerOrigin["channel"];
  start(onTrigger: (message: InboundMessage) => void): Promise<void>;
  stop(): Promise<void>;
  send(origin: TriggerOrigin, text: string): Promise<void>;
}

/** 多源管理:按设置启停各 channel,并作为引擎的 ReplySink。 */
export class ImManager implements ReplySink {
  private sources = new Map<string, ImSource>();
  private onTrigger: ((message: InboundMessage) => void) | null = null;

  setHandler(onTrigger: (message: InboundMessage) => void): void {
    this.onTrigger = onTrigger;
  }

  has(channel: string): boolean {
    return this.sources.has(channel);
  }

  async register(source: ImSource): Promise<void> {
    const existing = this.sources.get(source.channel);
    if (existing) await this.stopChannel(source.channel);
    this.sources.set(source.channel, source);
    await source.start((message) => this.onTrigger?.(message));
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
