import type { PaseoApi } from "@getpaseo/client";
import type { PluginSettings } from "@getpaseo/plugin/server";
import type { SuperagentStore } from "./store";
import {
  newId,
  truncate,
  SUBSCRIBED_STATUSES,
  type SuperagentSnapshot,
  type SuperagentState,
  type Thread,
  type Ticket,
  type Trigger,
  type TriggerOrigin,
} from "../shared/model";
import { SETTINGS_DEFAULTS, superagentSettings, type SuperagentSettingsValues } from "../shared/settings";
import { composeEvalPrompt, ensureRouter, newDecision, parseVerdict, readLastAssistantMessage } from "./router";
import { harvestReport, launchWorker, retireWorker } from "./workers";
import { resolveProviderSelection } from "./providers";

/**
 * Superagent 引擎:整个编排层的驱动核心。
 *
 * 数据流(对齐文章的事件驱动模型):
 *   dispatch() → fast-path 截断/放行 → Thread 归属
 *     ├─ 线程有活跃订阅 Ticket → 直通 Worker(零 LLM)
 *     └─ 否则积攒 → 批窗口合并 → 串行 Router 评估 → 裁决执行
 *   Worker 完成 → 汇报抓取 → report Trigger 回流线程 → 再次 Router 评估
 *   看门狗每 15s 对账:错过完成、卡死启动、超时中断、评估重排。
 *
 * 不变量:所有状态先落盘再执行副作用;崩溃后 watchdog/prime 恢复。
 */

const WATCHDOG_INTERVAL_MS = 15_000;
const LAUNCH_STUCK_MS = 5 * 60_000;
const ROUTER_EVAL_TIMEOUT_MS = 10 * 60_000;
const PREFERRED_PROVIDERS = ["claude", "codex", "opencode"];

export interface DispatchInput {
  title?: string;
  task: string;
  threadId?: string;
  sender?: string;
  context?: boolean;
  replyToAgentId?: string;
  /** 触发来源:手动界面/斜杠命令为 manual,agent 委派工具为 agent。 */
  kind?: "manual" | "agent";
  /** IM 触发:来源聊天信息与稳定线程键(feishu:chat:<id> / qq:group:<id> 等)。 */
  origin?: TriggerOrigin;
  /** IM 触发的线程关联键:同键消息归属同一 Thread,跨消息延续订阅与记忆。 */
  threadKey?: string;
}

/** 答复外发通道:由 index.server 注入(engine 不直接依赖具体 IM 实现)。 */
export interface ReplySink {
  send(origin: TriggerOrigin, text: string): Promise<void>;
}

export class SuperagentEngine {
  private paseo: PaseoApi | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private primed = false;
  private evalInFlight = false;
  private currentEvalThread: string | null = null;
  private evalQueued = new Set<string>();
  private batchTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private watchedTickets = new Set<string>();
  /** 线程评估连续失败计数(unparsed/异常),≥3 次后看门狗不再自动重排,防失控循环。 */
  private evalFailures = new Map<string, number>();
  /** 已提示过的 provider 设置纠正(每个设置值只告警一次)。 */
  private providerNotes = new Set<string>();
  private lastWatchdogAt: string | null = null;
  private lastWatchdogNote: string | null = null;
  private replySink: ReplySink | null = null;
  private settingsValues: SuperagentSettingsValues = SETTINGS_DEFAULTS;

  /** IM 触发源的答复外发通道,由 index.server 在启动 source 时注入。 */
  setReplySink(sink: ReplySink | null): void {
    this.replySink = sink;
  }

  /** 首次 prime 后回调一次(用于启动 IM source 等外部依赖)。 */
  onFirstPrime: (() => void) | null = null;

  get isPrimed(): boolean {
    return this.primed;
  }

  constructor(
    private readonly store: SuperagentStore,
    settings: PluginSettings<typeof superagentSettings.schema>,
  ) {
    settings.subscribe((state) => {
      if (state.status === "ready") this.settingsValues = state.values;
    });
    void settings.read().then((state) => {
      if (state.status === "ready") this.settingsValues = state.values;
    });
  }

  /** SDK 只把 paseo 交给 handler/hook;每个入口都会调 prime,首次调用启动引擎。 */
  prime(paseo: PaseoApi): void {
    this.paseo = paseo;
    if (this.primed) return;
    this.primed = true;
    console.log("[superagent] engine primed, starting watchdog");
    void this.recover();
    this.watchdogTimer = setInterval(() => {
      void this.watchdogTick().catch((error) => {
        console.error("[superagent] watchdog tick failed", error);
      });
    }, WATCHDOG_INTERVAL_MS);
    try {
      this.onFirstPrime?.();
    } catch (error) {
      console.error("[superagent] onFirstPrime callback failed", error);
    }
  }

