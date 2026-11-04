import type { PaseoApi } from "@getpaseo/client";
import { createHash } from "node:crypto";
import type { PluginSettings } from "@getpaseo/plugin/server";
import type { SuperagentStore } from "./store";
import { directTicket } from "../shared/execution";
import { recentResults, threadResult } from "../shared/results";
import { defaultChatTabs, pruneChatTabs, type ChatTabs } from "../shared/chat-tabs";
import {
  newId,
  truncate,
  SUBSCRIBED_STATUSES,
  type Decision,
  type PendingAction,
  type RouterAction,
  type SuperagentSnapshot,
  type SuperagentState,
  type Thread,
  type Ticket,
  type Trigger,
  type TriggerOrigin,
} from "../shared/model";
import {
  DEFAULT_WORKER_PROFILE,
  SETTINGS_DEFAULTS,
  superagentSettings,
  type SuperagentSettingsValues,
} from "../shared/settings";
import {
  composeEvalPrompt,
  composeRouterInstructions,
  ensureRouter,
  newDecision,
  parseVerdict,
  readLastAssistantMessage,
  routerCompactionSeq,
  routerSessionId,
  routerUsesSystemPrompt,
  type RouterWorkerEnvironment,
} from "./router";
import { harvestReport, launchWorker, retireWorker } from "./workers";
import { matchWorkerProfile, resolveProviderSelection } from "./providers";
import { findInstructionFiles, inspectWorkingDir, nodeWorkingDirProbe, type WorkingDirProbe } from "./workdir";
import { splitImReply } from "./im-replies";

/**
 * Superagent 引擎:整个编排层的驱动核心。
 *
 * 数据流(对齐文章的事件驱动模型):
 *   dispatch() → fast-path 截断/放行 → Thread 归属
 *     ├─ 线程恰有一个活跃订阅 Ticket → 直通其 Worker(零 LLM);多个订阅交 Router 选择
 *     └─ 否则积攒 → 批窗口合并 → 串行 Router 评估 → 裁决执行
 *   裁决的副作用动作(steer/cancel/retry/stop)立案成 pendingActions 记录,执行成功
 *   移除、失败按上限重试;崩溃后由恢复流程按序补执行。
 *   Worker 完成 → 汇报抓取 → report Trigger 回流线程 → 再次 Router 评估
 *   看门狗每 15s 对账:错过完成、卡死启动、超时中断、评估重排、待执行动作补执行。
 *
 * 不变量:所有状态先落盘再执行副作用;崩溃后 watchdog/prime 恢复。
 */

const WATCHDOG_INTERVAL_MS = 15_000;
const LAUNCH_STUCK_MS = 5 * 60_000;
const ROUTER_EVAL_TIMEOUT_MS = 10 * 60_000;
/** 单个待执行动作的尝试上限(首次执行 + 看门狗重试),超过后放弃并回流失败。 */
const MAX_ACTION_ATTEMPTS = 3;
/** 同一线程连续放弃的动作数达到上限后,不再自动回流失败触发,防 Router 循环。 */
const MAX_ABANDONED_ACTIONS = 3;
const PREFERRED_PROVIDERS = ["claude", "codex", "opencode"];

/**
 * 带副作用的裁决动作立案成可恢复记录(steer/cancel/retry/stop);
 * dispatch 的补执行由 pending 票据 + 看门狗承担,reply/ignore 无副作用。
 */
