import type { PaseoApi, PaseoWorkspaceHandle } from "@getpaseo/client";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { PluginSettings } from "@getpaseo/plugin/server";
import type { SuperagentStore } from "./store";
import { followsOf, subscribesTo } from "../shared/execution";
import { recentResults, threadResult } from "../shared/results";
import { defaultChatTabs, pruneChatTabs, type ChatTabs } from "../shared/chat-tabs";
import {
  dispatchMandateIssue,
  newId,
  truncate,
  MAX_SPECULATIVE_TICKETS,
  SUBSCRIBED_STATUSES,
  TERMINAL_TICKET_STATUSES,
  type Decision,
  type PendingAction,
  type RouterAction,
  type SuperagentSnapshot,
  type SuperagentState,
  type Thread,
  type Ticket,
  type Trigger,
  type TriggerOrigin,
  type WatchdogState,
} from "../shared/model";
import {
  DEFAULT_WORKER_PROFILE,
  DEFAULT_WORKSPACE_TITLE,
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
import { harvestReport, launchWorker, retireWorker, type WorkerLaunchEnv } from "./workers";
import type { ToolOutcome } from "./mcp-server";
import { matchWorkerProfile, resolveProviderSelection } from "./providers";
import { ensureSharedWorkspace } from "./workspace";
import { findInstructionFiles, inspectWorkingDir, nodeWorkingDirProbe, type WorkingDirProbe } from "./workdir";
import { splitImReply } from "./im-replies";
import {
  composePatrolPrompt,
  composeWatchdogInstructions,
  ensureWatchdog,
  parseWatchdogVerdict,
  WATCHDOG_RUN_TIMEOUT_MS,
  type PatrolDigest,
  type PatrolTicket,
  type WatchdogAction,
} from "./watchdog";

/**
 * Superagent 引擎:整个编排层的驱动核心。
 *
 * 数据流(对齐文章的事件驱动模型):
 *   dispatch() → fast-path 截断/放行 → Thread 归属(引用回复优先归入被引用消息的线程)
 *     ├─ 线程有活跃订阅(含跟随该线程的其他线程票据)且有会话 → 全部直通(零 LLM)
 *     └─ 否则(或旁听到的 context-only 消息)积攒 → 批窗口合并 → 串行 Router 评估 → 裁决执行
 *   裁决的副作用动作(steer/cancel/retry/stop)立案成 pendingActions 记录,执行成功
 *   移除、失败按上限重试;崩溃后由恢复流程按序补执行。
 *   Worker 完成 → 汇报抓取 → report Trigger 回流到它订阅的每个线程 → 再次 Router 评估
 *   (投机执行的 DISCARD 汇报静默丢弃,不进 Router)
 *   程序看门狗每 15s 对账:错过完成、卡死启动、超时中断、评估重排、待执行动作补执行;
 *   LLM 看门狗(设置开启时)按间隔巡检进展与偏离,经 JSON 动作介入。
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
/** 评估异常(provider 未就绪/目录不可用等瞬时故障)的自动重排上限:15s 看门狗节奏 ≈ 5 分钟。 */
const MAX_EVAL_ERRORS = 20;
/** 单线程 filtered 留痕上限:滚动保留最近这么多条(相邻消息内联的来源),旧的先丢。 */
const MAX_FILTERED_TRIGGERS = 30;
/** 评估时内联的未 @ 相邻群聊条数(§3.3 Inline:时空相邻的消息)。 */
const CHATTER_CONTEXT = 5;
/** 引擎启动前到达(IM 先连上)的触发备注;引擎启动后据此补直通。 */
const QUEUED_BEFORE_START = "queued before the engine started";
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
  /** IM 消息引用/回复的平台消息 id(父消息在前):命中本地记录时归入其线程并内联原文。 */
  replyTo?: string[];
}

/** 答复外发通道:由 index.server 注入(engine 不直接依赖具体 IM 实现)。 */
export interface ReplySink {
  /** 返回通道回执里的消息 id(有的话),用于用户引用答复时找回线程。 */
  send(origin: TriggerOrigin, text: string): Promise<string | null | void>;
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
  /**
   * 线程评估的 unparsed 计数(模型输出质量),≥3 次后看门狗不再自动重排,
   * 需人工「重新评估」——防 Router 持续劣化时的失控 token 循环。
   * 与之分离:基础设施异常(provider 未就绪/目录不可用/网络)计入 evalErrors,
   * 上限更高(瞬时故障应按看门狗节奏持续重查,对齐文章 §6)。
   */
  private evalFailures = new Map<string, number>();
  private evalErrors = new Map<string, number>();
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
  /** 共享工作区句柄缓存(dir+title → handle),命中时避免重复扫描/新建;串行链防并发重复建。 */
  private sharedWorkspaceCache = new Map<string, PaseoWorkspaceHandle>();
  private workspaceChain: Promise<unknown> = Promise.resolve();
  private lastWatchdogAt: string | null = null;
  private lastWatchdogNote: string | null = null;
  /** LLM 看门狗巡检进行中(单飞:一次巡检没结束不起下一次)。 */
  private patrolInFlight = false;
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

  /** 事件入口:fast-path → Thread 归属 → 订阅 fan-out 直通 | 排队评估。 */
  async dispatch(input: DispatchInput): Promise<{ threadId: string; triggerId: string; directDelivered: boolean; note: string | null }> {
    const outcome = await this.intake(input, { status: "pending" });
    if (!outcome) throw new Error("empty task");
    return outcome;
  }

  /**
   * 准入丢弃留痕(§3.1 过滤档):与 dispatch 同一线程归属,但状态记 filtered、
   * 带原因备注,不评估、不直通,也不重开已关闭的线程;每线程留痕有上限,
   * 防高频群聊把状态刷满。UI 气泡上显示「已过滤 · 原因」。
   */
  async dispatchFiltered(input: DispatchInput, reason: string): Promise<void> {
    await this.intake(input, { status: "filtered", note: truncate(reason, 200) });
  }