  async stop(): Promise<void> {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = null;
    for (const timer of this.batchTimers.values()) clearTimeout(timer);
    this.batchTimers.clear();
    this.primed = false;
    await this.store.flush();
  }

  // ---------------------------------------------------------------- intake

  /** 事件入口:fast-path → Thread 归属 → 订阅直通 | 排队评估。 */
  async dispatch(input: DispatchInput): Promise<{ threadId: string; triggerId: string; directDelivered: boolean; note: string | null }> {
    await this.store.ready;
    const settings = this.settingsValues;
    const text = input.task.trim().slice(0, settings.triggerMaxChars);
    if (!text) throw new Error("empty task");

    const state = this.store.get();
    let thread: Thread | undefined;
    if (input.threadId) {
      thread = state.threads.find((t) => t.id === input.threadId);
      if (!thread) throw new Error(`thread ${input.threadId} not found`);
    } else if (input.threadKey) {
      // IM 触发:同一聊天固定 Thread,订阅直通与 Router 记忆跨消息延续。
      thread = state.threads.find((t) => t.key === input.threadKey);
    }
    if (thread && thread.state === "closed") {
      // 关闭线程上的新事件重新激活线程。
      await this.store.update((next) => {
        const target = next.threads.find((t) => t.id === thread!.id);
        if (target) {
          target.state = "active";
          target.updatedAt = new Date().toISOString();
        }
      });
    }

    const triggerId = newId("trg");
    const now = new Date().toISOString();
    const sender = input.sender?.trim() || "user";
    const title = (input.title?.trim() || text.split("\n")[0] || "task").slice(0, 120);

    if (!thread) {
      thread = {
        id: newId("thr"),
        key: input.threadKey ?? `manual:${newId("k")}`,
        title,
        state: "active",
        summary: null,
        createdAt: now,
        updatedAt: now,
      };
    }
    const threadKey = thread.key;
    const threadId = thread.id;

    // 订阅直通:活跃订阅 Ticket 存在时,后续事件不过 Router(Worker 汇报除外)。
    const subscribed = this.subscribedTickets(this.store.get(), threadId);
    const direct = subscribed.length > 0;

    const trigger: Trigger = {
      id: triggerId,
      kind: input.origin ? input.origin.channel : input.kind === "agent" ? "agent" : "manual",
      sender,
      threadKey,
      text,
      context: input.context ?? false,
      replyToAgentId: input.replyToAgentId ?? null,
      origin: input.origin ?? null,
      receivedAt: now,
      status: "pending",
      note: null,
      threadId,
    };

    await this.store.update((next) => {
      if (!next.threads.some((t) => t.id === threadId)) {
        next.threads.push(thread!);
      }
      next.triggers.push(trigger);
      const target = next.threads.find((t) => t.id === threadId);
      if (target) target.updatedAt = now;
    });

    if (direct) {
      const directDelivered = await this.deliverDirect(trigger, subscribed);
      if (directDelivered) return { threadId, triggerId, directDelivered, note: null };
    }

    this.scheduleEval(threadId);
    return { threadId, triggerId, directDelivered: false, note: null };
  }

  /** Worker 汇报回流:同线程触发 Router 评估(与普通触发同一队列)。 */
  private async enqueueReport(threadId: string, ticket: Ticket, report: string): Promise<void> {
    const now = new Date().toISOString();
    const state = this.store.get();
    const thread = state.threads.find((t) => t.id === threadId);
    if (!thread) return;
    const originTrigger = state.triggers
      .filter((t) => t.threadId === threadId && ["evaluated", "delivered"].includes(t.status))
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
      .find((t) => t.replyToAgentId || t.origin);
    const replyTo = originTrigger?.replyToAgentId ?? null;
    const origin = originTrigger?.origin ?? null;
    await this.store.update((next) => {
      next.triggers.push({
        id: newId("trg"),
        kind: "report",
        sender: `worker:${ticket.id}`,
        threadKey: thread.key,
        text: `Worker report for "${ticket.title}":\n${truncate(report, 2000)}`,
        context: false,
        replyToAgentId: replyTo,
        origin,
        receivedAt: now,
        status: "pending",
        note: null,
        threadId,
      });
    });
    this.scheduleEval(threadId);
  }

  private subscribedTickets(state: SuperagentState, threadId: string): Ticket[] {
    return state.tickets.filter(
      (t) => t.threadId === threadId && t.subscribed && SUBSCRIBED_STATUSES.includes(t.status),
    );
  }

  private activeTickets(state: SuperagentState, threadId: string): Ticket[] {
    return state.tickets.filter(
      (t) => t.threadId === threadId && !["completed", "failed", "canceled"].includes(t.status),
    );
  }