function planPendingAction(threadId: string, decisionId: string, action: RouterAction): PendingAction | null {
  if (action.action === "steer") {
    return {
      id: newId("act"),
      threadId,
      decisionId,
      kind: "steer",
      ticketId: action.ticketId,
      text: action.text,
      mode: action.mode ?? null,
      attempts: 0,
      createdAt: new Date().toISOString(),
    };
  }
  if (action.action === "cancel" || action.action === "retry") {
    return {
      id: newId("act"),
      threadId,
      decisionId,
      kind: action.action,
      ticketId: action.ticketId,
      text: null,
      mode: null,
      attempts: 0,
      createdAt: new Date().toISOString(),
    };
  }
  if (action.action === "stop") {
    return {
      id: newId("act"),
      threadId,
      decisionId,
      kind: "stop",
      ticketId: null,
      text: null,
      mode: null,
      attempts: 0,
      createdAt: new Date().toISOString(),
    };
  }
  return null;
}

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
  /** 同一线程连续放弃(重试耗尽)的动作计数,达到上限后不再自动回流失败触发。 */
  private actionFailures = new Map<string, number>();
  /** 待执行动作的串行链:保证同线程按裁决顺序执行,内联执行与看门狗补执行互不重叠。 */
  private actionChain: Promise<void> = Promise.resolve();
  private deliveryChain: Promise<void> = Promise.resolve();
  private sendingDeliveries = new Set<string>();
  /** 已提示过的 provider 设置纠正(每个设置值只告警一次)。 */
  private providerNotes = new Set<string>();
  /** 无原生 session ID 的 provider,至少在本引擎生命周期内复用初始化状态。 */
  private routerSessionsSeen = new Set<string>();
  /** Worker 基础目录检查(可替换,便于测试)与缓存结果。 */
  workingDirProbe: WorkingDirProbe = nodeWorkingDirProbe;
  private workingDirIssue: string | null = null;
  private workingDirCheck: { key: string; at: number } | null = null;
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
      if (state.status !== "ready") return;
      this.settingsValues = state.values;
      void this.refreshWorkingDirIssue();
    });
    void settings.read().then((state) => {
      if (state.status !== "ready") return;
      this.settingsValues = state.values;
      void this.refreshWorkingDirIssue();
    });
  }

  /** 重新检查 Worker 基础目录并缓存结果(snapshot 同步读取缓存)。 */
  async refreshWorkingDirIssue(): Promise<string | null> {
    const { workingDir, workerIsolation } = this.settingsValues;
    const key = this.workingDirKey();
    const issue = await inspectWorkingDir(workingDir, workerIsolation, this.workingDirProbe).catch((error) => {
      console.error("[superagent] working directory check failed", error);
      return null;
    });
    // 检查期间设置可能已变化:只认与当前设置一致的结果。
    if (key === this.workingDirKey()) {
      this.workingDirIssue = issue;
      this.workingDirCheck = { key, at: Date.now() };
    }
    return issue;
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
    await this.deliveryChain;
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

    // 订阅直通:恰好一个活跃订阅 Ticket 时后续事件直通其 Worker(Worker 汇报除外)。
    // 多个订阅 Worker 意见不一时交给 Router 选择目标,不能默认发给第一个。
    const subscribed = this.subscribedTickets(this.store.get(), threadId);
    const direct = directTicket(subscribed);

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
      const directDelivered = await this.deliverDirect(trigger, direct);
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
    const reportId = newId("trg");
    await this.store.update((next) => {
      const target = next.threads.find((item) => item.id === threadId);
      if (target) {
        target.latestResult = { id: reportId, kind: "worker_report", text: report, ticketIds: [ticket.id], createdAt: now };
        target.updatedAt = now;
      }
      next.triggers.push({
        id: reportId,
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

  /** 订阅直通投递:直接发进唯一订阅 Ticket 的 Worker 会话(运行中则 steer),零 LLM。 */
  private async deliverDirect(trigger: Trigger, ticket: Ticket): Promise<boolean> {
    if (!ticket.workerAgentId) return false;
    const prefix = trigger.context ? "[context] " : "";
    const outcome = await this.sendToWorker(ticket.id, `${prefix}${trigger.text}`, "steer");
    if (outcome.ok) {
      await this.store.update((next) => {
        const target = next.triggers.find((t) => t.id === trigger.id);
        if (target) {
          target.status = "delivered";
          target.note = `direct → worker of ${ticket.id}`;
        }
      });
      return true;
    }
    // 直通失败退回评估路径。
    await this.store.update((next) => {
      const target = next.triggers.find((t) => t.id === trigger.id);
      if (target) {
        target.status = "pending";
        target.note = `direct delivery failed: ${truncate(outcome.error, 200)}`;
      }
    });
    return false;
  }

  /** 向 Ticket 的 Worker 发指令:waiting → running 重新计时并重新挂观察。 */
  private async sendToWorker(
    ticketId: string,
    text: string,
    mode: "steer" | "interrupt",
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const paseo = this.requirePaseo();
    const ticket = this.store.get().tickets.find((t) => t.id === ticketId);
    if (!ticket?.workerAgentId) {
      return { ok: false, error: `ticket ${ticketId} has no worker to receive messages` };
    }
    try {
      await paseo.agents.ref(ticket.workerAgentId).send(text, { activeTurnBehavior: mode });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    await this.store.update((next) => {
      const target = next.tickets.find((t) => t.id === ticketId);
      if (target?.status === "waiting") {
        target.status = "running";
        target.startedAt = new Date().toISOString();
        target.updatedAt = target.startedAt;
        target.lastError = null;
      }
    });
    if (this.store.get().tickets.find((t) => t.id === ticketId)?.status === "running") {
      this.watchTicket(ticketId);
    }
    return { ok: true };
  }

  /** Router 的 steer 动作:仅本线程 running/waiting 的 Worker 可接收指令。 */
  private async applySteer(
    threadId: string,
    ticketId: string,
    text: string,
    mode: "steer" | "interrupt",
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const ticket = this.store.get().tickets.find((t) => t.id === ticketId);
    if (!ticket || ticket.threadId !== threadId) {
      return { ok: false, error: `ticket ${ticketId} is not on this thread` };
    }
    if (!ticket.workerAgentId || !["running", "waiting"].includes(ticket.status)) {
      return { ok: false, error: `ticket ${ticketId} cannot receive messages while ${ticket.status}` };
    }
    return this.sendToWorker(ticketId, text, mode);
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
    const worker: RouterWorkerEnvironment = {
      workingDir: this.settingsValues.workingDir,
      isolation: this.settingsValues.workerIsolation,
      issue: await this.refreshWorkingDirIssue(),
      instructionFiles: await this.sharedInstructionFiles(),
      defaultWorker: {
        provider: this.settingsValues.workerProvider.trim() || state.kv.workerProvider || null,
        description: this.settingsValues.workerDescription,
      },
      profiles: this.settingsValues.workerProfiles,
    };
    const instructions = composeRouterInstructions(worker, this.settingsValues.routerInstructions);
    const configHash = createHash("sha256").update(instructions).digest("hex");
    const router = await ensureRouter(paseo, state, routerProvider, this.settingsValues.workingDir, instructions);
    if ("error" in router) throw new Error(router.error);
    const routerAgentId = router.agentId;
    if (state.kv.routerAgentId !== routerAgentId || state.kv.routerProvider !== routerProvider) {
      await this.store.update((next) => {
        next.kv.routerAgentId = routerAgentId;
        next.kv.routerProvider = routerProvider;
      });
    }

    // 2. 按原生会话复用规则与已读事件;仅初始化/配置变化/压缩恢复时补齐。
    const remembered = state.kv.routerPromptState;
    const compactionSeq = await routerCompactionSeq(router.handle);
    const sameSession = !router.created && remembered?.agentId === routerAgentId
      && (!remembered.sessionId || !router.sessionId || remembered.sessionId === router.sessionId)
      && ((router.sessionId !== null && remembered.sessionId === router.sessionId) || this.routerSessionsSeen.has(routerAgentId));
    const restoreContext = !sameSession || compactionSeq === null || compactionSeq > (remembered?.compactionSeq ?? 0)
      || (this.evalFailures.get(threadId) ?? 0) > 0;
    const unseenContext = state.triggers.filter((trigger) => trigger.threadId === threadId && trigger.status === "delivered"
      && (restoreContext || !remembered?.triggerIds.includes(trigger.id)))
      .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
    const contextTriggers = unseenContext.slice(-8);
    const prompt = composeEvalPrompt({
      thread,
      batch,
      state,
      routerInstructions: this.settingsValues.routerInstructions,
      worker,
      includeInstructions: (restoreContext || remembered?.configHash !== configHash)
        && !(router.created && routerUsesSystemPrompt(routerProvider)),
      includeHistory: restoreContext || !remembered?.threadIds.includes(threadId),
      contextTriggers,
    });
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

    // 4. 执行裁决:每个动作一条 Decision,带副作用的动作另立案待执行记录,一次落盘
    //    (先落盘后副作用);stop 之后的动作作废,不再立案。
    const triggerIds = batch.map((t) => t.id);
    const actions = verdict.actions;
    const decisions: Decision[] = [];
    const createdTickets: Ticket[] = [];
    /** 与已立案动作对齐的待执行记录;dispatch/reply/ignore 没有记录(null)。 */
    const actionRecords: (PendingAction | null)[] = [];
    const replies: string[] = [];
    let summary: string | null = null;
    for (const action of actions) {
      const decision = newDecision(threadId, triggerIds, action.action);
      if (action.action === "dispatch") {
        // 档位只能取自设置名单;未知名字退回默认 Worker 并记入裁决,派发本身不失败。
        const choice = matchWorkerProfile(action.profile, this.settingsValues.workerProfiles, DEFAULT_WORKER_PROFILE);
        if (choice.note) decision.rationale = choice.note;
        const ticket: Ticket = {
          id: newId("tkt"),
          threadId,
          title: action.title,
          mandate: action.mandate,
          status: "pending",
          workerAgentId: null,
          workspaceId: null,
          branchName: null,
          profile: choice.profile,
          provider: null,
          startedAt: null,
          attempts: 0,
          subscribed: !action.unsubscribe,
          report: null,
          lastError: null,
          createdAt: decision.createdAt,
          updatedAt: decision.createdAt,
        };
        decision.ticketId = ticket.id;
        createdTickets.push(ticket);
        if (!summary) summary = action.title;
      } else if (action.action === "reply") {
        decision.reply = action.reply;
        replies.push(action.reply);
        if (!summary) summary = action.reply;
      } else if (action.action === "steer") {
        decision.rationale = truncate(action.text, 300);
      } else if ("rationale" in action) {
        decision.rationale = action.rationale ?? null;
      }
      if ("ticketId" in action && action.ticketId) decision.ticketId = action.ticketId;
      decisions.push(decision);
      actionRecords.push(planPendingAction(threadId, decision.id, action));
      if (action.action === "stop") break;
    }
    const decidedAt = decisions[0]?.createdAt ?? new Date().toISOString();
    const replyDecision = decisions.filter((decision) => decision.outcome === "reply").at(-1);
    const fullReply = replies.join("\n\n");
    const origin = batch.find((trigger) => trigger.origin)?.origin;
    const delivery = fullReply && origin && replyDecision ? {
      id: `im-${replyDecision.id}`, threadId, origin,
      parts: splitImReply(fullReply, this.settingsValues.imReplyMaxChars), nextPart: 0,
      status: "pending" as const, createdAt: decidedAt, updatedAt: decidedAt,
    } : null;

    this.routerSessionsSeen.add(routerAgentId);
    await this.store.update((next) => {
      next.kv.routerPromptState = {
        agentId: routerAgentId, sessionId: routerSessionId(router.handle.current()) ?? router.sessionId, configHash,
        compactionSeq: Math.max(compactionSeq ?? 0, sameSession ? remembered?.compactionSeq ?? 0 : 0),
        threadIds: [...new Set([...(restoreContext ? [] : remembered?.threadIds ?? []), threadId])]
          .filter((id) => next.threads.some((thread) => thread.id === id)),
        triggerIds: [...new Set([...(restoreContext ? [] : remembered?.triggerIds ?? []), ...triggerIds, ...unseenContext.map((trigger) => trigger.id)])]
          .filter((id) => next.triggers.some((trigger) => trigger.id === id)),
      };
      if (delivery) next.imDeliveries.push(delivery);
      next.decisions.push(...decisions);
      next.tickets.push(...createdTickets);
      next.pendingActions.push(...actionRecords.filter((record): record is PendingAction => record !== null));
      for (const trigger of next.triggers) {
        if (triggerIds.includes(trigger.id)) trigger.status = "evaluated";
      }
      const target = next.threads.find((t) => t.id === threadId);
      if (target) {
        target.updatedAt = decidedAt;
        if (summary) target.summary = truncate(summary, 200);
        if (replyDecision && replies.length > 0) {
          target.latestResult = { id: replyDecision.id, kind: "router_reply", text: replies.join("\n\n"),
            ticketIds: [...new Set(batch.filter((trigger) => trigger.kind === "report" && trigger.sender.startsWith("worker:"))
              .map((trigger) => trigger.sender.slice("worker:".length)))], createdAt: decidedAt };
        }
      }
      // stop 不在此处关闭线程:关闭发生在动作执行到 stop 时,否则先于 stop 的
      // steer/cancel 会因票据已被批量取消而无法执行。
    });

    // 副作用按序执行;失败的动作留在待执行记录里由看门狗按上限重试,不再重放整批。
    const launchQueue = [...createdTickets];
    for (let index = 0; index < actionRecords.length; index++) {
      const action = actions[index];
      const record = actionRecords[index];
      if (action.action === "stop") {
        if (record) await this.runPendingAction(record.id);
        break;
      }
      if (action.action === "dispatch") {
        const ticket = launchQueue.shift();
        if (!ticket) continue;
        void this.startTicket(ticket.id).catch((error) => {
          console.error("[superagent] ticket launch failed", error);
        });
      } else if (record) {
        await this.runPendingAction(record.id);
      }
    }

    // 5. 答复回投:IM 触发回原聊天;agent 委派回原会话。
    if (delivery) {
      await this.sendImDelivery(delivery.id);
    } else if (fullReply && !origin) {
      const reply = truncate(fullReply, 2000);
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

  /** 全局串行发送,看门狗与手动补发不会同时发送同一段。 */
  private sendImDelivery(id: string): Promise<void> {
    if (this.sendingDeliveries.has(id)) return this.deliveryChain;
    this.sendingDeliveries.add(id);
    const send = this.deliveryChain.then(async () => {
      let delivery = this.store.get().imDeliveries.find((item) => item.id === id);
      if (!delivery || delivery.status !== "pending") return;
      // 首次落盘失败时记录仍可能留在内存;恢复发送前先确认它可以持久化。
      await this.store.update(() => {});
      while (delivery.nextPart < delivery.parts.length) {
        try {
          if (!this.replySink) throw new Error("IM reply channel is not available");
          await this.replySink.send(delivery.origin, delivery.parts[delivery.nextPart]);
        } catch {
          await this.store.update((next) => {
            const target = next.imDeliveries.find((item) => item.id === id);
            if (target) { target.status = "failed"; target.updatedAt = new Date().toISOString(); }
          });
          // 通道异常可能带 webhook 等凭据,只记录安全的定位信息。
          console.error(`[superagent] IM delivery ${id} failed at part ${delivery.nextPart + 1}/${delivery.parts.length}`);
          return;
        }
        await this.store.update((next) => {
          const target = next.imDeliveries.find((item) => item.id === id);
          if (!target) return;
          target.nextPart++;
          target.updatedAt = new Date().toISOString();
          if (target.nextPart === target.parts.length) target.status = "sent";
        });
        delivery = this.store.get().imDeliveries.find((item) => item.id === id);
        if (!delivery) return;
      }
    });
    this.deliveryChain = send.catch((error) => console.error("[superagent] IM outbox processing failed", error))
      .finally(() => { this.sendingDeliveries.delete(id); });
    return this.deliveryChain;
  }

  async retryImDelivery(id: string): Promise<void> {
    await this.store.ready;
    const delivery = this.store.get().imDeliveries.find((item) => item.id === id);
    if (!delivery) throw new Error("IM delivery not found");
    if (delivery.status !== "failed") throw new Error("只有发送失败的答复可以补发");
    await this.store.update((next) => {
      const target = next.imDeliveries.find((item) => item.id === id)!;
      target.status = "pending";
    });
    await this.sendImDelivery(id);
    if (this.store.get().imDeliveries.find((item) => item.id === id)?.status === "failed") {
      throw new Error("补发失败,进度已保留。请检查 IM 连接或回复窗口是否过期");
    }
    if (this.store.get().imDeliveries.find((item) => item.id === id)?.status !== "sent") {
      throw new Error("答复尚未全部发送,进度已保留,请稍后查看运行状态");
    }
  }

  // -------------------------------------------------------- pending actions

  /**
   * 串行执行一条待执行动作:全局同一时刻只有一个动作在执行,同线程按裁决顺序推进。
   * 只执行该线程队列的队首记录;后面的记录等队首完成或放弃后,由内联循环或看门狗接手。
   */
  private runPendingAction(recordId: string): Promise<void> {
    const next = this.actionChain.then(async () => {
      try {
        await this.executePendingAction(recordId);
      } catch (error) {
        console.error("[superagent] pending action execution failed", error);
      }
    });
    this.actionChain = next;
    return next;
  }

  private async executePendingAction(recordId: string): Promise<void> {
    await this.store.ready;
    const pending = this.store.get().pendingActions;
    const record = pending.find((a) => a.id === recordId);
    if (!record) return;
    const head = pending.find((a) => a.threadId === record.threadId);
    if (head?.id !== recordId) return;
    if (record.attempts >= MAX_ACTION_ATTEMPTS) {
      await this.abandonPendingAction(record, `${record.kind} exceeded ${MAX_ACTION_ATTEMPTS} attempts`);
      return;
    }
    const attempt = record.attempts + 1;
    await this.store.update((next) => {
      const target = next.pendingActions.find((a) => a.id === recordId);
      if (target && target.attempts === attempt - 1) target.attempts = attempt;
    });
    const outcome = await this.performPendingAction(record);
    if (outcome.ok) {
      await this.store.update((next) => {
        next.pendingActions = next.pendingActions.filter((a) => a.id !== recordId);
      });
      this.actionFailures.delete(record.threadId);
      return;
    }
    console.error(
      `[superagent] ${record.kind} action failed (attempt ${attempt}/${MAX_ACTION_ATTEMPTS}) on thread ${record.threadId}: ${outcome.error}`,
    );
    const current = this.store.get().pendingActions.find((a) => a.id === recordId);
    if (current && current.attempts >= MAX_ACTION_ATTEMPTS) {
      await this.abandonPendingAction(current, outcome.error);
    }
  }

  /** 放弃重试耗尽的动作:移除记录、给原批触发留备注,并把失败回流成触发交 Router 重新决策。 */
  private async abandonPendingAction(record: PendingAction, error: string): Promise<void> {
    const note = `${record.kind} action failed: ${truncate(error, 200)}`;
    await this.store.update((next) => {
      next.pendingActions = next.pendingActions.filter((a) => a.id !== record.id);
      const decision = next.decisions.find((d) => d.id === record.decisionId);
      if (!decision) return;
      for (const trigger of next.triggers) {
        if (decision.triggerIds.includes(trigger.id)) trigger.note = note;
      }
    });
    const failures = (this.actionFailures.get(record.threadId) ?? 0) + 1;
    this.actionFailures.set(record.threadId, failures);
    if (failures >= MAX_ABANDONED_ACTIONS) {
      console.error(
        `[superagent] thread ${record.threadId} abandoned ${failures} actions in a row; holding off further re-enqueueing`,
      );
      return;
    }
    await this.enqueueActionFailure(record, error);
  }

  /** 失败回流:引擎以触发形式把未送达的意图交回线程重新评估,人发的消息不能凭空消失。 */
  private async enqueueActionFailure(record: PendingAction, error: string): Promise<void> {
    const thread = this.store.get().threads.find((t) => t.id === record.threadId);
    if (!thread) return;
    const detail =
      record.kind === "steer" && record.text
        ? `Undelivered instruction for ${record.ticketId}: "${truncate(record.text, 400)}"`
        : `Intent: ${record.kind}${record.ticketId ? ` ${record.ticketId}` : ""} (see the matching router decision).`;
    const now = new Date().toISOString();
    await this.store.update((next) => {
      next.triggers.push({
        id: newId("trg"),
        kind: "engine",
        sender: "engine",
        threadKey: thread.key,
        text: `[engine] Router ${record.kind} action failed after ${record.attempts} attempts: ${truncate(error, 300)}.\n${detail}`,
        context: false,
        replyToAgentId: null,
        origin: null,
        receivedAt: now,
        status: "pending",
        note: null,
        threadId: record.threadId,
      });
    });
    this.scheduleEval(record.threadId, 0);
  }

  /** 动作的幂等执行:执行中断后重跑得到同样的最终状态。 */
  private async performPendingAction(
    record: PendingAction,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const paseo = this.requirePaseo();
    if (record.kind === "steer") {
      return this.applySteer(record.threadId, record.ticketId ?? "", record.text ?? "", record.mode ?? "steer");
    }
    if (record.kind === "cancel") {
      const ticket = this.store.get().tickets.find((t) => t.id === record.ticketId);
      if (!ticket || ticket.threadId !== record.threadId) return { ok: true };
      if (["completed", "failed", "canceled"].includes(ticket.status)) {
        // 上次执行中断:票据已标取消但 Worker 可能尚未回收,补回收。
        if (ticket.workerAgentId) await retireWorker(paseo, ticket, true);
        return { ok: true };
      }
      await this.cancelTicket(ticket.id);
      return { ok: true };
    }
    if (record.kind === "retry") {
      const ticket = this.store.get().tickets.find((t) => t.id === record.ticketId);
      if (!ticket || ticket.threadId !== record.threadId) return { ok: true };
      if (["failed", "canceled", "completed"].includes(ticket.status)) {
        await this.retryTicket(ticket.id);
        return { ok: true };
      }
      // 已被重置过(上次执行中断):pending 票据由看门狗接手启动。
      return { ok: true };
    }
    // stop:快照仍活跃的 Worker,落盘关闭线程,再逐一回收。执行中断后重跑时线程已
    // 关闭,改为回收已取消但仍持有 Worker 的票据(其中就包括上次没来得及回收的)。
    const state = this.store.get();
    const thread = state.threads.find((t) => t.id === record.threadId);
    if (!thread) return { ok: true };
    const alreadyClosed = thread.state === "closed";
    const retiring = state.tickets.filter(
      (t) =>
        t.threadId === record.threadId &&
        t.workerAgentId &&
        (alreadyClosed
          ? t.status === "canceled"
          : !["completed", "failed", "canceled"].includes(t.status)),
    );
    await this.markThreadClosed(record.threadId);
    for (const ticket of retiring) await retireWorker(paseo, ticket, true);
    return { ok: true };
  }

  // -------------------------------------------------------------- workers

  private async startTicket(ticketId: string): Promise<void> {
    await this.store.ready;
    const paseo = this.requirePaseo();
    let state = this.store.get();
    const ticket = state.tickets.find((t) => t.id === ticketId);
    if (!ticket || ticket.status !== "pending") return;

    let workerProvider: string;
    let profile: string | null;
    try {
      ({ provider: workerProvider, profile } = await this.resolveTicketWorker(ticket, state));
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
    // kv 只记默认 Worker 的解析结果(自动选择时跨重启稳定);具名档位的 provider 记在票据上。
    if (!profile && state.kv.workerProvider !== workerProvider) {
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
      target.profile = profile;
      target.provider = workerProvider;
      target.updatedAt = now;
    });
    if (!attempt) return;

    state = this.store.get();
    const current = state.tickets.find((t) => t.id === ticketId);
    if (!current || current.status !== "launching" || current.attempts !== attempt || current.startedAt !== now) return;
    try {
      // 基础目录不可用时带着目录与隔离方式失败,Router 收到的汇报能指明确切原因。
      const workingDirIssue = await this.refreshWorkingDirIssue();
      if (workingDirIssue) throw new Error(workingDirIssue);
      const launch = await launchWorker(
        paseo,
        this.settingsValues,
        workerProvider,
        current,
        state.kv.routerAgentId ?? null,
        await this.sharedInstructionFiles(),
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
        target.branchName = launch.branchName;
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
    for (const delivery of state.imDeliveries) {
      if (delivery.status === "pending" && !this.sendingDeliveries.has(delivery.id)) {
        acted++;
        void this.sendImDelivery(delivery.id);
      }
    }

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

    // 待执行动作补执行(评估中断/失败重试):每线程只踢队首,串行链保证按序与互斥。
    const actionHeads = new Set<string>();
    for (const record of state.pendingActions) {
      if (actionHeads.has(record.threadId)) continue;
      actionHeads.add(record.threadId);
      acted += 1;
      void this.runPendingAction(record.id);
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
    this.actionFailures.delete(threadId);
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
    await this.markThreadClosed(threadId);
    for (const ticket of active) await retireWorker(paseo, ticket, true);
  }

  /** 关闭线程的落盘部分:线程关闭、活跃票据取消、pending 触发消费。 */
  private async markThreadClosed(threadId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.store.update((next) => {
      const thread = next.threads.find((t) => t.id === threadId);
      if (!thread) return;
      thread.state = "closed";
      thread.updatedAt = now;
      for (const ticket of next.tickets) {
        if (ticket.threadId === threadId && !["completed", "failed", "canceled"].includes(ticket.status)) {
          ticket.status = "canceled";
          ticket.subscribed = false;
          ticket.updatedAt = now;
        }
      }
      for (const trigger of next.triggers) {
        if (trigger.threadId === threadId && trigger.status === "pending") {
          trigger.status = "evaluated";
          trigger.note = "thread closed";
        }
      }
    });
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

  snapshot(options: { includeClosed?: boolean; threadId?: string; omitRecords?: boolean } = {}): SuperagentSnapshot {
    const state = this.store.get();
    const settings = this.settingsValues;
    const threads = state.threads
      .filter((t) => (!options.threadId || t.id === options.threadId)
        && (options.includeClosed || t.state === "active" || state.tickets.some((k) => k.threadId === t.id && k.status === "running")))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((thread) => {
        const tickets = state.tickets.filter((t) => t.threadId === thread.id);
        const ticketCounts: Record<string, number> = {};
        for (const ticket of tickets) {
          ticketCounts[ticket.status] = (ticketCounts[ticket.status] ?? 0) + 1;
        }
        const lastDecision = state.decisions.reduce<Decision | null>((latest, decision) =>
          decision.threadId === thread.id && (!latest || decision.createdAt >= latest.createdAt) ? decision : latest, null);
        return {
          ...thread,
          latestResult: threadResult(thread, state),
          lastDecision: lastDecision ? { outcome: lastDecision.outcome, createdAt: lastDecision.createdAt } : null,
          pendingTriggers: state.triggers.filter(
            (t) => t.threadId === thread.id && t.status === "pending",
          ).length,
          ticketCounts,
        };
      });
    return {
      configured: Boolean(settings.workingDir),
      workingDir: settings.workingDir,
      workingDirIssue: this.cachedWorkingDirIssue(),
      routerAgentId: state.kv.routerAgentId ?? null,
      routerProvider: state.kv.routerProvider || settings.routerProvider || null,
      workerProvider: state.kv.workerProvider || settings.workerProvider || null,
      workerProfiles: settings.workerProfiles.map(({ name, provider, description }) => ({ name, provider, description })),
      threads,
      recentResults: recentResults(state, options.threadId),
      tickets: state.tickets
        .filter((t) => threads.some((th) => th.id === t.threadId))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      triggers: options.omitRecords ? [] : state.triggers
        .filter((t) => threads.some((th) => th.id === t.threadId))
        .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
        .slice(0, 120),
      decisions: options.omitRecords ? [] : state.decisions
        .filter((d) => threads.some((th) => th.id === d.threadId))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 120),
      imDeliveries: state.imDeliveries
        .filter((item) => !options.threadId || item.threadId === options.threadId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map(({ id, threadId, origin, parts, nextPart, status, updatedAt }) => ({
          id, threadId, title: state.threads.find((thread) => thread.id === threadId)?.title ?? threadId,
          channel: origin.channel, totalParts: parts.length, nextPart, status, updatedAt,
        })),
      engine: {
        running: this.primed,
        primed: this.primed,
        lastWatchdogAt: this.lastWatchdogAt,
        lastWatchdogNote: this.lastWatchdogNote,
        evalInFlight: this.evalInFlight,
        currentEvalThreadId: this.currentEvalThread,
      },
      chatTabs: this.chatTabs(),
    };
  }

  /** 对话页标签:保存过就用保存的(去掉已清理的线程),否则取界面发起且进行中的对话。 */
  chatTabs(): ChatTabs {
    const state = this.store.get();
    const saved = state.kv.chatTabs;
    if (!saved) return defaultChatTabs(state.threads, state.triggers);
    return pruneChatTabs(saved, new Set(state.threads.map((thread) => thread.id)));
  }

  async saveChatTabs(tabs: ChatTabs): Promise<void> {
    await this.store.ready;
    await this.store.update((next) => {
      next.kv = { ...next.kv, chatTabs: pruneChatTabs(tabs, new Set(next.threads.map((thread) => thread.id))) };
    });
  }

  // ------------------------------------------------------------- helpers

  /** shared 隔离时工作目录自带的项目说明文件;worktree 隔离时仓库内的说明随 worktree 一起检出,无需提示。 */
  private async sharedInstructionFiles(): Promise<string[]> {
    if (this.settingsValues.workerIsolation !== "shared") return [];
    return findInstructionFiles(this.settingsValues.workingDir, this.workingDirProbe).catch(() => []);
  }

  private workingDirKey(): string {
    return `${this.settingsValues.workingDir}\u0000${this.settingsValues.workerIsolation}`;
  }

  /** snapshot 用的缓存结果;过期(5s)或设置已变时后台刷新,UI 轮询下一次即可拿到。 */
  private cachedWorkingDirIssue(): string | null {
    const key = this.workingDirKey();
    const check = this.workingDirCheck;
    if (!check || check.key !== key || Date.now() - check.at > 5_000) void this.refreshWorkingDirIssue();
    return check?.key === key ? this.workingDirIssue : null;
  }

  private requirePaseo(): PaseoApi {
    if (!this.paseo) throw new Error("engine not primed yet");
    return this.paseo;
  }

  /**
   * Ticket 的 Worker provider:具名档位按设置校验(设置改了模型时 retry 用新模型);
   * 档位已从设置里删除或为空时用默认 Worker,并把票据改记为默认档位。
   */
  private async resolveTicketWorker(
    ticket: Ticket,
    state: SuperagentState,
  ): Promise<{ provider: string; profile: string | null }> {
    const name = ticket.profile;
    if (name) {
      const profile = this.settingsValues.workerProfiles.find((candidate) => candidate.name === name);
      if (profile) {
        const provider = await this.validateConfiguredProvider(`worker profile "${name}"`, profile.provider);
        return { provider, profile: name };
      }
      console.warn(`[superagent] worker profile "${name}" of ticket ${ticket.id} is no longer configured; using the default worker`);
    }
    return { provider: await this.resolveProvider("worker", state.kv.workerProvider), profile: null };
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
  private async validateConfiguredProvider(role: string, configured: string): Promise<string> {
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