  private async intake(
    input: DispatchInput,
    admission: { status: "pending" | "filtered"; note?: string },
  ): Promise<{ threadId: string; triggerId: string; directDelivered: boolean; note: string | null } | null> {
    await this.store.ready;
    const settings = this.settingsValues;
    const text = input.task.trim().slice(0, settings.triggerMaxChars);
    if (!text) {
      if (admission.status === "pending") throw new Error("empty task");
      return null;
    }

    const state = this.store.get();
    const linked = input.origin && input.replyTo?.length ? this.resolveQuoted(state, input.origin, input.replyTo) : null;
    let thread: Thread | undefined;
    if (input.threadId) {
      thread = state.threads.find((t) => t.id === input.threadId);
      if (!thread) throw new Error(`thread ${input.threadId} not found`);
    } else if (linked?.threadId && state.threads.some((t) => t.id === linked.threadId)) {
      // 引用回复(§3.2 Thread = 同一话题):回复哪条已知消息/答复,就归入那条消息的线程。
      thread = state.threads.find((t) => t.id === linked.threadId);
    } else if (input.threadKey) {
      // IM 触发:同一聊天固定 Thread,订阅直通与 Router 记忆跨消息延续。
      thread = state.threads.find((t) => t.key === input.threadKey);
    }
    if (thread && thread.state === "closed" && admission.status === "pending") {
      // 关闭线程上的新事件重新激活线程(被过滤的消息不重开)。
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

    if (admission.status === "filtered") {
      // 留痕滚动上限:超过后丢弃该线程最旧的 filtered 记录,保留最近的相邻消息供内联。
      await this.store.update((next) => {
        if (!next.threads.some((t) => t.id === threadId)) {
          next.threads.push(thread!);
        }
        const filtered = next.triggers.filter((t) => t.threadId === threadId && t.status === "filtered")
          .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
        if (filtered.length >= MAX_FILTERED_TRIGGERS) {
          const drop = new Set(filtered.slice(0, filtered.length - MAX_FILTERED_TRIGGERS + 1).map((t) => t.id));
          next.triggers = next.triggers.filter((t) => !drop.has(t.id));
        }
        next.triggers.push({
          id: triggerId,
          kind: input.origin ? input.origin.channel : input.kind === "agent" ? "agent" : "manual",
          sender,
          threadKey,
          text,
          context: input.context ?? false,
          replyToAgentId: input.replyToAgentId ?? null,
          origin: input.origin ?? null,
          receivedAt: now,
          status: "filtered",
          note: admission.note ?? null,
          threadId,
          quote: linked?.quote ?? null,
        });
      });
      return null;
    }

    // 订阅直通(fan-out):活跃订阅(含跟随本线程的票据)且有会话的 Worker 全部收到本条消息;
    // 一个可用会话都没有(无订阅,或订阅仍在启动)才交 Router 评估。旁听到的 context-only
    // 群聊不直通(线程按聊天划分,闲聊不该打断 Worker),一律交 Router 做语义判断。
    const subscribed = input.context ? [] : this.subscribedTickets(this.store.get(), threadId);
    const direct = subscribed.filter((ticket) => ticket.workerAgentId);
    // 引擎尚未启动(IM 先于首个 hook 连上):先落盘排队,启动后由 recover 补直通/评估。
    const queuedBeforeStart = !this.paseo;

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
      note: queuedBeforeStart ? QUEUED_BEFORE_START : null,
      threadId,
      quote: linked?.quote ?? null,
    };

    await this.store.update((next) => {
      if (!next.threads.some((t) => t.id === threadId)) {
        next.threads.push(thread!);
      }
      next.triggers.push(trigger);
      const target = next.threads.find((t) => t.id === threadId);
      if (target) target.updatedAt = now;
    });

    if (queuedBeforeStart) {
      return { threadId, triggerId, directDelivered: false, note: "queued until the orchestrator engine starts" };
    }
    if (direct.length > 0) {
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
    // 触发文本里的汇报截断时带上票据 ID 存根:Router 可用 superagent_read 回读全文。
    const clippedReport = truncate(report, 2000);
    const recallSuffix = report.length > 2000 ? `\n[report truncated — full report: superagent_read ${ticket.id}]` : "";
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
        text: `Worker report for "${ticket.title}":\n${clippedReport}${recallSuffix}`,
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

  /** 订阅本线程的活跃票据:本线程 subscribed 的,加上 follows 里含本线程的(多对多)。 */
  private subscribedTickets(state: SuperagentState, threadId: string): Ticket[] {
    return state.tickets.filter((t) => subscribesTo(t, threadId) && SUBSCRIBED_STATUSES.includes(t.status));
  }

  /**
   * 相邻消息内联(§3.3):本批之前、Router 上次看过的事件之后,同一线程里被准入层过滤的
   * 未 @ 群聊(最近几条)。Router 由此看到"@ 之前大家在聊什么",无需工具往返。
   */
  private chatterFor(state: SuperagentState, threadId: string, batch: Trigger[]): Trigger[] {
    const imBatch = batch.filter((trigger) => trigger.origin);
    if (imBatch.length === 0) return [];
    const batchIds = new Set(batch.map((trigger) => trigger.id));
    const lastBatchAt = imBatch.map((trigger) => trigger.receivedAt).sort().at(-1)!;
    const firstBatchAt = batch.map((trigger) => trigger.receivedAt).sort()[0];
    const seenAt = state.triggers
      .filter((t) => t.threadId === threadId && !batchIds.has(t.id) && ["evaluated", "delivered"].includes(t.status)
        && t.receivedAt < firstBatchAt)
      .map((t) => t.receivedAt).sort().at(-1) ?? "";
    return state.triggers
      .filter((t) => t.threadId === threadId && t.status === "filtered" && t.receivedAt > seenAt && t.receivedAt <= lastBatchAt)
      .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))
      .slice(-CHATTER_CONTEXT);
  }

  /**
   * 引用解析(§3.2/§3.3):按平台消息 id 在同一聊天里找被引用的触发或 Router 答复。
   * 线程取第一个命中的 id(父消息优先,其次回复链根);内联原文只取直接父消息。
   */
  private resolveQuoted(
    state: SuperagentState,
    origin: TriggerOrigin,
    ids: string[],
  ): { threadId: string | null; quote: NonNullable<Trigger["quote"]> } {
    const sameChat = (other: TriggerOrigin | null | undefined) =>
      other?.channel === origin.channel && other.chatId === origin.chatId;
    let threadId: string | null = null;
    let quote: NonNullable<Trigger["quote"]> = { messageId: ids[0], triggerId: null, sender: null, text: null };
    ids.forEach((id, index) => {
      const trigger = state.triggers.find((t) => sameChat(t.origin) && t.origin?.messageId === id);
      const delivery = trigger ? undefined
        : state.imDeliveries.find((d) => sameChat(d.origin) && (d.sentMessageIds ?? []).includes(id));
      const matchThread = trigger?.threadId ?? delivery?.threadId ?? null;
      if (!threadId && matchThread) threadId = matchThread;
      if (index !== 0) return;
      if (trigger) quote = { messageId: id, triggerId: trigger.id, sender: trigger.sender, text: truncate(trigger.text, 400) };
      else if (delivery) quote = { messageId: id, triggerId: null, sender: "router", text: truncate(delivery.parts.join("\n"), 400) };
    });
    return { threadId, quote };
  }