  /** 订阅直通投递:直接发进 Worker 会话(运行中则 steer),零 LLM。 */
  private async deliverDirect(trigger: Trigger, tickets: Ticket[]): Promise<boolean> {
    const paseo = this.requirePaseo();
    const ticket = tickets[0];
    if (!ticket.workerAgentId) return false;
    const prefix = trigger.context ? "[context] " : "";
    try {
      await paseo.agents
        .ref(ticket.workerAgentId)
        .send(`${prefix}${trigger.text}`, { activeTurnBehavior: "steer" });
      await this.store.update((next) => {
        const target = next.triggers.find((t) => t.id === trigger.id);
        if (target) {
          target.status = "delivered";
          target.note = `direct → worker of ${ticket.id}`;
        }
        const worker = next.tickets.find((t) => t.id === ticket.id);
        if (worker?.status === "waiting") {
          worker.status = "running";
          worker.startedAt = new Date().toISOString();
          worker.updatedAt = worker.startedAt;
          worker.lastError = null;
        }
      });
      const current = this.store.get().tickets.find((t) => t.id === ticket.id);
      if (current?.status === "running") this.watchTicket(ticket.id);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.store.update((next) => {
        const target = next.triggers.find((t) => t.id === trigger.id);
        if (target) {
          target.status = "pending";
          target.note = `direct delivery failed: ${truncate(message, 200)}`;
        }
      });
      // 直通失败退回评估路径。
      return false;
    }
  }

  // ------------------------------------------------------------ eval loop

