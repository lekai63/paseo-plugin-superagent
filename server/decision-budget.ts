/**
 * 单轮回读预算:跨格式纠正共享,不跨评估累计。MCP 的角色工具在执行前检查。
 *
 * 超额是软限制:超出的调用被拒绝(不执行),拒绝原因要求模型立即给出裁决;
 * 只有在拒绝后仍继续调用(被拒超过 DECISION_OVERFLOW_LIMIT 次)才硬中断本轮。
 * 预算一到就中断会丢掉模型已回读的上下文,换来一次空转的「评估出错」。
 */
export const DECISION_TOOL_LIMIT = 12;
export const DECISION_REPEAT_LIMIT = 3;
/** 用尽(或重复到上限)后还能被拒绝多少次,之后硬中断本轮。 */
export const DECISION_OVERFLOW_LIMIT = 4;

export class DecisionBudget {
  private calls = 0;
  private refused = 0;
  private limit: number;
  private signatures = new Map<string, number>();
  private reject!: (error: Error) => void;
  private failure!: Promise<never>;
  error: Error | null = null;

  constructor(limit = DECISION_TOOL_LIMIT) {
    this.limit = limit;
    this.arm();
  }

  /** 硬中断时 reject;runDecision 与模型运行竞速。补救轮会换一个新的 promise。 */
  get failed(): Promise<never> {
    return this.failure;
  }

  /** 已执行的回读次数。 */
  get used(): number {
    return this.calls;
  }

  /**
   * 额度用尽、某个调用已重复到上限或已硬中断:此后失败的运行多半是预算拦截
   * (服务端硬中断或 pi 扩展中止),按预算耗尽处理而不是普通故障。
   */
  get exhausted(): boolean {
    return this.error !== null || this.calls >= this.limit
      || [...this.signatures.values()].some((repeats) => repeats >= DECISION_REPEAT_LIMIT);
  }

  /** 返回 null 放行;否则返回拒绝原因(工具层作为错误结果交给模型)。 */
  check(name: string, args: unknown): string | null {
    if (this.error) return this.error.message;
    const signature = `${name}:${JSON.stringify(args)}`;
    const repeats = (this.signatures.get(signature) ?? 0) + 1;
    if (this.calls < this.limit && repeats <= DECISION_REPEAT_LIMIT) {
      this.signatures.set(signature, repeats);
      this.calls++;
      return null;
    }
    this.refused++;
    if (this.refused > DECISION_OVERFLOW_LIMIT) {
      this.error = new Error(
        `recall budget exhausted: ${this.calls} recall calls ran and ${this.refused} more were refused; the run was stopped`,
      );
      this.reject(this.error);
      return this.error.message;
    }
    if (this.calls >= this.limit) {
      return `Recall budget exhausted (${this.calls} recall calls used in this evaluation), so this call was not run. ` +
        "Do not call any more tools: reply now with the JSON verdict, using what you already know.";
    }
    return `Refused: ${name} already ran ${DECISION_REPEAT_LIMIT} times with these exact arguments and its result will not change. ` +
      "Do not repeat it; use what you have and reply with the JSON verdict.";
  }

  /** 附在每次回读结果后的用量,让模型不必自己数(GLM 等小模型常数错)。 */
  usage(): string {
    const left = Math.max(0, this.limit - this.calls);
    return left > 0
      ? `[Recall budget: ${this.calls} of ${this.limit} calls used in this evaluation, ${left} left]`
      : `[Recall budget: all ${this.limit} calls used. No more recall in this evaluation; reply now with the JSON verdict]`;
  }

  /** 预算耗尽后的补救轮:不再放行任何回读,重新给被拒调用计数,并换一个未 reject 的 failed。 */
  closeForVerdict(): void {
    this.limit = this.calls;
    this.refused = 0;
    this.error = null;
    this.arm();
  }

  private arm(): void {
    this.failure = new Promise<never>((_resolve, reject) => { this.reject = reject; });
    // begin 与 run 之间可能收到旧调用,保证预算拒绝始终有处理者。
    void this.failure.catch(() => {});
  }
}
