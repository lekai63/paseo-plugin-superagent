/** A deadline ends the wait; callers must fence late mutations with check(). */
export class DeadlineError extends Error {}

export class Deadline {
  private canceled = false;
  private listeners = new Set<(error: Error) => void>();
  readonly expiresAt: number;

  constructor(timeoutMs: number, private readonly label: string) {
    this.expiresAt = Date.now() + timeoutMs;
  }

  cancel(): void {
    this.canceled = true;
    for (const reject of this.listeners) reject(new DeadlineError(`${this.label} timed out or was canceled`));
  }

  check(): void {
    if (this.canceled || Date.now() >= this.expiresAt) throw new DeadlineError(`${this.label} timed out or was canceled`);
  }

  async wait<T>(operation: () => Promise<T>): Promise<T> {
    this.check();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectWait: (error: Error) => void = () => {};
    try {
      const result = await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          rejectWait = reject;
          this.listeners.add(rejectWait);
          timer = setTimeout(() => {
            this.cancel();
          }, Math.max(0, this.expiresAt - Date.now()));
        }),
      ]);
      this.check();
      return result;
    } finally {
      if (timer) clearTimeout(timer);
      this.listeners.delete(rejectWait);
    }
  }
}

export const RPC_TIMEOUT_MS = 30_000;

export function bounded<T>(operation: () => Promise<T>, label: string, timeoutMs = RPC_TIMEOUT_MS): Promise<T> {
  return new Deadline(timeoutMs, label).wait(operation);
}