  /** 批窗口:窗口内同线程触发合并进一次评估(文章的批处理设计)。 */
  private scheduleEval(threadId: string, delayMs?: number): void {
    const delay = delayMs ?? this.settingsValues.evalBatchMs;
    const existing = this.batchTimers.get(threadId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.batchTimers.delete(threadId);
      this.evalQueued.add(threadId);
      void this.drainEvalQueue();
    }, delay);
    this.batchTimers.set(threadId, timer);
  }

  private async drainEvalQueue(): Promise<void> {
    if (this.evalInFlight) return;
    const next = [...this.evalQueued][0];
    if (!next) return;
    this.evalInFlight = true;
    this.currentEvalThread = next;
    this.evalQueued.delete(next);
    try {
      await this.runEval(next);
    } catch (error) {
      console.error("[superagent] eval failed", error);
      this.evalFailures.set(next, (this.evalFailures.get(next) ?? 0) + 1);
      const message = error instanceof Error ? error.message : String(error);
      await this.store.update((state) => {
        const thread = state.threads.find((t) => t.id === next);
        if (thread) {
          state.decisions.push(
            newDecision(next, [], "error", { rationale: truncate(message, 400) }),
          );
        }
      });
    } finally {
      this.evalInFlight = false;
      this.currentEvalThread = null;
      if (this.evalQueued.size > 0) void this.drainEvalQueue();
    }
  }

  private async runEval(threadId: string): Promise<void> {
    await this.store.ready;
    const paseo = this.requirePaseo();
    let state = this.store.get();
    const thread = state.threads.find((t) => t.id === threadId);
    if (!thread || thread.state === "closed") return;
    const batch = state.triggers.filter((t) => t.threadId === threadId && t.status === "pending");
    if (batch.length === 0) return;

    // 1. Router 就绪(provider/目录未配置时给出可读错误)。
    const routerProvider = await this.resolveProvider("router", state.kv.routerProvider);
    if (!this.settingsValues.workingDir) {
      throw new Error("working directory is not configured — set it in the Superagent screen");
    }
    if (!routerProvider) throw new Error("no available provider for the router");
    const router = await ensureRouter(paseo, state, routerProvider, this.settingsValues.workingDir);
    if ("error" in router) throw new Error(router.error);
    const routerAgentId = router.agentId;
    if (state.kv.routerAgentId !== routerAgentId || state.kv.routerProvider !== routerProvider) {
      await this.store.update((next) => {
        next.kv.routerAgentId = routerAgentId;
        next.kv.routerProvider = routerProvider;
      });
    }

    // 2. 一次 LLM 调用评估整批(Inline & Spill 组装的提示词)。
    const prompt = composeEvalPrompt({ thread, batch, state });
    const result = await router.handle.run(prompt, { timeoutMs: ROUTER_EVAL_TIMEOUT_MS });
    const replyText =
      result.lastMessage?.trim() || (await readLastAssistantMessage(paseo, routerAgentId)) || "";

    // 3. 解析裁决;失败即记录 unparsed(触发保留 pending 供重试),连续失败计数防失控循环。
    const parsed = parseVerdict(replyText);
    state = this.store.get();
    // 评估期间线程可能被关闭;丢弃迟到裁决,不能重新派发已取消的工作。
    if (
      state.threads.find((t) => t.id === threadId)?.state !== "active" ||
      batch.some((trigger) => state.triggers.find((t) => t.id === trigger.id)?.status !== "pending")
    ) return;
    if ("error" in parsed) {
      this.evalFailures.set(threadId, (this.evalFailures.get(threadId) ?? 0) + 1);
      await this.store.update((next) => {
        next.decisions.push(
          newDecision(threadId, batch.map((t) => t.id), "unparsed", {
            rationale: parsed.error,
            raw: truncate(replyText, 1200),
          }),
        );
      });
      return;
    }
    this.evalFailures.delete(threadId);
    const verdict = parsed.verdict;

    // 4. 执行裁决(先落盘后副作用)。
    const triggerIds = batch.map((t) => t.id);
    const decision = newDecision(threadId, triggerIds, verdict.decision);
    let createdTicket: Ticket | null = null;

    if (verdict.decision === "dispatch") {
      createdTicket = {
        id: newId("tkt"),
        threadId,
        title: verdict.title,
        mandate: verdict.mandate,
        status: "pending",
        workerAgentId: null,
        workspaceId: null,
        startedAt: null,
        attempts: 0,
        subscribed: !verdict.unsubscribe,
        report: null,
        lastError: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      decision.ticketId = createdTicket.id;
      if (verdict.reply) decision.reply = truncate(verdict.reply, 2000);
      await this.store.update((next) => {
        next.decisions.push(decision);
        next.tickets.push(createdTicket!);
        for (const trigger of next.triggers) {
          if (triggerIds.includes(trigger.id)) trigger.status = "evaluated";
        }
        const target = next.threads.find((t) => t.id === threadId);
        if (target) {
          target.updatedAt = decision.createdAt;
          target.summary = truncate(verdict.title, 200);
        }
      });
      void this.startTicket(createdTicket.id).catch((error) => {
        console.error("[superagent] ticket launch failed", error);
      });
    } else if (verdict.decision === "reply") {
      decision.reply = truncate(verdict.reply, 2000);
      await this.store.update((next) => {
        next.decisions.push(decision);
        for (const trigger of next.triggers) {
          if (triggerIds.includes(trigger.id)) trigger.status = "evaluated";
        }
        const target = next.threads.find((t) => t.id === threadId);
        if (target) {
          target.updatedAt = decision.createdAt;
          target.summary = truncate(verdict.reply, 200);
        }
      });
    } else if (verdict.decision === "ignore") {
      decision.rationale = verdict.rationale ?? null;
      await this.store.update((next) => {
        next.decisions.push(decision);
        for (const trigger of next.triggers) {
          if (triggerIds.includes(trigger.id)) trigger.status = "evaluated";
        }
        const target = next.threads.find((t) => t.id === threadId);
        if (target) target.updatedAt = decision.createdAt;
      });
    } else if (verdict.decision === "stop") {
      decision.rationale = verdict.rationale ?? null;
      const active = this.activeTickets(state, threadId);
      await this.store.update((next) => {
        next.decisions.push(decision);
        for (const trigger of next.triggers) {
          if (triggerIds.includes(trigger.id)) trigger.status = "evaluated";
        }
        for (const ticket of next.tickets) {
          if (ticket.threadId === threadId && !["completed", "failed", "canceled"].includes(ticket.status)) {
            ticket.status = "canceled";
            ticket.subscribed = false;
            ticket.updatedAt = decision.createdAt;
          }
        }
        const target = next.threads.find((t) => t.id === threadId);
        if (target) {
          target.state = "closed";
          target.updatedAt = decision.createdAt;
        }
      });
      for (const ticket of active) {
        await retireWorker(paseo, ticket, true);
      }
    }

    // 5. 答复回投:IM 触发回原聊天;agent 委派回原会话。
    const reply = decision.reply;
    if (reply) {
      const origin = batch.find((t) => t.origin)?.origin ?? null;
      if (origin) {
        const text = truncate(reply, this.settingsValues.imReplyMaxChars);
        try {
          await this.replySink?.send(origin, text);
        } catch (error) {
          console.error("[superagent] reply delivery to channel failed", error);
        }
      } else {
        const replyTarget = batch.find((t) => t.replyToAgentId)?.replyToAgentId ?? null;
        if (replyTarget) {
          try {
            await paseo.agents.ref(replyTarget).send(reply, {
              sourceAgentId: routerAgentId,
              activeTurnBehavior: "steer",
            });
          } catch (error) {
            console.error("[superagent] reply relay to agent failed", error);
          }
        }
      }
    }
  }

  // -------------------------------------------------------------- workers

  private async startTicket(ticketId: string): Promise<void> {
    await this.store.ready;
    const paseo = this.requirePaseo();
    let state = this.store.get();
    const ticket = state.tickets.find((t) => t.id === ticketId);
    if (!ticket || ticket.status !== "pending") return;

    let workerProvider: string;
    try {
      workerProvider = await this.resolveProvider("worker", state.kv.workerProvider);
      if (!workerProvider) throw new Error("no available provider for workers");
    } catch (error) {
      // 设置错误时 Ticket 保持 pending(看门狗会重试),但把原因写进 lastError 供 UI 展示。
      const message = truncate(error instanceof Error ? error.message : String(error), 500);
      await this.store.update((next) => {
        const target = next.tickets.find((t) => t.id === ticketId);
        if (!target || target.status !== "pending" || target.lastError === message) return;
        target.lastError = message;
        target.updatedAt = new Date().toISOString();
      });
      throw error;
    }
    if (state.kv.workerProvider !== workerProvider) {
      await this.store.update((next) => {
        next.kv.workerProvider = workerProvider;
      });
    }

    const now = new Date().toISOString();
    let attempt = 0;
    await this.store.update((next) => {
      const target = next.tickets.find((t) => t.id === ticketId);
      if (
        !target || target.status !== "pending" ||
        next.threads.find((t) => t.id === target.threadId)?.state !== "active"
      ) return;
      target.status = "launching";
      target.attempts += 1;
      attempt = target.attempts;
      target.startedAt = now;
      target.lastError = null;
      target.updatedAt = now;
    });
    if (!attempt) return;

    state = this.store.get();
    const current = state.tickets.find((t) => t.id === ticketId);
    if (!current || current.status !== "launching" || current.attempts !== attempt || current.startedAt !== now) return;
    try {
      const launch = await launchWorker(
        paseo,
        this.settingsValues,
        state,
        current,
        state.kv.routerAgentId ?? null,
      );
      let accepted = false;
      await this.store.update((next) => {
        const target = next.tickets.find((t) => t.id === ticketId);
        if (
          !target || target.status !== "launching" || target.attempts !== attempt || target.startedAt !== now ||
          next.threads.find((t) => t.id === target.threadId)?.state !== "active"
        ) return;
        target.workerAgentId = launch.agentId;
        target.workspaceId = launch.workspaceId;
        target.status = "running";
        target.updatedAt = new Date().toISOString();
        accepted = true;
      });
      if (accepted) {
        this.watchTicket(ticketId);
      } else {
        await retireWorker(paseo, { ...current, workerAgentId: launch.agentId, workspaceId: launch.workspaceId }, true);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.settleLaunchFailure(ticketId, message, { attempt, startedAt: now });
    }
  }

  private async settleLaunchFailure(
    ticketId: string,
    message: string,
    launch?: { attempt: number; startedAt: string },
  ): Promise<void> {
    const settings = this.settingsValues;
    let settled = false;
    await this.store.update((next) => {
      const target = next.tickets.find((t) => t.id === ticketId);
      if (
        !target || target.status !== "launching" ||
        (launch && (target.attempts !== launch.attempt || target.startedAt !== launch.startedAt))
      ) return;
      settled = true;
      target.lastError = truncate(message, 500);
      target.updatedAt = new Date().toISOString();
      if (target.attempts > settings.maxTicketAttempts) {
        target.status = "failed";
      } else {
        target.status = "pending";
      }
    });
    if (!settled) return;
    const state = this.store.get();
    const target = state.tickets.find((t) => t.id === ticketId);
    if (target?.status === "pending") {
      await this.startTicket(ticketId).catch((error) => {
        console.error("[superagent] ticket retry launch failed", error);
      });
    } else if (target?.status === "failed") {
      await this.enqueueReport(target.threadId, target, `Launch failed: ${truncate(message, 500)}`);
    }
  }

  /** 挂起等待 Worker 本轮结束;浮错由看门狗兜底。 */
  private watchTicket(ticketId: string): void {
    if (this.watchedTickets.has(ticketId)) return;
    const state = this.store.get();
    const ticket = state.tickets.find((t) => t.id === ticketId);
    if (!ticket?.workerAgentId) return;
    this.watchedTickets.add(ticketId);
    const agentId = ticket.workerAgentId;
    void (async () => {
      try {
        const result = await this.requirePaseo().agents.ref(agentId).waitForFinish(
          this.settingsValues.workerTimeoutMin * 60_000,
        );
        // idle = 本轮正常结束;error = 失败。
        // timeout 交给看门狗按运行上限处置;permission 是在等人批权限,轮次未完。
        if (result.status === "idle") {
          await this.settleTicketRun(ticketId, null);
        } else if (result.status === "error") {
          await this.settleTicketRun(ticketId, result.error ?? "turn failed");
        }
      } catch (error) {
        console.error("[superagent] worker watch failed", error);
        this.watchedTickets.delete(ticketId);
      }
    })();
  }

  /** Worker 本轮落定:抓汇报、更新 Ticket、把汇报回流成触发。 */
  private async settleTicketRun(ticketId: string, failure: string | null): Promise<void> {
    this.watchedTickets.delete(ticketId);
    const paseo = this.requirePaseo();
    const state = this.store.get();
    const ticket = state.tickets.find((t) => t.id === ticketId);
    if (!ticket || !["running", "launching"].includes(ticket.status)) return;
    const attempt = ticket.attempts;
    const startedAt = ticket.startedAt;
    const workerAgentId = ticket.workerAgentId;
    const report = ticket.workerAgentId ? await harvestReport(paseo, ticket.workerAgentId) : null;
    const now = new Date().toISOString();
    const done = failure === null;
    let settled = false;
    await this.store.update((next) => {
      const target = next.tickets.find((t) => t.id === ticketId);
      if (
        !target || !["running", "launching"].includes(target.status) || target.attempts !== attempt ||
        target.startedAt !== startedAt || target.workerAgentId !== workerAgentId
      ) return;
      settled = true;
      target.updatedAt = now;
      if (done) {
        target.status = target.subscribed ? "waiting" : "completed";
        target.report = report;
      } else {
        const retryable = target.attempts <= this.settingsValues.maxTicketAttempts;
        target.lastError = truncate(failure, 500);
        if (retryable && target.workerAgentId) {
          // 同一 Worker 会话续跑(保留上下文),计入新一次尝试。
          target.status = "running";
          target.startedAt = now;
          target.attempts += 1;
        } else {
          target.status = "failed";
        }
      }
    });
    if (!settled) return;
    const after = this.store.get();
    const target = after.tickets.find((t) => t.id === ticketId);
    if (!target) return;
    if (target.status === "running" && target.workerAgentId) {
      // 续跑:推一条继续指令并重新挂watch。
      try {
        await paseo.agents.ref(target.workerAgentId).send(
          `Your previous run failed (${truncate(failure ?? "", 200)}). Continue the task from where it stopped.`,
        );
      } catch (error) {
        console.error("[superagent] worker continue prompt failed", error);
      }
      this.watchTicket(ticketId);
      return;
    }
    if (target.status === "waiting" || target.status === "completed" || target.status === "failed") {
      const text = done
        ? report ?? "(no report text)"
        : `Worker failed: ${truncate(failure ?? "", 500)}`;
      await this.enqueueReport(target.threadId, target, text);
    }
  }

  // ------------------------------------------------------------ watchdog

  private async recover(): Promise<void> {
    await this.store.ready;
    const state = this.store.get();
    for (const thread of state.threads) {
      const pending = state.triggers.some((t) => t.threadId === thread.id && t.status === "pending");
      if (pending && thread.state === "active") this.scheduleEval(thread.id, 0);
    }
    for (const ticket of state.tickets) {
      if (["running", "launching"].includes(ticket.status) && ticket.workerAgentId) {
        this.watchTicket(ticket.id);
      }
    }
    await this.watchdogTick();
  }

  private async watchdogTick(): Promise<void> {
    if (!this.primed || !this.paseo) return;
    const note = await this.reconcile();
    this.lastWatchdogAt = new Date().toISOString();
    this.lastWatchdogNote = note;
  }

  /** 对账:错过完成 / 卡死启动 / 超时中断 / 评估重排(连续失败 ≥3 次的线程不再自动重排)。 */
  private async reconcile(): Promise<string | null> {
    await this.store.ready;
    const paseo = this.paseo;
    if (!paseo) return null;
    const state = this.store.get();
    let acted = 0;

    for (const ticket of state.tickets) {
      if (ticket.status === "pending" && state.threads.find((t) => t.id === ticket.threadId)?.state === "active") {
        acted += 1;
        void this.startTicket(ticket.id).catch((error) => {
          console.error("[superagent] pending ticket recovery failed", error);
        });
      } else if (ticket.status === "launching") {
        const startedAt = ticket.startedAt ? Date.parse(ticket.startedAt) : 0;
        if (Date.now() - startedAt > LAUNCH_STUCK_MS) {
          acted += 1;
          await this.settleLaunchFailure(ticket.id, "launch stuck (watchdog)");
        }
      } else if (ticket.status === "running" && ticket.workerAgentId) {
        try {
          const handle = paseo.agents.ref(ticket.workerAgentId);
          const refetched = await handle.refresh();
          const status = refetched?.agent.status;
          const archived = Boolean(refetched?.agent.archivedAt);
          const startedAt = ticket.startedAt ? Date.parse(ticket.startedAt) : Date.now();
          const timedOut = Date.now() - startedAt > this.settingsValues.workerTimeoutMin * 60_000;
          if (archived) {
            acted += 1;
            await this.settleTicketRun(ticket.id, "worker agent was archived");
          } else if (status === "idle") {
            // 引擎错过完成(进程重启 / watcher 丢失):收割汇报。
            acted += 1;
            await this.settleTicketRun(ticket.id, null);
          } else if (status === "error") {
            acted += 1;
            await this.settleTicketRun(
              ticket.id,
              refetched?.agent.lastError ?? "worker reported error",
            );
          } else if (status === "running" && timedOut) {
            acted += 1;
            try {
              await handle.reload();
            } catch (error) {
              console.error("[superagent] worker timeout reload failed", error);
            }
            await this.settleTicketRun(ticket.id, `exceeded ${this.settingsValues.workerTimeoutMin}min runtime`);
          }
        } catch (error) {
          console.error("[superagent] watchdog refresh failed", ticket.workerAgentId, error);
        }
      }
    }

    // 评估队列保险:pending 触发但既无批窗口定时器、不在队列、也不在当前评估中的线程,重排。
    const pendingByThread = new Set<string>();
    for (const trigger of state.triggers) {
      if (trigger.status === "pending" && trigger.threadId) pendingByThread.add(trigger.threadId);
    }
    for (const threadId of pendingByThread) {
      const thread = state.threads.find((t) => t.id === threadId);
      if (!thread || thread.state === "closed") continue;
      if ((this.evalFailures.get(threadId) ?? 0) >= 3) continue;
      const active =
        this.batchTimers.has(threadId) ||
        this.evalQueued.has(threadId) ||
        (this.evalInFlight && this.currentEvalThread === threadId);
      if (!active) {
        acted += 1;
        this.scheduleEval(threadId, 0);
      }
    }

    // Router 丢失检测:清掉失效 id,下次评估自动重建。
    const routerId = state.kv.routerAgentId;
    if (routerId) {
      try {
        const refetched = await paseo.agents.ref(routerId).refresh();
        if (!refetched || refetched.agent.archivedAt) {
          await this.store.update((next) => {
            next.kv.routerAgentId = null;
          });
        }
      } catch {
        await this.store.update((next) => {
          next.kv.routerAgentId = null;
        });
      }
    }

    return acted > 0 ? `reconciled ${acted} item(s)` : null;
  }

  // -------------------------------------------------------------- actions

  async forceEval(threadId: string): Promise<void> {
    const state = this.store.get();
    if (!state.threads.some((t) => t.id === threadId)) throw new Error("thread not found");
    this.evalFailures.delete(threadId);
    this.scheduleEval(threadId, 0);
  }

  async cancelTicket(ticketId: string): Promise<void> {
    const paseo = this.requirePaseo();
    const state = this.store.get();
    const ticket = state.tickets.find((t) => t.id === ticketId);
    if (!ticket) throw new Error("ticket not found");
    const active = !["completed", "failed", "canceled"].includes(ticket.status);
    await this.store.update((next) => {
      const target = next.tickets.find((t) => t.id === ticketId);
      if (!target) return;
      target.status = "canceled";
      target.subscribed = false;
      target.updatedAt = new Date().toISOString();
    });
    if (active) await retireWorker(paseo, ticket, true);
  }

  async retryTicket(ticketId: string): Promise<void> {
    const state = this.store.get();
    const ticket = state.tickets.find((t) => t.id === ticketId);
    if (!ticket) throw new Error("ticket not found");
    if (!["failed", "canceled", "completed"].includes(ticket.status)) {
      throw new Error(`ticket is ${ticket.status}; only failed/canceled/completed tickets retry`);
    }
    await this.store.update((next) => {
      const target = next.tickets.find((t) => t.id === ticketId);
      if (!target) return;
      target.status = "pending";
      target.attempts = 0;
      target.report = null;
      target.lastError = null;
      target.subscribed = true;
      target.updatedAt = new Date().toISOString();
    });
    await this.startTicket(ticketId);
  }

  async closeThread(threadId: string): Promise<void> {
    const paseo = this.requirePaseo();
    const state = this.store.get();
    const active = this.activeTickets(state, threadId);
    await this.store.update((next) => {
      const thread = next.threads.find((t) => t.id === threadId);
      if (!thread) return;
      thread.state = "closed";
      thread.updatedAt = new Date().toISOString();
      for (const ticket of next.tickets) {
        if (ticket.threadId === threadId && !["completed", "failed", "canceled"].includes(ticket.status)) {
          ticket.status = "canceled";
          ticket.subscribed = false;
          ticket.updatedAt = thread.updatedAt;
        }
      }
      for (const trigger of next.triggers) {
        if (trigger.threadId === threadId && trigger.status === "pending") {
          trigger.status = "evaluated";
          trigger.note = "thread closed";
        }
      }
    });
    for (const ticket of active) await retireWorker(paseo, ticket, true);
  }

  async unsubscribe(threadId: string, ticketId: string): Promise<void> {
    await this.store.update((next) => {
      const ticket = next.tickets.find((t) => t.id === ticketId);
      if (!ticket || ticket.threadId !== threadId) return;
      ticket.subscribed = false;
      ticket.updatedAt = new Date().toISOString();
      if (ticket.status === "waiting") ticket.status = "completed";
    });
  }

  // ------------------------------------------------------------- snapshot

  snapshot(): SuperagentSnapshot {
    const state = this.store.get();
    const settings = this.settingsValues;
    const threads = state.threads
      .filter((t) => t.state === "active" || state.tickets.some((k) => k.threadId === t.id && k.status === "running"))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((thread) => {
        const tickets = state.tickets.filter((t) => t.threadId === thread.id);
        const ticketCounts: Record<string, number> = {};
        for (const ticket of tickets) {
          ticketCounts[ticket.status] = (ticketCounts[ticket.status] ?? 0) + 1;
        }
        return {
          ...thread,
          pendingTriggers: state.triggers.filter(
            (t) => t.threadId === thread.id && t.status === "pending",
          ).length,
          ticketCounts,
        };
      });
    return {
      configured: Boolean(settings.workingDir),
      workingDir: settings.workingDir,
      routerAgentId: state.kv.routerAgentId ?? null,
      routerProvider: state.kv.routerProvider || settings.routerProvider || null,
      workerProvider: state.kv.workerProvider || settings.workerProvider || null,
      threads,
      tickets: state.tickets
        .filter((t) => threads.some((th) => th.id === t.threadId))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      triggers: state.triggers
        .filter((t) => threads.some((th) => th.id === t.threadId))
        .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
        .slice(0, 120),
      decisions: state.decisions
        .filter((d) => threads.some((th) => th.id === d.threadId))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 120),
      engine: {
        running: this.primed,
        primed: this.primed,
        lastWatchdogAt: this.lastWatchdogAt,
        lastWatchdogNote: this.lastWatchdogNote,
        evalInFlight: this.evalInFlight,
      },
    };
  }

  // ------------------------------------------------------------- helpers

  private requirePaseo(): PaseoApi {
    if (!this.paseo) throw new Error("engine not primed yet");
    return this.paseo;
  }

  /**
   * provider 解析:设置显式指定优先;否则从 daemon provider 快照挑一个稳定默认
   * (claude → codex → opencode → 任意 ready),并记入 kv 保证跨重启一致。
   */
  private async resolveProvider(
    role: "router" | "worker",
    remembered: string | null | undefined,
  ): Promise<string> {
    const configured = role === "router" ? this.settingsValues.routerProvider : this.settingsValues.workerProvider;
    if (configured.trim()) return this.validateConfiguredProvider(role, configured.trim());
    if (remembered) return remembered;
    const paseo = this.requirePaseo();
    try {
      await paseo.providers.waitForReady({ timeoutMs: 20_000 }).catch(() => undefined);
      const snapshot = await paseo.providers.snapshot();
      const ready = snapshot.entries.filter((entry) => entry.enabled !== false && entry.status === "ready");
      const pick =
        ready.find((entry) => PREFERRED_PROVIDERS.includes(entry.provider)) ?? ready[0];
      if (!pick) return "";
      const model = pick.models?.find((m) => m.isDefault) ?? pick.models?.[0];
      return model ? `${pick.provider}/${model.id}` : pick.provider;
    } catch (error) {
      console.error("[superagent] provider discovery failed", error);
      return "";
    }
  }

  /**
   * 显式设置的 provider/model 先对照 provider 快照校验,避免把错误 model 交给 provider
   * 后只拿到一句 "Internal error";过度转义的反斜杠自动纠正。快照不可用时原样放行。
   */
  private async validateConfiguredProvider(role: "router" | "worker", configured: string): Promise<string> {
    const paseo = this.requirePaseo();
    let entries;
    try {
      await paseo.providers.waitForReady({ timeoutMs: 20_000 }).catch(() => undefined);
      entries = (await paseo.providers.snapshot()).entries;
    } catch (error) {
      console.error("[superagent] provider snapshot unavailable; using configured provider as-is", error);
      return configured;
    }
    const result = resolveProviderSelection(configured, entries);
    if ("error" in result) {
      throw new Error(`${role} provider setting "${configured}" is invalid: ${result.error}`);
    }
    if (result.note && !this.providerNotes.has(`${role}:${configured}`)) {
      this.providerNotes.add(`${role}:${configured}`);
      console.warn(`[superagent] ${role} provider: ${result.note}`);
    }
    return result.selection;
  }
}