  /**
   * 订阅直通投递(fan-out):直接发进全部活跃订阅 Worker 的会话(运行中则 steer),零 LLM。
   * 任一投递成功即视为已直通(触发标记 delivered,note 记录全部命中目标);
   * 全部失败才退回评估路径,失败原因逐个留备注。
   */
  private async deliverDirect(trigger: Trigger, tickets: Ticket[]): Promise<boolean> {
    const prefix = trigger.context ? "[context] " : "";
    const quoted = trigger.quote?.text
      ? `> quoting ${trigger.quote.sender ?? "an earlier message"}: ${truncate(trigger.quote.text.replace(/\s+/g, " "), 300)}\n`
      : "";
    const thread = this.store.get().threads.find((t) => t.id === trigger.threadId);
    const delivered: string[] = [];
    const failures: string[] = [];
    for (const ticket of tickets) {
      // 跟随来的线程标出来源,Worker 才知道这条消息属于哪段对话(可按线程退订)。
      const origin = ticket.threadId !== trigger.threadId && thread
        ? `[thread ${thread.id} "${truncate(thread.title, 60)}"] `
        : "";
      const outcome = await this.sendToWorker(ticket.id, `${origin}${prefix}${quoted}${trigger.text}`, "steer");
      if (outcome.ok) delivered.push(ticket.id);
      else failures.push(`${ticket.id}: ${truncate(outcome.error, 120)}`);
    }
    if (delivered.length > 0) {
      await this.store.update((next) => {
        const target = next.triggers.find((t) => t.id === trigger.id);
        if (target) {
          target.status = "delivered";
          target.note = `direct → workers of ${delivered.join(", ")}`;
        }
      });
      return true;
    }
    await this.store.update((next) => {
      const target = next.triggers.find((t) => t.id === trigger.id);
      if (target) {
        target.status = "pending";
        target.note = `direct delivery failed: ${failures.join("; ") || "no subscriber has a live session"}`;
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

  /** Router 的 steer 动作:任意线程 running/waiting 的 Worker 都可接收指令(跨线程指挥)。 */
  private async applySteer(
    ticketId: string,
    text: string,
    mode: "steer" | "interrupt",
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const ticket = this.store.get().tickets.find((t) => t.id === ticketId);
    if (!ticket) {
      return { ok: false, error: `ticket ${ticketId} not found` };
    }
    if (!ticket.workerAgentId || !["running", "waiting"].includes(ticket.status)) {
      return { ok: false, error: `ticket ${ticketId} cannot receive messages while ${ticket.status}` };
    }
    return this.sendToWorker(ticketId, text, mode);
  }

  // ------------------------------------------------------------ eval loop

  /**
   * 批窗口:窗口内同线程触发合并进一次评估(文章的批处理设计)。
   * 窗口一经武装不再被后续触发重置——持续到来的消息只会加入本次批次,
   * 不会把评估点无限推迟(有界合并);显式 delayMs(如 0 = 立即)仍会替换定时器。
   */
  private scheduleEval(threadId: string, delayMs?: number): void {
    if (delayMs !== undefined) {
      const existing = this.batchTimers.get(threadId);
      if (existing) clearTimeout(existing);
      this.armEval(threadId, delayMs);
      return;
    }
    if (!this.batchTimers.has(threadId)) this.armEval(threadId, this.settingsValues.evalBatchMs);
  }

  private armEval(threadId: string, delay: number): void {
    const timer = setTimeout(() => {
      this.batchTimers.delete(threadId);
      this.evalQueued.add(threadId);
      void this.drainEvalQueue();
    }, delay);
    this.batchTimers.set(threadId, timer);
  }

  private async drainEvalQueue(): Promise<void> {
    // 引擎未启动时保留队列;启动后的 recover 会重新排上有 pending 触发的线程。
    if (this.evalInFlight || !this.paseo) return;
    const next = [...this.evalQueued][0];
    if (!next) return;
    this.evalInFlight = true;
    this.currentEvalThread = next;
    this.evalQueued.delete(next);
    try {
      await this.runEval(next);
    } catch (error) {
      console.error("[superagent] eval failed", error);
      // 异常走独立计数:瞬时故障(provider 未就绪等)按看门狗节奏持续重查,
      // 不与 unparsed(模型输出问题)共用 3 次熔断。
      this.evalErrors.set(next, (this.evalErrors.get(next) ?? 0) + 1);
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
      instructionFiles: await this.instructionFilesFor(this.settingsValues.workingDir),
      defaultWorker: {
        provider: this.settingsValues.workerProvider.trim() || state.kv.workerProvider || null,
        description: this.settingsValues.workerDescription,
      },
      profiles: this.settingsValues.workerProfiles,
    };
    const ruleOptions = { speculative: this.settingsValues.speculativeEnabled };
    const instructions = composeRouterInstructions(worker, this.settingsValues.routerInstructions, ruleOptions);
    const configHash = createHash("sha256").update(instructions).digest("hex");
    // Router 落在默认 workspace 里;惰性获取——Router 存活时零开销,重建时才查找/新建。
    // 回读/检索工具(superagent_list/read/search)由 session_open 转换注入,不经 agent config。
    const router = await ensureRouter(
      paseo,
      state,
      routerProvider,
      () => this.sharedWorkspaceFor(this.settingsValues.workingDir, DEFAULT_WORKSPACE_TITLE),
      instructions,
    );
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
    const chatter = this.chatterFor(state, threadId, batch);
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
      chatter,
      options: ruleOptions,
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
    const recordUnparsed = async (reason: string) => {
      this.evalFailures.set(threadId, (this.evalFailures.get(threadId) ?? 0) + 1);
      await this.store.update((next) => {
        next.decisions.push(
          newDecision(threadId, batch.map((t) => t.id), "unparsed", {
            rationale: reason,
            raw: truncate(replyText, 1200),
          }),
        );
      });
    };
    if ("error" in parsed) {
      await recordUnparsed(parsed.error);
      return;
    }
    // dispatch 兜底:mandate 仅剩省略号时按解析失败处理(parseVerdict 已拒绝此类候选,
    // 此处防解析路径放宽后空工单漏网),整批触发同样保留 pending 供重试。
    const mandateBlock = parsed.verdict.actions
      .filter((action): action is Extract<RouterAction, { action: "dispatch" }> => action.action === "dispatch")
      .map((action) => dispatchMandateIssue(action.mandate))
      .find((issue): issue is string => issue !== null);
    if (mandateBlock) {
      await recordUnparsed(mandateBlock);
      return;
    }
    this.evalFailures.delete(threadId);
    this.evalErrors.delete(threadId);
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
    /** subscribe 动作:落盘时把票据挂到本线程(本线程票据恢复 subscribed,其他线程票据加入 follows)。 */
    const subscribeTickets: string[] = [];
    let liveSpeculative = state.tickets.filter((t) => t.speculative && !TERMINAL_TICKET_STATUSES.includes(t.status)).length;
    let summary: string | null = null;
    for (const action of actions) {
      const decision = newDecision(threadId, triggerIds, action.action);
      if (action.action === "dispatch") {
        // 投机执行仅在设置开启时生效;并发上限内才立案,超出的直接丢弃(记入裁决)。
        const speculative = Boolean(action.speculative) && this.settingsValues.speculativeEnabled;
        if (speculative && liveSpeculative >= MAX_SPECULATIVE_TICKETS) {
          decision.outcome = "ignore";
          decision.rationale = `speculative dispatch "${truncate(action.title, 80)}" dropped: ${liveSpeculative} speculative tickets already running (limit ${MAX_SPECULATIVE_TICKETS})`;
          decisions.push(decision);
          actionRecords.push(null);
          continue;
        }
        if (speculative) liveSpeculative += 1;
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
          ownsWorkspace: null,
          branchName: null,
          profile: choice.profile,
          provider: null,
          startedAt: null,
          attempts: 0,
          // 投机执行不订阅线程:闲聊与后续消息不打扰它,结果经汇报回流。
          subscribed: speculative ? false : !action.unsubscribe,
          follows: [],
          speculative,
          report: null,
          lastError: null,
          createdAt: decision.createdAt,
          updatedAt: decision.createdAt,
        };
        decision.ticketId = ticket.id;
        if (speculative) decision.rationale = [decision.rationale, "speculative background attempt"].filter(Boolean).join("; ");
        createdTickets.push(ticket);
        if (!summary && !speculative) summary = action.title;
      } else if (action.action === "reply") {
        decision.reply = action.reply;
        replies.push(action.reply);
        if (!summary) summary = action.reply;
      } else if (action.action === "steer") {
        decision.rationale = truncate(action.text, 300);
      } else if (action.action === "subscribe") {
        const target = state.tickets.find((t) => t.id === action.ticketId);
        if (!target || TERMINAL_TICKET_STATUSES.includes(target.status)) {
          decision.rationale = `ticket ${action.ticketId} ${target ? `is ${target.status}` : "not found"}; nothing subscribed`;
        } else {
          subscribeTickets.push(target.id);
          decision.rationale = target.threadId === threadId
            ? "re-subscribed to its own thread"
            : `now also follows this thread (home thread ${target.threadId})`;
        }
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
      status: "pending" as const, sentMessageIds: [], createdAt: decidedAt, updatedAt: decidedAt,
    } : null;

    // 成功裁决也留一份截断的原始回复,挂在批内首条决策上:格式/占位类问题事后可审计。
    decisions[0].raw = truncate(replyText, 1200);

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
      for (const ticketId of subscribeTickets) {
        const target = next.tickets.find((t) => t.id === ticketId);
        if (!target) continue;
        if (target.threadId === threadId) target.subscribed = true;
        else target.follows = [...new Set([...followsOf(target), threadId])];
        // 已完成待命的票据被重新订阅后回到待命(waiting),后续消息能唤醒它。
        if (target.status === "completed" && target.workerAgentId) target.status = "waiting";
        target.updatedAt = decidedAt;
      }
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
      // 以裁决结果为准:被丢弃的投机派发(记为 ignore)没有票据可启动。
      if (decisions[index]?.outcome === "dispatch") {
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
        let sentId: string | null = null;
        try {
          if (!this.replySink) throw new Error("IM reply channel is not available");
          sentId = (await this.replySink.send(delivery.origin, delivery.parts[delivery.nextPart])) || null;
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
          // 记下已发消息 id:用户引用这条答复回复时,能归回本线程并内联原文。
          if (sentId) target.sentMessageIds = [...(target.sentMessageIds ?? []), sentId];
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
      // 跨线程 steer:目标票据可能属于其他线程(裁决记录仍挂在本线程)。
      return this.applySteer(record.ticketId ?? "", record.text ?? "", record.mode ?? "steer");
    }
    if (record.kind === "cancel") {
      // 跨线程 cancel:目标票据不在(已清理)视为幂等成功。
      const ticket = this.store.get().tickets.find((t) => t.id === record.ticketId);
      if (!ticket) return { ok: true };
      // 终态票据的补回收已并入 cancelTicket,RPC 与动作重放两条路径行为一致。
      await this.cancelTicket(ticket.id);
      return { ok: true };
    }
    if (record.kind === "retry") {
      const ticket = this.store.get().tickets.find((t) => t.id === record.ticketId);
      if (!ticket) return { ok: true };
      if (["failed", "canceled", "completed"].includes(ticket.status)) {
        await this.retryTicket(ticket.id);
        return { ok: true };
      }
      // 已被重置过(上次执行中断):pending 票据由看门狗接手启动。
      return { ok: true };
    }
    // stop:快照所有仍持有 Worker 的票据(含终态遗留——线程结束即整段收口),落盘关闭
    // 线程,再逐一回收。重跑时对已归档 agent 的再次归档幂等无害,无需区分上次执行
    // 是否已把线程关闭。
    const state = this.store.get();
    const thread = state.threads.find((t) => t.id === record.threadId);
    if (!thread) return { ok: true };
    const retiring = state.tickets.filter((t) => t.threadId === record.threadId && t.workerAgentId);
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
      // 基础目录(档位专属目录优先)不可用时带着目录与隔离方式失败,Router 收到的汇报能指明确切原因。
      const { dir: workingDir, custom } = this.ticketWorkingDir(current.profile);
      const workingDirIssue = await this.inspectDir(workingDir);
      if (workingDirIssue) throw new Error(workingDirIssue);
      const env: WorkerLaunchEnv = {
        workingDir,
        isolation: this.settingsValues.workerIsolation,
        instructionFiles: await this.instructionFilesFor(workingDir),
        sharedWorkspace:
          this.settingsValues.workerIsolation === "shared"
            ? await this.sharedWorkspaceFor(workingDir, custom && current.profile ? current.profile : DEFAULT_WORKSPACE_TITLE)
            : null,
      };
      const launch = await launchWorker(
        paseo,
        workerProvider,
        current,
        state.kv.routerAgentId ?? null,
        env,
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
        target.ownsWorkspace = launch.ownsWorkspace;
        target.branchName = launch.branchName;
        target.status = "running";
        target.updatedAt = new Date().toISOString();
        accepted = true;
      });
      if (accepted) {
        this.watchTicket(ticketId);
      } else {
        await retireWorker(
          paseo,
          { ...current, workerAgentId: launch.agentId, workspaceId: launch.workspaceId, ownsWorkspace: launch.ownsWorkspace },
          true,
        );
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
        // 仍订阅任一线程(本线程或跟随的线程)的票据待命,后续消息可唤醒;投机执行不待命。
        const stillSubscribed = !target.speculative && (target.subscribed || followsOf(target).length > 0);
        target.status = stillSubscribed ? "waiting" : "completed";
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
      if (target.speculative) {
        await this.settleSpeculative(target, text, done);
        return;
      }
      // 汇报回流到票据订阅的每个线程(多对多):每段对话的 Router 裁决各自答复。
      for (const threadId of this.reportThreads(target)) await this.enqueueReport(threadId, target, text);
    }
  }

  /** 汇报的目标线程:本线程,加上仍处于活跃状态的跟随线程。 */
  private reportThreads(ticket: Ticket): string[] {
    const state = this.store.get();
    const follows = followsOf(ticket).filter((id) => state.threads.find((t) => t.id === id)?.state === "active");
    return [...new Set([ticket.threadId, ...follows])];
  }

  /**
   * 投机执行落定(§3.4):汇报首行 DISCARD(或运行失败)即静默丢弃——留一条已处理的
   * 汇报记录供审计,回收 Worker 与独占工作区,不进 Router、不打扰人;否则作为投机汇报交
   * Router 简短转述。
   */
  private async settleSpeculative(ticket: Ticket, text: string, done: boolean): Promise<void> {
    const discard = !done || /^\s*(?:\*\*)?DISCARD\b/i.test(text);
    if (!discard) {
      await this.enqueueReport(ticket.threadId, ticket, `(speculative background attempt — nobody asked; relay only if still useful)\n${text}`);
      return;
    }
    const now = new Date().toISOString();
    const thread = this.store.get().threads.find((t) => t.id === ticket.threadId);
    await this.store.update((next) => {
      next.triggers.push({
        id: newId("trg"),
        kind: "report",
        sender: `worker:${ticket.id}`,
        threadKey: thread?.key ?? `manual:${ticket.threadId}`,
        text: `Worker report for "${ticket.title}":\n${truncate(text, 2000)}`,
        context: false,
        replyToAgentId: null,
        origin: null,
        receivedAt: now,
        status: "evaluated",
        note: done ? "speculative attempt discarded" : "speculative attempt failed; discarded",
        threadId: ticket.threadId,
      });
    });
    await retireWorker(this.requirePaseo(), ticket, true);
  }

  // ------------------------------------------------------------ watchdog

  private async recover(): Promise<void> {
    await this.store.ready;
    await this.flushQueuedBeforeStart();
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

  /**
   * 引擎启动前已落盘的 IM 触发:按到达顺序补直通(线程有可用订阅时),其余留给评估。
   * 插件拿不到启动时的 Paseo 句柄(宿主限制),IM 先连上收消息,引擎在首个 hook/RPC 时启动。
   */
  private async flushQueuedBeforeStart(): Promise<void> {
    const queued = this.store.get().triggers
      .filter((t) => t.status === "pending" && t.note === QUEUED_BEFORE_START)
      .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
    for (const trigger of queued) {
      await this.store.update((next) => {
        const target = next.triggers.find((t) => t.id === trigger.id);
        if (target?.note === QUEUED_BEFORE_START) target.note = null;
      });
      if (trigger.context || !trigger.threadId) continue;
      const direct = this.subscribedTickets(this.store.get(), trigger.threadId).filter((ticket) => ticket.workerAgentId);
      if (direct.length > 0) await this.deliverDirect({ ...trigger, note: null }, direct);
    }
  }

  private async watchdogTick(): Promise<void> {
    if (!this.primed || !this.paseo) return;
    const note = await this.reconcile();
    this.lastWatchdogAt = new Date().toISOString();
    this.lastWatchdogNote = note;
    // LLM 巡检按自己的间隔走,不阻塞程序对账。
    void this.maybePatrol().catch((error) => {
      console.error("[superagent] watchdog patrol failed", error);
    });
  }

  // ------------------------------------------------------- LLM watchdog

  /** 到点(或 force)且设置开启时跑一次巡检;失败也记下时间,下个间隔再试,不在 15s 节奏里重试。 */
  async maybePatrol(force = false): Promise<void> {
    await this.store.ready;
    if (!this.settingsValues.watchdogEnabled || !this.paseo || this.patrolInFlight) return;
    const last = this.store.get().kv.watchdog?.lastRunAt;
    const due = !last || Date.now() - Date.parse(last) >= this.settingsValues.watchdogIntervalMin * 60_000;
    if (!force && !due) return;
    this.patrolInFlight = true;
    try {
      await this.runPatrol();
    } catch (error) {
      const message = truncate(error instanceof Error ? error.message : String(error), 400);
      await this.updateWatchdogState({ lastRunAt: new Date().toISOString(), lastError: message });
      throw error;
    } finally {
      this.patrolInFlight = false;
    }
  }

  private async updateWatchdogState(patch: Partial<WatchdogState>): Promise<void> {
    await this.store.update((next) => {
      const current = next.kv.watchdog ?? { lastActions: 0, seen: {} };
      next.kv.watchdog = { ...current, ...patch, seen: patch.seen ?? current.seen ?? {} };
    });
  }

  private async runPatrol(): Promise<void> {
    const paseo = this.requirePaseo();
    const now = new Date();
    const { digest, seen } = await this.collectPatrolDigest(now);
    if (digest.tickets.length === 0 && digest.health.length === 0) {
      // 无事可巡:不调用模型。
      await this.updateWatchdogState({ lastRunAt: now.toISOString(), lastSummary: "nothing to patrol", lastError: null, lastActions: 0, seen });
      return;
    }
    const configured = this.settingsValues.watchdogProvider.trim();
    const provider = configured
      ? await this.validateConfiguredProvider("watchdog", configured)
      : await this.resolveProvider("router", this.store.get().kv.routerProvider);
    if (!provider) throw new Error("no available provider for the watchdog");
    const instructions = composeWatchdogInstructions();
    const configHash = createHash("sha256").update(instructions).digest("hex");
    const state = this.store.get();
    const remembered = state.kv.watchdog;
    const watchdog = await ensureWatchdog(
      paseo,
      state,
      provider,
      () => this.sharedWorkspaceFor(this.settingsValues.workingDir, DEFAULT_WORKSPACE_TITLE),
      instructions,
    );
    if (!watchdog.created) {
      // 维护者正在和看门狗对话:这次巡检让路,下个间隔再来。
      const live = (await watchdog.handle.refresh().catch(() => null))?.agent;
      if (live?.status === "running") {
        await this.updateWatchdogState({ agentId: watchdog.agentId, provider, lastRunAt: now.toISOString(),
          lastSummary: "skipped: the watchdog session is busy (a maintainer may be talking to it)" });
        return;
      }
    }
    const includeRules = watchdog.created
      ? !routerUsesSystemPrompt(provider)
      : remembered?.agentId !== watchdog.agentId || remembered?.configHash !== configHash
        || Boolean(remembered?.lastError?.startsWith("unparsed"));
    const result = await watchdog.handle.run(composePatrolPrompt(digest, includeRules ? instructions : null), {
      timeoutMs: WATCHDOG_RUN_TIMEOUT_MS,
    });
    const replyText = result.lastMessage?.trim() || (await readLastAssistantMessage(paseo, watchdog.agentId)) || "";
    const parsed = parseWatchdogVerdict(replyText);
    if ("error" in parsed) {
      await this.updateWatchdogState({ agentId: watchdog.agentId, provider, configHash, lastRunAt: now.toISOString(),
        lastError: `unparsed: ${truncate(parsed.error, 300)}` });
      return;
    }
    const executed = await this.executeWatchdogActions(parsed.verdict.actions);
    await this.updateWatchdogState({
      agentId: watchdog.agentId, provider, configHash, lastRunAt: now.toISOString(),
      lastSummary: truncate(parsed.verdict.summary, 300), lastError: null, lastActions: executed, seen,
    });
  }

  /** 巡检摘要:未完结票据的会话状态与进展增量,加引擎健康状况。 */
  private async collectPatrolDigest(now: Date): Promise<{ digest: PatrolDigest; seen: WatchdogState["seen"] }> {
    const paseo = this.requirePaseo();
    const state = this.store.get();
    const previous = state.kv.watchdog?.seen ?? {};
    const seen: WatchdogState["seen"] = {};
    const minutes = (from: number) => Math.max(0, Math.round((now.getTime() - from) / 60_000));
    const unfinished = state.tickets
      .filter((t) => !TERMINAL_TICKET_STATUSES.includes(t.status))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, 12);
    const tickets: PatrolTicket[] = [];
    for (const ticket of unfinished) {
      let sessionStatus: string | null = null;
      let pendingPermissions = 0;
      let latestSeq: number | null = null;
      let latestAt: number | null = null;
      let latestMessage: string | null = null;
      if (ticket.workerAgentId) {
        try {
          const ref = paseo.agents.ref(ticket.workerAgentId);
          const snapshot = await ref.refresh();
          sessionStatus = snapshot?.agent.status ?? null;
          pendingPermissions = snapshot?.agent.pendingPermissions?.length ?? 0;
          const timeline = await ref.timeline.refetch({ direction: "tail", limit: 30 });
          for (const entry of timeline.entries) {
            const seq = (entry as { seqEnd?: number }).seqEnd ?? entry.seqStart;
            if (latestSeq === null || seq > latestSeq) latestSeq = seq;
            const at = Date.parse((entry as { timestamp?: string }).timestamp ?? "");
            if (Number.isFinite(at) && (latestAt === null || at > latestAt)) latestAt = at;
          }
          const assistant = timeline.entries
            .filter((entry) => entry.item.type === "assistant_message")
            .sort((a, b) => b.seqStart - a.seqStart)[0];
          if (assistant?.item.type === "assistant_message") latestMessage = assistant.item.text?.trim() || null;
        } catch (error) {
          console.error("[superagent] watchdog could not read worker", ticket.workerAgentId, error);
        }
      }
      const before = previous[ticket.id];
      if (latestSeq !== null) {
        const changed = !before || before.seq !== latestSeq;
        seen[ticket.id] = { seq: latestSeq, at: changed ? new Date(latestAt ?? now.getTime()).toISOString() : before.at };
      }
      const thread = state.threads.find((t) => t.id === ticket.threadId);
      tickets.push({
        id: ticket.id,
        title: ticket.title,
        threadId: ticket.threadId,
        threadTitle: thread?.title ?? null,
        status: ticket.status,
        attempts: ticket.attempts,
        profile: ticket.profile ?? null,
        provider: ticket.provider ?? null,
        speculative: Boolean(ticket.speculative),
        runningMin: ticket.startedAt ? minutes(Date.parse(ticket.startedAt)) : null,
        lastError: ticket.lastError ?? null,
        mandate: ticket.mandate,
        sessionStatus,
        pendingPermissions,
        newEntries: before && latestSeq !== null ? Math.max(0, latestSeq - before.seq) : null,
        quietMin: latestAt !== null ? minutes(latestAt) : seen[ticket.id] ? minutes(Date.parse(seen[ticket.id].at)) : null,
        latestMessage,
      });
    }
    return {
      digest: { at: now.toISOString(), intervalMin: this.settingsValues.watchdogIntervalMin, tickets, health: this.healthLines(state, now) },
      seen,
    };
  }

  /** 引擎健康的单行说明:评估熔断/连续出错、久候的触发、投递失败、积压动作、近期失败票据、Router 丢失。 */
  private healthLines(state: SuperagentState, now: Date): string[] {
    const lines: string[] = [];
    const ago = (iso: string) => Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60_000));
    const label = (threadId: string) => {
      const thread = state.threads.find((t) => t.id === threadId);
      return thread ? `thread ${thread.id} "${truncate(thread.title, 60)}"` : `thread ${threadId}`;
    };
    for (const thread of state.threads.filter((t) => t.state === "active")) {
      const pending = state.triggers.filter((t) => t.threadId === thread.id && t.status === "pending");
      const unparsed = this.evalFailures.get(thread.id) ?? 0;
      const errors = this.evalErrors.get(thread.id) ?? 0;
      if (unparsed >= 3) lines.push(`${label(thread.id)}: Router output unparsed ${unparsed} times in a row; automatic re-evaluation is paused (reeval resets it)`);
      if (errors >= 3) {
        const last = state.decisions.filter((d) => d.threadId === thread.id && d.outcome === "error").at(-1);
        lines.push(`${label(thread.id)}: ${errors} Router evaluation errors in a row${last?.rationale ? `; last: ${truncate(last.rationale, 200)}` : ""}`);
      }
      const oldest = pending.map((t) => t.receivedAt).sort()[0];
      if (oldest && ago(oldest) >= 10 && unparsed < 3 && errors < 3) {
        lines.push(`${label(thread.id)}: ${pending.length} trigger(s) waiting for the Router for ${ago(oldest)} min`);
      }
    }
    for (const delivery of state.imDeliveries.filter((d) => d.status === "failed")) {
      lines.push(`IM reply ${delivery.id} (${delivery.origin.channel}) failed at part ${delivery.nextPart + 1}/${delivery.parts.length} on ${label(delivery.threadId)}`);
    }
    if (state.pendingActions.length > 0) {
      lines.push(`${state.pendingActions.length} Router action(s) still waiting to execute (max attempts ${MAX_ACTION_ATTEMPTS})`);
    }
    const window = 2 * this.settingsValues.watchdogIntervalMin;
    for (const ticket of state.tickets.filter((t) => t.status === "failed" && ago(t.updatedAt) <= window)) {
      lines.push(`ticket ${ticket.id} "${truncate(ticket.title, 60)}" failed ${ago(ticket.updatedAt)} min ago: ${truncate(ticket.lastError ?? "unknown error", 200)}`);
    }
    if (!state.kv.routerAgentId && state.threads.some((t) => t.state === "active")) {
      lines.push("no live Router agent; it is recreated on the next evaluation");
    }
    return lines;
  }

  /** 执行看门狗动作:每个动作一条 watchdog 裁决留痕;取消/上报经引擎触发交 Router 告知人。 */
  private async executeWatchdogActions(actions: WatchdogAction[]): Promise<number> {
    let executed = 0;
    for (const action of actions) {
      const state = this.store.get();
      const ticket = "ticketId" in action && action.ticketId ? state.tickets.find((t) => t.id === action.ticketId) : undefined;
      const threadId = ("threadId" in action && action.threadId) || ticket?.threadId || null;
      if (!threadId || !state.threads.some((t) => t.id === threadId)) {
        console.warn(`[superagent] watchdog ${action.action} skipped: unknown target`);
        continue;
      }
      let note: string;
      try {
        if (action.action === "nudge" || action.action === "interrupt") {
          if (!ticket) continue;
          const outcome = await this.applySteer(ticket.id, `[watchdog] ${action.text}`, action.action === "interrupt" ? "interrupt" : "steer");
          if (!outcome.ok) throw new Error(outcome.error);
          note = `${action.action}: ${action.text}`;
        } else if (action.action === "cancel") {
          if (!ticket) continue;
          await this.cancelTicket(ticket.id);
          note = `cancel: ${action.reason}`;
          await this.enqueueEngineNote(threadId, `[watchdog] canceled ticket ${ticket.id} "${ticket.title}": ${action.reason}`);
        } else if (action.action === "retry") {
          if (!ticket) continue;
          await this.retryTicket(ticket.id);
          note = `retry${action.reason ? `: ${action.reason}` : ""}`;
        } else if (action.action === "reeval") {
          await this.forceEval(threadId);
          note = `reeval${action.reason ? `: ${action.reason}` : ""}`;
        } else {
          note = `escalate: ${action.text}`;
          await this.enqueueEngineNote(threadId, `[watchdog]${ticket ? ` ticket ${ticket.id} "${ticket.title}":` : ""} ${action.text}`);
        }
      } catch (error) {
        note = `${action.action} failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      executed += 1;
      await this.store.update((next) => {
        next.decisions.push(newDecision(threadId, [], "watchdog", { ticketId: ticket?.id ?? null, rationale: truncate(note, 500) }));
      });
    }
    return executed;
  }

  /** 引擎以触发形式把看门狗的结论交给线程的 Router,由 Router 统一对人表述。 */
  private async enqueueEngineNote(threadId: string, text: string): Promise<void> {
    const thread = this.store.get().threads.find((t) => t.id === threadId);
    if (!thread) return;
    const originTrigger = this.store.get().triggers
      .filter((t) => t.threadId === threadId && ["evaluated", "delivered"].includes(t.status))
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
      .find((t) => t.replyToAgentId || t.origin);
    await this.store.update((next) => {
      next.triggers.push({
        id: newId("trg"),
        kind: "engine",
        sender: "watchdog",
        threadKey: thread.key,
        text: truncate(text, 2000),
        context: false,
        replyToAgentId: originTrigger?.replyToAgentId ?? null,
        origin: originTrigger?.origin ?? null,
        receivedAt: new Date().toISOString(),
        status: "pending",
        note: null,
        threadId,
      });
    });
    if (thread.state === "active") this.scheduleEval(threadId);
  }

  /**
   * 编排自身 agent 的角色(权限钩子用):Router / 看门狗 / Worker;其他 agent 为 null。
   * 只认引擎记得的 id,不额外查询普通 agent。
   */
  orchestrationRole(agentId: string): "router" | "watchdog" | "worker" | null {
    const state = this.store.get();
    if (state.kv.routerAgentId === agentId) return "router";
    if (state.kv.watchdog?.agentId === agentId) return "watchdog";
    if (state.tickets.some((ticket) => ticket.workerAgentId === agentId)) return "worker";
    return null;
  }

  /** 对账:错过完成 / 卡死启动 / 超时中断 / 评估重排(unparsed ≥3 熔断;瞬时异常按上限重查)。 */
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
      // unparsed 3 次熔断(模型输出问题,人工重试);瞬时异常给足重查窗口(≈5 分钟)。
      if ((this.evalFailures.get(threadId) ?? 0) >= 3) continue;
      if ((this.evalErrors.get(threadId) ?? 0) >= MAX_EVAL_ERRORS) continue;
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
    this.evalErrors.delete(threadId);
    this.actionFailures.delete(threadId);
    this.scheduleEval(threadId, 0);
  }

  async cancelTicket(ticketId: string): Promise<void> {
    const paseo = this.requirePaseo();
    const state = this.store.get();
    const ticket = state.tickets.find((t) => t.id === ticketId);
    if (!ticket) throw new Error("ticket not found");
    // 终态票据不改写状态(completed/failed 的语义保留,汇报与错误原因不丢),补回收
    // 遗留的 Worker 与工作区即可;也因此 settle 与 cancel 竞态时终态不会被覆盖。
    if (["completed", "failed", "canceled"].includes(ticket.status)) {
      if (ticket.workerAgentId) await retireWorker(paseo, ticket, true);
      return;
    }
    await this.store.update((next) => {
      const target = next.tickets.find((t) => t.id === ticketId);
      if (!target) return;
      target.status = "canceled";
      target.subscribed = false;
      target.updatedAt = new Date().toISOString();
    });
    await retireWorker(paseo, ticket, true);
  }

  async retryTicket(ticketId: string): Promise<void> {
    const paseo = this.requirePaseo();
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
    // 旧 Worker 与其独占工作区随重试作废:先落盘重置再回收,旧实例不会被新票据引用。
    if (ticket.workerAgentId) await retireWorker(paseo, ticket, true);
    await this.startTicket(ticketId);
  }

  async closeThread(threadId: string): Promise<void> {
    const paseo = this.requirePaseo();
    const state = this.store.get();
    // 关闭线程即整段收口:所有仍持有 Worker 的票据(含终态遗留)一并回收。
    const retiring = state.tickets.filter((t) => t.threadId === threadId && t.workerAgentId);
    await this.markThreadClosed(threadId);
    for (const ticket of retiring) await retireWorker(paseo, ticket, true);
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
        } else if (ticket.threadId !== threadId && followsOf(ticket).includes(threadId)) {
          // 其他线程的票据只是跟随本线程:解除跟随,票据本身不受影响。
          ticket.follows = followsOf(ticket).filter((id) => id !== threadId);
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

  /** 界面退订:本线程票据取消 subscribed;跟随本线程的其他线程票据从 follows 里移除。 */
  async unsubscribe(threadId: string, ticketId: string): Promise<void> {
    await this.store.update((next) => {
      const ticket = next.tickets.find((t) => t.id === ticketId);
      if (!ticket) return;
      if (ticket.threadId === threadId) ticket.subscribed = false;
      else if (followsOf(ticket).includes(threadId)) ticket.follows = followsOf(ticket).filter((id) => id !== threadId);
      else return;
      ticket.updatedAt = new Date().toISOString();
      if (ticket.status === "waiting" && !ticket.subscribed && followsOf(ticket).length === 0) ticket.status = "completed";
    });
  }

  // ------------------------------------------------- recall & worker tools

  /** 回读记录时各字段的长度上限:全文远超提示词预算,但仍要防无界输出。 */
  private static readonly RECALL_REPORT_CHARS = 20_000;
  /** 关键词检索的命中上限与摘录宽度: newest first,防撑爆 Router 上下文。 */
  private static readonly SEARCH_HITS_LIMIT = 20;
  private static readonly SEARCH_EXCERPT_CHARS = 160;

  /**
   * Router 回读(Chain of Recall):按 ID 找回完整未截断记录。触发/票据/线程/裁决
   * 四类;已清理(超上限裁剪或线程关闭收口)返回 null,由工具层转为可读错误。
   */
  async readRecord(id: string): Promise<string | null> {
    await this.store.ready;
    const state = this.store.get();
    const trimmed = id.trim();
    const threadLabel = (threadId: string | null | undefined) => {
      if (!threadId) return "(no thread)";
      const thread = state.threads.find((t) => t.id === threadId);
      return thread ? `thread ${thread.id} "${thread.title}" (${thread.state})` : `thread ${threadId} (pruned)`;
    };
    if (trimmed.startsWith("trg_")) {
      const trigger = state.triggers.find((t) => t.id === trimmed);
      if (!trigger) return null;
      return [
        `# trigger ${trigger.id}`,
        `thread: ${threadLabel(trigger.threadId)}`,
        `kind: ${trigger.kind}  status: ${trigger.status}  sender: ${trigger.sender}`,
        `receivedAt: ${trigger.receivedAt}${trigger.context ? "  (context-only)" : ""}`,
        trigger.note ? `note: ${trigger.note}` : null,
        trigger.quote
          ? `quoting: ${trigger.quote.triggerId ?? (trigger.quote.text ? "an earlier Router reply" : `platform message ${trigger.quote.messageId ?? "?"}`)}${trigger.quote.text ? ` — "${truncate(trigger.quote.text, 300)}"` : ""}`
          : null,
        "",
        trigger.text,
      ]
        .filter((line) => line !== null)
        .join("\n");
    }
    if (trimmed.startsWith("tkt_")) {
      const ticket = state.tickets.find((t) => t.id === trimmed);
      if (!ticket) return null;
      return [
        `# ticket ${ticket.id}`,
        `title: ${ticket.title}`,
        `thread: ${threadLabel(ticket.threadId)}`,
        `status: ${ticket.status}  subscribed: ${ticket.subscribed}  attempts: ${ticket.attempts}${ticket.speculative ? "  speculative" : ""}`,
        ...followsOf(ticket).map((threadId) => `also follows: ${threadLabel(threadId)}`),
        `profile: ${ticket.profile ?? "(default)"}  provider: ${ticket.provider ?? "(unresolved)"}`,
        ticket.branchName ? `branch: ${ticket.branchName}` : null,
        `workerAgent: ${ticket.workerAgentId ?? "(none)"}`,
        ticket.startedAt ? `startedAt: ${ticket.startedAt}` : null,
        ticket.lastError ? `lastError: ${ticket.lastError}` : null,
        "",
        "## mandate",
        ticket.mandate,
        ticket.report
          ? `\n## report (final worker message)\n${truncate(ticket.report, SuperagentEngine.RECALL_REPORT_CHARS)}`
          : null,
        await this.recentWorkerMessages(ticket),
      ]
        .filter((line) => line !== null)
        .join("\n");
    }
    if (trimmed.startsWith("thr_")) {
      const thread = state.threads.find((t) => t.id === trimmed);
      if (!thread) return null;
      const tickets = state.tickets.filter((t) => t.threadId === thread.id);
      return [
        `# thread ${thread.id}`,
        `title: ${thread.title}`,
        `state: ${thread.state}  createdAt: ${thread.createdAt}  updatedAt: ${thread.updatedAt}`,
        thread.summary ? `summary: ${thread.summary}` : null,
        thread.latestResult
          ? `latestResult (${thread.latestResult.kind}, ${thread.latestResult.createdAt}):\n${truncate(thread.latestResult.text, 8000)}`
          : null,
        "",
        `## tickets (${tickets.length})`,
        ...tickets.map((ticket) =>
          `- [${ticket.id}] "${ticket.title}" status=${ticket.status} subscribed=${ticket.subscribed}${ticket.speculative ? " speculative" : ""}`,
        ),
        ...this.threadLinks(state, thread.id),
      ]
        .filter((line) => line !== null)
        .join("\n");
    }
    if (trimmed.startsWith("dec_")) {
      const decision = state.decisions.find((d) => d.id === trimmed);
      if (!decision) return null;
      return [
        `# decision ${decision.id}`,
        `thread: ${threadLabel(decision.threadId)}`,
        `outcome: ${decision.outcome}  createdAt: ${decision.createdAt}`,
        decision.ticketId ? `ticketId: ${decision.ticketId}` : null,
        decision.reply ? `reply: ${decision.reply}` : null,
        decision.rationale ? `rationale: ${decision.rationale}` : null,
        decision.raw ? `raw (truncated router reply):\n${decision.raw}` : null,
        `triggerIds: ${decision.triggerIds.join(", ") || "(none)"}`,
      ]
        .filter((line) => line !== null)
        .join("\n");
    }
    return null;
  }

  /**
   * 线程回读的下一跳(§3.3 链式召回):跟随本线程的其他线程票据、最近的消息与裁决 ID,
   * 每条都可再用 superagent_read 展开。
   */
  private threadLinks(state: SuperagentState, threadId: string): string[] {
    const lines: string[] = [];
    const followers = state.tickets.filter((t) => t.threadId !== threadId && followsOf(t).includes(threadId));
    if (followers.length) {
      lines.push("", `## tickets of other threads following this one (${followers.length})`);
      for (const ticket of followers) lines.push(`- [${ticket.id}] "${ticket.title}" status=${ticket.status} home-thread=${ticket.threadId}`);
    }
    const triggers = state.triggers.filter((t) => t.threadId === threadId)
      .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
    if (triggers.length) {
      lines.push("", `## recent messages (${Math.min(10, triggers.length)} of ${triggers.length}, oldest first)`);
      for (const trigger of triggers.slice(-10)) {
        lines.push(`- [${trigger.id} ${trigger.kind} ${trigger.status}] ${trigger.sender}: ${truncate(trigger.text.replace(/\s+/g, " "), 100)}`);
      }
    }
    const decisions = state.decisions.filter((d) => d.threadId === threadId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (decisions.length) {
      lines.push("", `## recent router decisions (${Math.min(5, decisions.length)} of ${decisions.length})`);
      for (const decision of decisions.slice(-5)) {
        const detail = decision.reply ?? decision.rationale;
        lines.push(`- [${decision.id} ${decision.outcome}]${decision.ticketId ? ` ${decision.ticketId}` : ""}${detail ? ` ${truncate(detail.replace(/\s+/g, " "), 100)}` : ""}`);
      }
    }
    return lines;
  }

  /** 票据回读的 Worker 会话尾部(最近几条 assistant 消息):汇报之外的进展,读不到时省略。 */
  private async recentWorkerMessages(ticket: Ticket): Promise<string | null> {
    if (!ticket.workerAgentId || !this.paseo) return null;
    try {
      const payload = await this.paseo.agents.ref(ticket.workerAgentId).timeline.refetch({ direction: "tail", limit: 40 });
      const messages = payload.entries
        .filter((entry) => entry.item.type === "assistant_message")
        .sort((a, b) => a.seqStart - b.seqStart)
        .map((entry) => (entry.item.type === "assistant_message" ? entry.item.text?.trim() ?? "" : ""))
        .filter(Boolean)
        .slice(-3);
      if (messages.length === 0) return null;
      return ["", "## recent worker messages (session tail, oldest first)", ...messages.map((text) => `- ${truncate(text.replace(/\s+/g, " "), 600)}`)].join("\n");
    } catch {
      return null;
    }
  }

  /**
   * Router 关键词检索:在全部触发/票据(含 mandate 与 worker 报告)/线程标题与摘要/
   * 裁决答复与理由里找「空格分词后全部命中」的记录,返回 ID + 短摘录,newest first。
   * 不知道 ID 时的回读入口;命中摘录取自外部输入,不可信框架由工具层附加。
   */
  async searchRecords(query: string): Promise<string> {
    await this.store.ready;
    const state = this.store.get();
    const terms = [...new Set(query.toLowerCase().split(/\s+/).filter((term) => term.length > 0))];
    if (terms.length === 0) {
      return "No usable keywords — pass one or more words that must appear in the record.";
    }
    const joined = (...fields: (string | null | undefined)[]) => fields.filter((f) => typeof f === "string" && f.length > 0).join("\n").toLowerCase();
    const matches = (text: string) => terms.every((term) => text.includes(term));
    /** 摘录取最早命中关键词所在的字段;窗口前留省略号,宽度与提示词存根一致。 */
    const excerptOf = (...fields: (string | null | undefined)[]): string => {
      const present = fields.filter((f): f is string => typeof f === "string" && f.length > 0);
      let source = present[0] ?? "";
      let earliest = -1;
      for (const field of present) {
        const lower = field.toLowerCase();
        for (const term of terms) {
          const at = lower.indexOf(term);
          if (at >= 0 && (earliest === -1 || at < earliest)) {
            earliest = at;
            source = field;
          }
        }
      }
      const start = earliest > 0 ? Math.max(0, earliest - 60) : 0;
      return truncate((start > 0 ? "…" : "") + source.slice(start), SuperagentEngine.SEARCH_EXCERPT_CHARS);
    };
    interface Hit { at: string; line: string; }
    const hits: Hit[] = [];
    for (const trigger of state.triggers) {
      if (!matches(joined(trigger.text, trigger.note))) continue;
      hits.push({
        at: trigger.receivedAt,
        line: `- [${trigger.id} trigger ${trigger.kind} ${trigger.status}] ${trigger.sender}: ${excerptOf(trigger.text, trigger.note)}`,
      });
    }
    for (const ticket of state.tickets) {
      if (!matches(joined(ticket.title, ticket.mandate, ticket.report, ticket.lastError))) continue;
      hits.push({
        at: ticket.updatedAt,
        line: `- [${ticket.id} ticket ${ticket.status}] "${ticket.title}": ${excerptOf(ticket.report, ticket.mandate, ticket.lastError, ticket.title)}`,
      });
    }
    for (const thread of state.threads) {
      if (!matches(joined(thread.title, thread.summary))) continue;
      hits.push({
        at: thread.updatedAt,
        line: `- [${thread.id} thread ${thread.state}] "${thread.title}": ${excerptOf(thread.summary, thread.title)}`,
      });
    }
    for (const decision of state.decisions) {
      if (!matches(joined(decision.reply, decision.rationale))) continue;
      hits.push({
        at: decision.createdAt,
        line: `- [${decision.id} decision ${decision.outcome}] ${excerptOf(decision.reply, decision.rationale)}`,
      });
    }
    hits.sort((a, b) => b.at.localeCompare(a.at));
    if (hits.length === 0) {
      return `No records match all of: ${terms.join(" ")}. Try fewer or different keywords.`;
    }
    const shown = hits.slice(0, SuperagentEngine.SEARCH_HITS_LIMIT);
    return [
      `# Search results for [${terms.join(" ")}] — ${hits.length} match(es), newest first (up to ${SuperagentEngine.SEARCH_HITS_LIMIT} shown)`,
      ...shown.map((hit) => hit.line),
      "",
      "Read any record in full with superagent_read <id>.",
    ].join("\n");
  }

  /**
   * Router 跨线程总览:活跃线程及其未完结票据存根(全部线程,不止当前评估线程)。
   * 上限(10 线程 × 每线程 8 票)截断时如实标注,剩余的交给关键词检索。
   */
  async listThreads(): Promise<string> {
    await this.store.ready;
    const state = this.store.get();
    const activeSorted = state.threads
      .filter((t) => t.state === "active")
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const active = activeSorted.slice(0, 10);
    if (active.length === 0) return "No active threads.";
    const lines = ["# Active threads (newest first, up to 10)"];
    for (const thread of active) {
      const pending = state.triggers.filter((t) => t.threadId === thread.id && t.status === "pending").length;
      lines.push(`- thread ${thread.id} "${thread.title}"${pending > 0 ? ` pendingTriggers=${pending}` : ""}`);
      if (thread.summary) lines.push(`  summary: ${truncate(thread.summary, 200)}`);
      const unfinished = state.tickets
        .filter((t) => t.threadId === thread.id && !TERMINAL_TICKET_STATUSES.includes(t.status));
      for (const ticket of unfinished.slice(0, 8)) {
        lines.push(`  - [${ticket.id}] "${ticket.title}" status=${ticket.status} subscribed=${ticket.subscribed}`);
      }
      if (unfinished.length > 8) lines.push(`  (+${unfinished.length - 8} more unfinished tickets not shown)`);
    }
    if (activeSorted.length > active.length) {
      lines.push(`(${activeSorted.length - active.length} more active threads not shown — find them by a topic keyword with superagent_search)`);
    }
    lines.push("", "Find records by keyword with superagent_search; recall any record in full with superagent_read <id>.");
    return lines.join("\n");
  }

  /**
   * Worker 退订(工具入口):按票据定位(与注入 URL 一致,不经 agent id,无竞态)。
   * 语义与 UI 的退订 RPC 相同:waiting 票据随之完结,Worker 本身不回收。
   */
  async workerUnsubscribe(ticketId: string, threadId?: string): Promise<ToolOutcome> {
    await this.store.ready;
    const ticket = this.store.get().tickets.find((t) => t.id === ticketId);
    if (!ticket) return { ok: false, error: `ticket ${ticketId} does not exist` };
    if (!SUBSCRIBED_STATUSES.includes(ticket.status)) {
      return { ok: false, error: `ticket ${ticketId} is ${ticket.status}; only running/waiting workers can unsubscribe` };
    }
    const target = threadId?.trim() || null;
    if (target && target !== ticket.threadId && !followsOf(ticket).includes(target)) {
      return { ok: false, error: `ticket ${ticketId} does not follow thread ${target}` };
    }
    const leavingHome = !target || target === ticket.threadId;
    if (leavingHome && !ticket.subscribed && (target || followsOf(ticket).length === 0)) {
      return { ok: true, note: "already unsubscribed; future thread events go to the Router" };
    }
    let completed = false;
    await this.store.update((next) => {
      const current = next.tickets.find((t) => t.id === ticketId);
      if (!current) return;
      if (!target) {
        current.subscribed = false;
        current.follows = [];
      } else if (target === current.threadId) {
        current.subscribed = false;
      } else {
        current.follows = followsOf(current).filter((id) => id !== target);
      }
      current.updatedAt = new Date().toISOString();
      if (current.status === "waiting" && !current.subscribed && followsOf(current).length === 0) {
        current.status = "completed";
        completed = true;
      }
    });
    const scope = target ? ` from thread ${target}` : "";
    return completed
      ? { ok: true, note: `unsubscribed${scope}; the ticket is completed. Future thread events go to the Router.` }
      : { ok: true, note: `unsubscribed${scope}; future thread events go to the Router instead of your session.` };
  }

  /**
   * Worker 转回(工具入口):直通投递的消息不该由该 Worker 处理时,由它退回 Router
   * 重新路由。文本以 [handback] 前缀立案成待评估触发;继承线程最近的 IM/agent 回投
   * 目标,Router 的答复仍能送回原聊天。退订失败不阻断转回。
   */
  async workerHandback(ticketId: string, text: string, options: { unsubscribe?: boolean } = {}): Promise<ToolOutcome> {
    await this.store.ready;
    const message = text.trim();
    if (!message) return { ok: false, error: "handback text is empty" };
    const state = this.store.get();
    const ticket = state.tickets.find((t) => t.id === ticketId);
    if (!ticket) return { ok: false, error: `ticket ${ticketId} does not exist` };
    const thread = state.threads.find((t) => t.id === ticket.threadId);
    if (!thread || thread.state === "closed") {
      return { ok: false, error: "the thread of this ticket is closed; state the outcome in your final report instead" };
    }
    if (options.unsubscribe && ticket.subscribed) {
      await this.workerUnsubscribe(ticketId).catch((error) => {
        console.error("[superagent] handback unsubscribe failed", error);
      });
    }
    // 回投目标继承:与 Worker 汇报回流同一规则——找线程上最近带 origin/replyTo 的已评估触发。
    const originTrigger = state.triggers
      .filter((t) => t.threadId === thread.id && ["evaluated", "delivered"].includes(t.status))
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
      .find((t) => t.replyToAgentId || t.origin);
    const now = new Date().toISOString();
    await this.store.update((next) => {
      next.triggers.push({
        id: newId("trg"),
        kind: "engine",
        sender: `worker:${ticketId}`,
        threadKey: thread.key,
        text: `[handback] ${message}`.slice(0, this.settingsValues.triggerMaxChars),
        context: false,
        replyToAgentId: originTrigger?.replyToAgentId ?? null,
        origin: originTrigger?.origin ?? null,
        receivedAt: now,
        status: "pending",
        note: null,
        threadId: thread.id,
      });
      const target = next.threads.find((t) => t.id === thread.id);
      if (target) target.updatedAt = now;
    });
    this.scheduleEval(thread.id, 0);
    return { ok: true, note: "handed back to the Router for re-routing; continue with your own ticket." };
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
      workerProfiles: settings.workerProfiles.map(({ name, provider, description, workingDir }) => ({
        name, provider, description, workingDir: workingDir ?? "",
      })),
      threads,
      recentResults: recentResults(state, options.threadId),
      // 跟随(多对多订阅)某线程的其他线程票据也随该线程下发,对话页能看到并退订。
      tickets: state.tickets
        .filter((t) => threads.some((th) => th.id === t.threadId || followsOf(t).includes(th.id)))
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
        patrol: {
          enabled: settings.watchdogEnabled,
          agentId: state.kv.watchdog?.agentId ?? null,
          lastRunAt: state.kv.watchdog?.lastRunAt ?? null,
          lastSummary: state.kv.watchdog?.lastSummary ?? null,
          lastError: state.kv.watchdog?.lastError ?? null,
          running: this.patrolInFlight,
        },
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

  /** shared 隔离时基础目录自带的项目说明文件;worktree 隔离时仓库内的说明随 worktree 一起检出,无需提示。 */
  private async instructionFilesFor(dir: string): Promise<string[]> {
    if (this.settingsValues.workerIsolation !== "shared") return [];
    return findInstructionFiles(dir, this.workingDirProbe).catch(() => []);
  }

  /** Ticket 的基础目录:档位配置了专属目录且不同于全局目录时用它,否则用全局 workingDir。 */
  private ticketWorkingDir(profileName: string | null | undefined): { dir: string; custom: boolean } {
    const profile = profileName
      ? this.settingsValues.workerProfiles.find((candidate) => candidate.name === profileName)
      : undefined;
    const customDir = profile?.workingDir?.trim();
    const defaultDir = this.settingsValues.workingDir.trim();
    if (customDir && resolve(customDir) !== resolve(defaultDir)) return { dir: customDir, custom: true };
    return { dir: defaultDir, custom: false };
  }

  /** 基础目录可用性:全局目录走缓存(快照同读),档位专属目录每次直接检查。 */
  private async inspectDir(dir: string): Promise<string | null> {
    if (resolve(dir) === resolve(this.settingsValues.workingDir)) return this.refreshWorkingDirIssue();
    return inspectWorkingDir(dir, this.settingsValues.workerIsolation, this.workingDirProbe).catch((error) => {
      console.error("[superagent] working directory check failed", error);
      return null;
    });
  }

  /**
   * 共享隔离的持久工作区:全局目录命名「默认 workspace」,档位专属目录以档位名命名;
   * kv 登记(目录 → id)+ 内存缓存;句柄失效(被归档/目录不符)时按标题找回或重建。
   * 串行链防止并发启动的 Ticket 为同一目录重复建区。
   */
  private sharedWorkspaceFor(dir: string, title: string): Promise<PaseoWorkspaceHandle> {
    const key = resolve(dir);
    const ensure = this.workspaceChain.then(async () => {
      const cached = this.sharedWorkspaceCache.get(key);
      if (cached) {
        const descriptor = await cached.refresh().catch(() => null);
        if (descriptor && !descriptor.archivingAt) return cached;
        this.sharedWorkspaceCache.delete(key);
      }
      const remembered = this.store.get().kv.sharedWorkspaces?.[key];
      const { handle } = await ensureSharedWorkspace(this.requirePaseo(), remembered, dir, title);
      this.sharedWorkspaceCache.set(key, handle);
      if (remembered !== handle.id) {
        await this.store.update((next) => {
          next.kv.sharedWorkspaces = { ...next.kv.sharedWorkspaces, [key]: handle.id };
        });
      }
      return handle;
    });
    this.workspaceChain = ensure.catch((error) => {
      console.error("[superagent] shared workspace ensure failed", error);
    });
    return ensure;
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
