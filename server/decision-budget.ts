/** 单轮预算跨格式纠正共享,不跨评估累计。MCP 的角色工具在执行前检查。 */
export const DECISION_TOOL_LIMIT = 12;
export const DECISION_REPEAT_LIMIT = 3;

export class DecisionBudget {
  private calls = 0;
  private signatures = new Map<string, number>();
  private reject!: (error: Error) => void;
  error: Error | null = null;
  readonly failed = new Promise<never>((_resolve, reject) => { this.reject = reject; });

  constructor() {
    // begin 与 run 之间可能收到旧调用,保证预算拒绝始终有处理者。
    void this.failed.catch(() => {});
  }

  check(name: string, args: unknown): string | null {
    if (this.error) return this.error.message;
    const signature = `${name}:${JSON.stringify(args)}`;
    const repeats = (this.signatures.get(signature) ?? 0) + 1;
    this.signatures.set(signature, repeats);
    this.calls++;
    if (this.calls > DECISION_TOOL_LIMIT || repeats > DECISION_REPEAT_LIMIT) {
      this.error = new Error(`decision tool budget exceeded: ${this.calls} calls, ${repeats} repeats of ${name}; return a verdict instead of polling`);
      this.reject(this.error);
      return this.error.message;
    }
    return null;
  }
}
