import type { PaseoApi, PaseoWorkspaceHandle } from "@getpaseo/client";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { dailyImThreadKey, imConversationKey, imDay } from "../shared/im-threads";
import { runInference, type InferenceConfig, type Recall } from "./inference";
import { Deadline, DeadlineError, bounded } from "./deadline";
import type { RpcInput } from "@getpaseo/plugin";
import type { PluginSettings } from "@getpaseo/plugin/server";
import type { superagentRespondToPermissionRpc } from "../shared/rpc";
import type { SuperagentStore } from "./store";
import { followsOf, subscribesTo } from "../shared/execution";
import { isPiProviderSelection } from "../shared/pi-modes";
import { recentResults, threadResult } from "../shared/results";
import { defaultChatTabs, pruneChatTabs, type ChatTabs } from "../shared/chat-tabs";
import { buildWorkerQuestionAnswers, parseWorkerQuestions, type WorkerQuestionAnswer } from "../shared/worker-questions";
import { imQuestionNotice, parseImAnswerCommand, parseImQuestionAnswers, type ImRequestCard } from "./im-requests";
import {
  dispatchMandateIssue,
  canRespondToWorkerPermission,
  newId,
  truncate,
  MAX_SPECULATIVE_TICKETS,
  SUBSCRIBED_STATUSES,
  TERMINAL_TICKET_STATUSES,
  type Decision,
  type ImCardSubmission,
  type ImDelivery,
  type PendingAction,
  type RouterAction,
  type SuperagentSnapshot,
  type SuperagentState,
  type Thread,
  type Ticket,
  type Trigger,
  type TriggerOrigin,
  type WatchdogState,
  type WorkerRequest,
  type WorkerResponse,
  WorkerRequestSchema,
} from "../shared/model";
import { orchestrationPermission } from "./agent-mcp";
import { approvalCode, describeRequest, needsHumanApproval, parseApprovalCommand, routerMayRespond, type ApprovalCommand } from "./approvals";
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
  composeVerdictRepairPrompt,
  newDecision,
  parseVerdict,
  type RouterInstructionOptions,
  type RouterWorkerEnvironment,
} from "./router";
import { harvestReport, launchWorker, retireWorker, type WorkerLaunchEnv } from "./workers";
import type { ToolOutcome } from "./mcp-server";
import { matchWorkerProfile, resolveProviderSelection, validateProviderMode, validateProviderThinkingOption } from "./providers";
import { readPiPermissionModes } from "./pi-modes";
import { ensureSharedWorkspace, detachRoleChildren, workspaceTitles } from "./workspace";
import { t } from "./i18n";
import { findInstructionFiles, inspectWorkingDir, nodeWorkingDirProbe, type WorkingDirProbe } from "./workdir";
import { deliveryPreview, splitImReply } from "./im-replies";
import {
  composePatrolPrompt,
  composeWatchdogInstructions,
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
 *   dispatch() → fast-path 截断/放行 → Thread 归属(IM 按渠道/账号/聊天/北京时间日,同日引用保留归属)
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
const ROUTER_PREPARE_TIMEOUT_MS = 60_000;
/** 单个待执行动作的尝试上限(首次执行 + 看门狗重试),超过后放弃并回流失败。 */
const MAX_ACTION_ATTEMPTS = 3;
/** 同一线程连续放弃的动作数达到上限后,不再自动回流失败触发,防 Router 循环。 */
const MAX_ABANDONED_ACTIONS = 3;
/** 基础设施异常的自动重排上限;指数退避从 15s 起,最多等待 5 分钟。 */
const MAX_EVAL_ERRORS = 20;
/** 单线程 filtered 留痕上限:滚动保留最近这么多条(相邻消息内联的来源),旧的先丢。 */
const MAX_FILTERED_TRIGGERS = 30;
/** 评估时内联的未 @ 相邻群聊条数(§3.3 Inline:时空相邻的消息)。 */
const CHATTER_CONTEXT = 5;
/** 引擎启动前到达(IM 先连上)的触发备注;引擎启动后据此补直通。 */
const QUEUED_BEFORE_START = "queued before the engine started";
const PREFERRED_PROVIDERS = ["claude", "codex", "opencode"];
/** 状态变化推送的合并窗口:一次评估里的多次落盘只推一个版本。 */
const STATE_EVENT_COALESCE_MS = 150;

/** 人发出的触发:对话页与斜杠命令(manual)、白名单 IM 发送者;agent 委派、汇报与引擎消息不算。 */
const HUMAN_TRIGGER_KINDS: readonly Trigger["kind"][] = ["manual", "feishu", "qq", "dingtalk", "wecom", "weixin"];
/** 列出待批请求时的条数上限。 */
const APPROVAL_LIST_LIMIT = 5;

/** 只有人直接发出、且指名机器人(非旁听)的消息才能成为批准/拒绝命令。 */
function humanApprovalCommand(trigger: Pick<Trigger, "kind" | "context" | "text">): ApprovalCommand | null {
  return HUMAN_TRIGGER_KINDS.includes(trigger.kind) && !trigger.context ? parseApprovalCommand(trigger.text) : null;
}

function imRequestCommand(trigger: Pick<Trigger, "origin" | "context" | "text" | "imCardSubmission">) {
  if (!trigger.origin || trigger.context) return null;
  return trigger.imCardSubmission ?? parseImAnswerCommand(trigger.text);
}

function clearWorkerRequests(state: SuperagentState, ticket: Ticket): void {
  ticket.pendingRequests = [];
  for (const trigger of state.triggers) {
    if (trigger.workerRequest?.ticketId === ticket.id && trigger.status === "pending") {
      trigger.status = "filtered";
      trigger.note = "Worker request no longer pending";
    }
  }
}

/**
 * 带副作用的裁决动作立案成可恢复记录(steer/cancel/retry/stop);
 * dispatch 的补执行由 pending 票据 + 看门狗承担,reply/ignore 无副作用。
 */
function planPendingAction(threadId: string, decisionId: string, action: RouterAction, workerAgentId?: string | null): PendingAction | null {
  if (action.action === "respond") {
    return {
      id: newId("act"), threadId, decisionId, kind: "respond", ticketId: action.ticketId,
      workerAgentId: workerAgentId ?? null, requestId: action.requestId, response: action.response,
      attempts: 0, createdAt: new Date().toISOString(),
    };
  }
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
  /** 非 IM 的稳定关联键;IM 来源键只作兼容,实际按 origin 会话和日期划分。 */
  threadKey?: string;
  /** IM 消息引用/回复的平台消息 id(父消息在前):命中本地记录时归入其线程并内联原文。 */
  replyTo?: string[];
  imCardSubmission?: ImCardSubmission;
}

/** 答复外发通道:由 index.server 注入(engine 不直接依赖具体 IM 实现)。 */
export interface ReplySink {
  /** 返回通道回执里的消息 id(有的话),用于用户引用答复时找回线程。 */
  send(origin: TriggerOrigin, text: string): Promise<string | null | void>;
  sendRequestCard?(origin: TriggerOrigin, card: ImRequestCard): Promise<string | null | undefined>;
}

export class SuperagentEngine {
  private paseo: PaseoApi | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private primed = false;
  private evalInFlight = false;
  private currentEvalThread: string | null = null;
  private evalRuns = new Map<string, Deadline>();
  private watchdogInFlight = false;
  private retiringTickets = new Set<string>();
  private sendingWorkers = new Set<string>();
  private evalQueued = new Set<string>();
  private batchTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private watchedTickets = new Map<string, symbol>();
  private permissionChains = new Map<string, Promise<boolean>>();
  private permissionConfirmations = new Map<string, (resolution: WorkerResponse) => void>();
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
  private patrolRun: Deadline | null = null;
  /** 可注入时钟用于 IM 跨日边界,不受宿主时区影响。 */
  now = (): Date => new Date();
  private replySink: ReplySink | null = null;
  private settingsValues: SuperagentSettingsValues = SETTINGS_DEFAULTS;
  private settingsReady: Promise<void>;
  /** 状态版本:进程启动标识区分插件重启前后的序号。 */
  private readonly bootId = newId("rev");
  private revisionSeq = 0;
  private stateListeners = new Set<(revision: string) => void>();
  private stateEventTimer: ReturnType<typeof setTimeout> | null = null;

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
    private readonly inferenceRequest: typeof fetch = fetch,
  ) {
    store.onChange(() => this.markChanged());
    settings.subscribe((state) => {
      if (state.status !== "ready") return;
      this.settingsValues = state.values;
      this.markChanged();
      void this.refreshWorkingDirIssue();
    });
    this.settingsReady = settings.read().then((state) => {
      if (state.status !== "ready") return;
      this.settingsValues = state.values;
      this.markChanged();
      void this.refreshWorkingDirIssue();
    }).catch((error) => { console.error("[superagent] initial settings read failed", error); });
  }

  /** 当前状态版本;snapshot 带同一个值,界面据此判断缓存是否已是最新。 */
  get revision(): string {
    return `${this.bootId}.${this.revisionSeq}`;
  }

  /**
   * 订阅状态变化(superagent.state_events 的来源):落盘记录、评估/巡检进行中与设置一变,
   * 合并 STATE_EVENT_COALESCE_MS 后回调一次最新版本。返回取消函数。
   */
  onStateChange(listener: (revision: string) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  private markChanged(): void {
    this.revisionSeq += 1;
    if (this.stateEventTimer || this.stateListeners.size === 0) return;
    this.stateEventTimer = setTimeout(() => {
      this.stateEventTimer = null;
      const revision = this.revision;
      for (const listener of this.stateListeners) {
        try {
          listener(revision);
        } catch (error) {
          console.error("[superagent] state listener failed", error);
        }
      }
    }, STATE_EVENT_COALESCE_MS);
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
      const changed = this.workingDirIssue !== issue;
      this.workingDirIssue = issue;
      this.workingDirCheck = { key, at: Date.now() };
      if (changed) this.markChanged();
    }
    return issue;
  }

  /** SDK 只把 paseo 交给 handler/hook;每个入口都会调 prime,首次调用启动引擎。 */
  prime(paseo: PaseoApi): void {
    this.paseo = paseo;
    if (this.primed) return;
    this.primed = true;
    this.markChanged();
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
    if (this.stateEventTimer) clearTimeout(this.stateEventTimer);
    this.stateEventTimer = null;
    this.stateListeners.clear();
    for (const timer of this.batchTimers.values()) clearTimeout(timer);
    this.batchTimers.clear();
    this.watchedTickets.clear();
    for (const run of this.evalRuns.values()) run.cancel();
    this.patrolRun?.cancel();
    this.primed = false;
    await this.deliveryChain;
    await this.store.flush();
  }

  // ---------------------------------------------------------------- intake

  /** 事件入口:fast-path → Thread 归属 → 订阅 fan-out 直通 | 排队评估。 */
  async dispatch(input: DispatchInput): Promise<{ threadId: string; triggerId: string; directDelivered: boolean; note: string | null }> {
    // 人的 /approve、/deny 由引擎确定性执行,不经 Router;引擎未启动时按普通消息排队,启动后补执行。
    if (input.origin && !input.context && !input.imCardSubmission && input.replyTo?.length
      && !parseApprovalCommand(input.task) && !parseImAnswerCommand(input.task)) {
      await this.store.ready;
      const chat = imConversationKey(input.origin);
      const quoted = input.replyTo.map((id) => this.store.get().imDeliveries.find((item) => item.workerRequest
        && imConversationKey(item.origin) === chat && item.sentMessageIds?.includes(id))).find(Boolean);
      const ref = quoted?.workerRequest;
      if (quoted && ref && this.pendingImRequest(ref)?.request.kind === "question") {
        input = { ...input, imCardSubmission: { deliveryId: quoted.id, behavior: "answer",
          text: input.task.trim().slice(0, this.settingsValues.triggerMaxChars) } };
      }
    }
    const kind = input.origin ? input.origin.channel : input.kind === "agent" ? "agent" : "manual";
    const command = this.paseo ? humanApprovalCommand({ kind, context: input.context ?? false, text: input.task.trim() }) : null;
    const imCommand = this.paseo && imRequestCommand({ origin: input.origin, context: input.context ?? false,
      text: input.task.trim().slice(0, this.settingsValues.triggerMaxChars), imCardSubmission: input.imCardSubmission });
    const outcome = await this.intake(input, command || imCommand ? { status: "delivered", note: "worker request response" } : { status: "pending" });
    if (!outcome) throw new Error("empty task");
    if (command || imCommand) {
      const trigger = this.store.get().triggers.find((item) => item.id === outcome.triggerId);
      if (trigger) return { ...outcome, note: imCommand ? await this.executeImRequest(trigger, imCommand)
        : await this.executeApprovalCommand(trigger, command!) };
    }
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
    /** delivered:引擎已直接处理(批准命令),只留痕,不直通、不评估、不重开线程。 */
    admission: { status: "pending" | "filtered" | "delivered"; note?: string },
  ): Promise<{ threadId: string; triggerId: string; directDelivered: boolean; note: string | null } | null> {
    await this.store.ready;
    const settings = this.settingsValues;
    const text = input.task.trim().slice(0, settings.triggerMaxChars);
    if (!text) {
      if (admission.status === "pending") throw new Error("empty task");
      return null;
    }

    const state = this.store.get();
    const received = this.now();
    const day = input.origin ? imDay(received) : undefined;
    const conversation = input.origin ? imConversationKey(input.origin) : undefined;
    const key = conversation && day ? dailyImThreadKey(conversation, day) : input.threadKey;
    const linked = input.origin && input.replyTo?.length ? this.resolveQuoted(state, input.origin, input.replyTo) : null;
    let thread: Thread | undefined;
    if (input.origin) {
      // 日界线和渠道隔离优先于引用与外部指定的 threadId;旧消息仍作为引用上下文。
      const quoted = linked?.threadId ? state.threads.find((t) => t.id === linked.threadId) : undefined;
      const specified = input.threadId ? state.threads.find((t) => t.id === input.threadId) : undefined;
      thread = quoted && quoted.imDay === day ? quoted
        : specified && specified.imDay === day && specified.imConversationKey === conversation ? specified
          : state.threads.find((t) => t.key === key);
    } else if (input.threadId) {
      thread = state.threads.find((t) => t.id === input.threadId);
      if (!thread) throw new Error(`thread ${input.threadId} not found`);
    } else if (key) {
      thread = state.threads.find((t) => t.key === key);
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
    const now = received.toISOString();
    const sender = input.sender?.trim() || "user";
    const title = (input.title?.trim() || text.split("\n")[0] || "task").slice(0, 120);

    if (!thread) {
      thread = {
        id: newId("thr"),
        key: key ?? `manual:${newId("k")}`,
        ...(day ? { imDay: day, imConversationKey: conversation } : {}),
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
      imCardSubmission: input.origin && !input.context ? input.imCardSubmission : undefined,
      receivedAt: now,
      status: admission.status === "delivered" ? "delivered" : "pending",
      note: admission.status === "delivered" ? admission.note ?? null : queuedBeforeStart ? QUEUED_BEFORE_START : null,
      threadId,
      quote: linked?.quote ?? null,
    };

    await this.store.update((next) => {
      if (!next.threads.some((t) => t.id === threadId)) {
        next.threads.push(thread!);
      }
      next.triggers.push(trigger);
      const target = next.threads.find((t) => t.id === threadId);
      if (target) { target.updatedAt = now; target.lastActivityAt = now; }
    });

    if (admission.status === "delivered") return { threadId, triggerId, directDelivered: false, note: admission.note ?? null };
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
        target.lastActivityAt = now;
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

  private threadHasWorkerRequests(threadId: string): boolean {
    return this.store.get().tickets.some((ticket) => !TERMINAL_TICKET_STATUSES.includes(ticket.status)
      && (ticket.threadId === threadId || followsOf(ticket).includes(threadId)) && ticket.pendingRequests?.length);
  }

  /** 不依赖权限 hook 是否先到达:用户回复前读回请求,避免普通 send 清掉尚未回答的问题。 */
  private async refreshThreadRequests(threadId: string): Promise<void> {
    for (const ticket of this.store.get().tickets) {
      if (ticket.workerAgentId && !TERMINAL_TICKET_STATUSES.includes(ticket.status)
        && (ticket.threadId === threadId || followsOf(ticket).includes(threadId))) {
        await this.syncWorkerPermissions(ticket.workerAgentId);
      }
    }
  }

  /** hook、watcher、恢复与定时对账共用;请求与通知一次落盘,重复事件不会重复通知。 */
  async syncWorkerPermissions(agentId: string): Promise<boolean> {
    const pending = (this.permissionChains.get(agentId) ?? Promise.resolve(false))
      .catch(() => false).then(() => this.readWorkerPermissions(agentId));
    this.permissionChains.set(agentId, pending);
    try {
      return await pending;
    } finally {
      if (this.permissionChains.get(agentId) === pending) this.permissionChains.delete(agentId);
    }
  }

  private async readWorkerPermissions(agentId: string): Promise<boolean> {
    await this.store.ready;
    const ticket = this.store.get().tickets.find((item) => item.workerAgentId === agentId);
    if (!ticket || TERMINAL_TICKET_STATUSES.includes(ticket.status)) return false;
    const snapshot = await bounded(() => this.requirePaseo().agents.ref(agentId).refresh(), "Worker permissions refresh");
    if (!snapshot) return Boolean(ticket.pendingRequests?.length);
    const requests = (snapshot.agent.archivedAt ? [] : snapshot.agent.pendingPermissions ?? [])
      .filter((request) => !orchestrationPermission("worker", request))
      .map((request) => WorkerRequestSchema.parse(request));
    if (JSON.stringify(ticket.pendingRequests ?? []) === JSON.stringify(requests)) return requests.length > 0;
    const now = new Date().toISOString();
    const notifyThreads = new Set<string>();
    const requestDeliveries: string[] = [];
    /** 授权类请求不交 Router:引擎原样告诉人,只有人能批准。 */
    const approvalNotices: { threadId: string; workerRequest: NonNullable<Trigger["workerRequest"]>; text: string }[] = [];
    await this.store.update((next) => {
      const target = next.tickets.find((item) => item.id === ticket.id);
      if (!target || target.workerAgentId !== agentId || TERMINAL_TICKET_STATUSES.includes(target.status)) return;
      const previous = target.pendingRequests ?? [];
      const added = requests.filter((request) => !previous.some((old) => old.id === request.id));
      target.pendingRequests = requests;
      if (added.length) {
        target.requestWaitSince = now;
        target.requestWaitNotifiedAt = null;
      } else if (!requests.length) {
        target.requestWaitSince = null;
        target.requestWaitNotifiedAt = null;
      }
      if (previous.length && !requests.length) {
        // 等人输入的时间不计入下一段执行的超时预算。
        target.startedAt = now;
        target.updatedAt = now;
      }
      if (requests.length && target.status === "waiting") target.status = "running";
      for (const trigger of next.triggers) {
        if (trigger.workerRequest?.agentId === agentId && trigger.status === "pending"
          && !requests.some((request) => request.id === trigger.workerRequest?.requestId)) {
          trigger.status = "filtered";
          trigger.note = "Worker request already resolved";
        }
      }
      for (const request of added) {
        for (const threadId of this.reportThreads(target)) {
          const thread = next.threads.find((item) => item.id === threadId && item.state === "active");
          if (!thread) continue;
          const workerRequest = { ticketId: target.id, agentId, requestId: request.id };
          const approval = needsHumanApproval(request);
          const origin = next.triggers.filter((item) => item.threadId === threadId && !item.workerRequest)
            .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
            .find((item) => item.status !== "filtered" && (item.origin || item.replyToAgentId));
          const form = !approval && origin?.origin ? parseWorkerQuestions(request.input) : null;
          if (origin?.origin && (approval || form)) {
            const text = form ? imQuestionNotice(target.title, approvalCode(target.id, request.id), form.questions)
              : this.approvalNotice(target, request);
            const notice = newDecision(threadId, [], "reply", { reply: text, ticketId: target.id, workerApprovalNotice: true,
              rationale: "engine: Worker request sent to IM" });
            const delivery = this.prepareImDelivery(notice, origin.origin, text, workerRequest);
            next.decisions.push(notice);
            next.imDeliveries.push(delivery);
            requestDeliveries.push(delivery.id);
            continue;
          }
          if (approval) {
            approvalNotices.push({ threadId, workerRequest, text: this.approvalNotice(target, request) });
            continue;
          }
          next.triggers.push({
            id: newId("trg"), kind: "engine", sender: `worker:${target.id}`, threadId, threadKey: thread.key,
            workerRequest,
            text: `Worker "${target.title}" needs a ${request.kind} response. ticketId=${target.id} requestId=${request.id}\n`
              + `Answer this question with respond when established context covers it; otherwise use reply to ask the human.\n`
              + truncate(JSON.stringify(request), 6000) + `\nFull current requests: superagent_read ${target.id}`,
            context: false, origin: origin?.origin ?? null, replyToAgentId: origin?.replyToAgentId ?? null,
            receivedAt: now, status: "pending", note: null,
          });
          notifyThreads.add(threadId);
        }
      }
    });
    for (const id of requestDeliveries) void this.sendImDelivery(id);
    for (const threadId of notifyThreads) this.scheduleEval(threadId, 0);
    for (const notice of approvalNotices) {
      await this.notifyThread(notice.threadId, notice.text, {
        outcome: "reply", ticketId: notice.workerRequest.ticketId, workerApprovalNotice: true, workerRequest: notice.workerRequest,
        rationale: "engine: Worker permission request awaits the human's /approve or /deny",
      });
    }
    return Boolean(this.store.get().tickets.find((item) => item.id === ticket.id)?.pendingRequests?.length);
  }

  /** 授权请求通知正文:请求原文摘录与批准码,不经模型转述。 */
  private approvalNotice(ticket: Ticket, request: WorkerRequest): string {
    return t("server.engine.approvalNeeded", {
      title: ticket.title, request: describeRequest(request), code: approvalCode(ticket.id, request.id),
    });
  }

  /**
   * 人能处理的待批请求。IM 发送者只能处理在同一聊天里通知过的请求(票据的汇报线程
   * 收过该聊天的消息);对话页与斜杠命令来自 Paseo 的使用者本人,不限对话。
   */
  private approvalCandidates(origin: TriggerOrigin | null | undefined): { ticket: Ticket; request: WorkerRequest; code: string }[] {
    const state = this.store.get();
    const conversation = origin ? imConversationKey(origin) : null;
    const candidates: { ticket: Ticket; request: WorkerRequest; code: string }[] = [];
    for (const ticket of state.tickets) {
      if (!ticket.workerAgentId || TERMINAL_TICKET_STATUSES.includes(ticket.status)) continue;
      const requests = (ticket.pendingRequests ?? []).filter((request) => needsHumanApproval(request));
      if (!requests.length) continue;
      if (conversation) {
        const threads = new Set([ticket.threadId, ...followsOf(ticket)]);
        const sameChat = state.threads.some((thread) => threads.has(thread.id) && thread.imConversationKey === conversation)
          || state.triggers.some((trigger) => trigger.threadId && threads.has(trigger.threadId)
            && trigger.origin && imConversationKey(trigger.origin) === conversation);
        if (!sameChat) continue;
      }
      for (const request of requests) candidates.push({ ticket, request, code: approvalCode(ticket.id, request.id) });
    }
    return candidates;
  }

  private pendingApprovalSummary(candidates: { ticket: Ticket; request: WorkerRequest; code: string }[]): string {
    if (!candidates.length) return t("server.engine.approvalNonePending");
    const list = candidates.slice(0, APPROVAL_LIST_LIMIT)
      .map(({ ticket, request, code }) => `${code} (${truncate(ticket.title, 40)}: ${request.kind} · ${truncate(request.name, 60)})`);
    if (candidates.length > APPROVAL_LIST_LIMIT) list.push("…");
    return t("server.engine.approvalPending", { list: list.join("; ") });
  }

  private pendingImRequest(ref: NonNullable<ImDelivery["workerRequest"]>) {
    const ticket = this.store.get().tickets.find((item) => item.id === ref.ticketId && item.workerAgentId === ref.agentId);
    if (!ticket || TERMINAL_TICKET_STATUSES.includes(ticket.status)) return null;
    const request = ticket.pendingRequests?.find((item) => item.id === ref.requestId);
    return request ? { ticket, request } : null;
  }

  private async executeImRequest(trigger: Trigger, command: NonNullable<ReturnType<typeof imRequestCommand>>): Promise<string> {
    const origin = trigger.origin!;
    const card = "deliveryId" in command ? command : null;
    const code = "code" in command ? command.code : null;
    const candidates = new Map<string, { ticket: Ticket; request: WorkerRequest; threadId: string }>();
    for (const delivery of this.store.get().imDeliveries) {
      const ref = delivery.workerRequest;
      if (!ref || imConversationKey(origin) !== imConversationKey(delivery.origin)) continue;
      if (card ? delivery.id !== card.deliveryId : !code || approvalCode(ref.ticketId, ref.requestId) !== code) continue;
      const current = this.pendingImRequest(ref);
      if (current && this.reportThreads(current.ticket).includes(delivery.threadId) && (card || current.request.kind === "question")) {
        candidates.set(JSON.stringify(ref), { ...current, threadId: delivery.threadId });
      }
    }
    const candidate = candidates.size === 1 ? candidates.values().next().value : undefined;
    let note = candidates.size > 1 ? "ambiguous IM request" : "IM request is no longer pending";
    let text = candidates.size > 1 ? t("server.engine.approvalAmbiguous", { code: code ?? "" }) : t("server.engine.approvalGone");
    if (code === "") text = t("server.engine.imAnswerUsage");
    if (candidate) {
      const { ticket, request } = candidate;
      const behavior = card?.behavior ?? "answer";
      const form = behavior === "answer" && request.kind === "question" ? parseWorkerQuestions(request.input) : null;
      const answers = form && parseImQuestionAnswers(form.questions, card ?? { text: command.text });
      const decision = behavior === "answer" ? (answers ? { behavior, answers } : null)
        : behavior === "allow" ? { behavior } : { behavior, message: "Denied by the human" };
      const result = decision ? await this.respondAsHuman(ticket, request, decision, candidate.threadId)
        : { error: t("server.engine.imAnswerInvalid") };
      if (result === "done") {
        text = t(behavior === "answer" ? "server.engine.questionAnswered"
          : behavior === "allow" ? "server.engine.approvalAllowed" : "server.engine.approvalDenied", { title: ticket.title, name: request.name });
        note = `human ${behavior} for IM request ${request.id} of ${ticket.id}`;
      } else if (result !== "gone") {
        text = result.error;
        note = "IM response was rejected";
      }
    }
    await this.store.update((next) => {
      const current = next.triggers.find((item) => item.id === trigger.id);
      if (current) {
        current.note = note;
        delete current.imCardSubmission;
      }
    });
    await this.notifyThread(trigger.threadId!, text, { outcome: "reply", origin, ticketId: candidate?.ticket.id,
      triggerIds: [trigger.id], rationale: note });
    return note;
  }

  /**
   * 执行人的 /approve、/deny:按批准码找到具体请求,刷新确认它仍在等待后直接回给 Worker,
   * 不经 Router。结果写进命令触发的备注,并在同一对话里答复。返回备注。
   */
  private async executeApprovalCommand(trigger: Trigger, command: ApprovalCommand): Promise<string> {
    const threadId = trigger.threadId!;
    const candidates = this.approvalCandidates(trigger.origin);
    const matches = command.code ? candidates.filter((candidate) => candidate.code === command.code) : [];
    let text: string;
    let note: string;
    let ticketId: string | null = null;
    if (!command.code) {
      text = t("server.engine.approvalUsage", { pending: this.pendingApprovalSummary(candidates) });
      note = "approval command without a valid code";
    } else if (matches.length === 0) {
      text = t("server.engine.approvalNotFound", { code: command.code, pending: this.pendingApprovalSummary(candidates) });
      note = `no pending request with code ${command.code}`;
    } else if (matches.length > 1) {
      text = t("server.engine.approvalAmbiguous", { code: command.code });
      note = `code ${command.code} is ambiguous`;
    } else {
      const { ticket, request } = matches[0];
      ticketId = ticket.id;
      const response: WorkerResponse = command.behavior === "allow"
        ? { behavior: "allow" }
        : { behavior: "deny", message: command.message ?? "Denied by the human" };
      const result = await this.respondAsHuman(ticket, request, response);
      if (result === "done") {
        text = t(command.behavior === "allow" ? "server.engine.approvalAllowed" : "server.engine.approvalDenied", {
          title: ticket.title, name: request.name,
        });
        note = `${command.behavior === "allow" ? "approved" : "denied"} request ${request.id} of ${ticket.id} (code ${command.code})`;
      } else if (result === "gone") {
        text = t("server.engine.approvalGone");
        note = `request ${request.id} of ${ticket.id} was no longer pending`;
      } else {
        text = t("server.engine.approvalFailed", { error: truncate(result.error, 200) });
        note = `response to request ${request.id} of ${ticket.id} failed: ${truncate(result.error, 120)}`;
      }
    }
    await this.store.update((next) => {
      const target = next.triggers.find((item) => item.id === trigger.id);
      if (target) target.note = note;
    });
    await this.notifyThread(threadId, text, {
      outcome: "reply", ticketId, triggerIds: [trigger.id],
      rationale: `engine: human /${command.behavior === "allow" ? "approve" : "deny"} from ${trigger.sender}: ${note}`,
    });
    return note;
  }

  /** 对话页的人工回复,绑定卡片所显示的线程、Worker 和请求。 */
  async respondToWorkerPermission(input: RpcInput<typeof superagentRespondToPermissionRpc>): Promise<void> {
    await this.store.ready;
    const { threadId, ticketId, agentId, requestId, behavior } = input;
    const ticket = this.store.get().tickets.find((item) => item.id === ticketId && item.workerAgentId === agentId);
    const request = ticket?.pendingRequests?.find((item) => item.id === requestId);
    if (!ticket || !request || !this.reportThreads(ticket).includes(threadId)) {
      throw new Error(t("server.engine.approvalGone"));
    }
    const decision = input.behavior === "answer" ? { behavior: input.behavior, answers: input.answers }
      : input.behavior === "allow" ? { behavior: input.behavior } : { behavior: input.behavior, message: "Denied by the human" };
    const result = await this.respondAsHuman(ticket, request, decision, threadId);
    if (result !== "done") throw new Error(result === "gone" ? t("server.engine.approvalGone") : result.error);
    const receipt = behavior === "answer" ? "server.engine.questionAnswered"
      : behavior === "allow" ? "server.engine.approvalAllowed" : "server.engine.approvalDenied";
    await this.notifyThread(threadId, t(receipt, {
      title: ticket.title, name: request.name,
    }), {
      outcome: "reply", ticketId,
      rationale: `engine: human ${behavior} for request ${requestId} of ${ticketId} from the request card`,
    });
  }

  /** 人的决定原样发给 Worker,等待 Paseo 的解决事件再记为成功。 */
  private async respondAsHuman(
    ticket: Ticket,
    request: WorkerRequest,
    decision: WorkerResponse | { behavior: "answer"; answers: WorkerQuestionAnswer[] },
    threadId?: string,
  ): Promise<"done" | "gone" | { error: string }> {
    const agentId = ticket.workerAgentId;
    if (!agentId) return "gone";
    await this.syncWorkerPermissions(agentId);
    const current = this.store.get().tickets.find((item) => item.id === ticket.id);
    const pending = current?.pendingRequests?.find((item) => item.id === request.id);
    if (!current || current.workerAgentId !== agentId || TERMINAL_TICKET_STATUSES.includes(current.status)
      || !pending || (threadId && !this.reportThreads(current).includes(threadId))) return "gone";
    let response: WorkerResponse;
    if (decision.behavior === "answer") {
      const form = pending.kind === "question" ? parseWorkerQuestions(pending.input) : null;
      const answers = form && buildWorkerQuestionAnswers(form.questions, decision.answers);
      if (!form || !answers) return { error: t("server.engine.questionInvalid") };
      response = { behavior: "allow", updatedInput: { ...form.input, answers } };
    } else {
      if (!canRespondToWorkerPermission(pending, decision.behavior)) return { error: t("server.engine.approvalOpenWorker") };
      response = decision;
    }
    const key = JSON.stringify([agentId, request.id]);
    if (this.permissionConfirmations.has(key)) return { error: t("server.engine.approvalInFlight") };
    const confirmation = new Promise<WorkerResponse>((resolve) => this.permissionConfirmations.set(key, resolve));
    try {
      const resolution = await bounded(async () => {
        await this.requirePaseo().agents.ref(agentId).respondToPermission({ requestId: request.id, response });
        return confirmation;
      }, "Worker permission response", 15_000);
      if (resolution.behavior !== response.behavior) return "gone";
      if (decision.behavior === "answer" && response.behavior === "allow"
        && (resolution.behavior !== "allow" || !isDeepStrictEqual(resolution.updatedInput?.answers, response.updatedInput?.answers))) return "gone";
      return "done";
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    } finally {
      try {
        await this.workerPermissionResolved(agentId);
      } catch (error) {
        console.error("[superagent] failed to reconcile Worker permissions after a human response", error);
      } finally {
        this.permissionConfirmations.delete(key);
      }
    }
  }

  /** 人工或 Router 响应后继续追踪;不把一条普通消息当成权限响应。 */
  async workerPermissionResolved(agentId: string, result?: { requestId: string; resolution: WorkerResponse }): Promise<void> {
    if (result) this.permissionConfirmations.get(JSON.stringify([agentId, result.requestId]))?.(result.resolution);
    if (await this.syncWorkerPermissions(agentId)) return;
    const ticket = this.store.get().tickets.find((item) => item.workerAgentId === agentId);
    if (ticket?.status === "running") this.watchTicket(ticket.id);
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
      other?.channel === origin.channel && other.chatId === origin.chatId && other.accountId === origin.accountId;
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
    await this.refreshThreadRequests(trigger.threadId!);
    if (this.threadHasWorkerRequests(trigger.threadId!)) return false;
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
    check: () => void = () => {},
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const paseo = this.requirePaseo();
    const ticket = this.store.get().tickets.find((t) => t.id === ticketId);
    if (!ticket?.workerAgentId) {
      return { ok: false, error: `ticket ${ticketId} has no worker to receive messages` };
    }
    if (await this.syncWorkerPermissions(ticket.workerAgentId)) {
      return { ok: false, error: `ticket ${ticketId} is awaiting input; use respond with its requestId, not steer` };
    }
    check();
    if (this.retiringTickets.has(ticketId) || ticket.retireRequested || !["running", "waiting"].includes(ticket.status)) {
      return { ok: false, error: `ticket ${ticketId} is no longer available` };
    }
    this.sendingWorkers.add(ticketId);
    try {
      const agentId = ticket.workerAgentId;
      await bounded(() => paseo.agents.ref(agentId).send(text, { activeTurnBehavior: mode }), "Worker message");
    } catch (error) {
      this.sendingWorkers.delete(ticketId);
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    try {
      await this.store.update((next) => {
        check();
        const target = next.tickets.find((t) => t.id === ticketId);
        if (target?.status === "waiting") {
          target.status = "running";
          target.startedAt = new Date().toISOString();
          target.updatedAt = target.startedAt;
          target.lastError = null;
        }
      });
    } finally { this.sendingWorkers.delete(ticketId); }
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
    check: () => void = () => {},
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const ticket = this.store.get().tickets.find((t) => t.id === ticketId);
    if (!ticket) {
      return { ok: false, error: `ticket ${ticketId} not found` };
    }
    if (!ticket.workerAgentId || !["running", "waiting"].includes(ticket.status)) {
      return { ok: false, error: `ticket ${ticketId} cannot receive messages while ${ticket.status}` };
    }
    return this.sendToWorker(ticketId, text, mode, check);
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
    const retry = this.store.get().threads.find((t) => t.id === next)?.evalRetry;
    if ((retry?.errors ?? 0) >= MAX_EVAL_ERRORS || (retry?.unparsed ?? 0) >= 3) {
      this.evalQueued.delete(next);
      if (this.evalQueued.size) void this.drainEvalQueue();
      return;
    }
    if (retry?.nextAt && Date.parse(retry.nextAt) > Date.now()) {
      this.evalQueued.delete(next);
      this.scheduleEval(next, Date.parse(retry.nextAt) - Date.now());
      if (this.evalQueued.size) void this.drainEvalQueue();
      return;
    }
    this.evalInFlight = true;
    this.currentEvalThread = next;
    this.evalQueued.delete(next);
    this.markChanged();
    try {
      await this.runEval(next);
    } catch (error) {
      if (!this.primed) return;
      console.error("[superagent] eval failed", error);
      // 异常走独立计数:瞬时故障(provider 未就绪等)按看门狗节奏持续重查,
      // 不与 unparsed(模型输出问题)共用 3 次熔断。
      const errors = (this.evalErrors.get(next) ?? retry?.errors ?? 0) + 1;
      this.evalErrors.set(next, errors);
      const message = error instanceof Error ? error.message : String(error);
      await this.store.update((state) => {
        const thread = state.threads.find((t) => t.id === next);
        if (thread) {
          thread.evalRetry = { errors, unparsed: thread.evalRetry?.unparsed ?? 0,
            nextAt: new Date(Date.now() + Math.min(300_000, 15_000 * 2 ** Math.min(errors - 1, 5))).toISOString() };
          for (const trigger of state.triggers) {
            if (trigger.threadId === next && trigger.status === "pending") trigger.note = errors >= MAX_EVAL_ERRORS
              ? "Router evaluation paused after repeated failures; use re-evaluate to retry" : "Router evaluation failed; retry scheduled";
          }
          state.decisions.push(
            newDecision(next, [], "error", { rationale: truncate(message, 400) }),
          );
        }
      });
      if (errors === MAX_EVAL_ERRORS) await this.notifyThread(next,
        t("server.engine.evalFailed"));
    } finally {
      this.evalInFlight = false;
      this.currentEvalThread = null;
      this.markChanged();
      if (this.evalQueued.size > 0) void this.drainEvalQueue();
    }
  }

  private async runEval(threadId: string): Promise<void> {
    if (this.evalRuns.has(threadId)) throw new Error("Router evaluation already in progress");
    const startedAt = Date.now();
    const prepare = new Deadline(ROUTER_PREPARE_TIMEOUT_MS, "Router preparation");
    let run = prepare;
    this.evalRuns.set(threadId, prepare);
    try {
      await prepare.wait(() => this.settingsReady);
      run = new Deadline(Math.max(1, this.settingsValues.routerEvalTimeoutMin * 60_000 - (Date.now() - startedAt)), `Router evaluation ${threadId}`);
      this.evalRuns.set(threadId, run);
      await run.wait(() => this.evaluateThread(threadId, run, prepare));
    } finally {
      run.cancel();
      prepare.cancel();
      if (this.evalRuns.get(threadId) === run) this.evalRuns.delete(threadId);
    }
  }

  private async evaluateThread(threadId: string, run: Deadline, prepare: Deadline): Promise<void> {
    const preparing = async <T>(operation: () => Promise<T>): Promise<T> => {
      run.check();
      const result = await prepare.wait(operation);
      run.check();
      return result;
    };
    await preparing(() => this.store.ready);
    const paseo = this.requirePaseo();
    await preparing(() => this.refreshThreadRequests(threadId));
    let state = this.store.get();
    const thread = state.threads.find((t) => t.id === threadId);
    if (!thread || thread.state === "closed") return;
    const batch = state.triggers.filter((t) => t.threadId === threadId && t.status === "pending");
    if (batch.length === 0) return;

    const config = this.inferenceConfig("router");
    const evaluatedWorkers = new Map(state.tickets.map((ticket) => [ticket.id, ticket.workerAgentId]));
    const worker: RouterWorkerEnvironment = {
      workingDir: this.settingsValues.workingDir,
      isolation: this.settingsValues.workerIsolation,
      issue: this.settingsValues.workingDir
        ? await preparing(() => this.refreshWorkingDirIssue()) : "Worker working directory is not configured",
      instructionFiles: this.settingsValues.workingDir
        ? await preparing(() => this.instructionFilesFor(this.settingsValues.workingDir)) : [],
      defaultWorker: {
        provider: this.settingsValues.workerProvider.trim() || state.kv.workerProvider || null,
        description: this.settingsValues.workerDescription,
      },
      profiles: this.settingsValues.workerProfiles,
    };
    const ruleOptions: RouterInstructionOptions = { speculative: this.settingsValues.speculativeEnabled };
    // 本批 IM 渠道(去重后唯一时)进入 system 提示的答复风格指南。
    const originChannels = [...new Set(batch.filter((trigger) => trigger.origin).map((trigger) => trigger.origin!.channel))];
    if (originChannels.length === 1) ruleOptions.channel = originChannels[0];
    const instructions = composeRouterInstructions(worker, this.settingsValues.routerInstructions, ruleOptions);
    const contextTriggers = state.triggers.filter((trigger) => trigger.threadId === threadId && trigger.status === "delivered")
      .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt)).slice(-8);
    const context = composeEvalPrompt({
      thread, batch, state, worker, includeInstructions: false, includeHistory: true,
      contextTriggers, chatter: this.chatterFor(state, threadId, batch), options: ruleOptions,
    });
    const parsed = await runInference({
      config, instructions, context, threadId, recall: this.inferenceRecall(threadId),
      parse: parseVerdict, repair: (error) => composeVerdictRepairPrompt(threadId, error), deadline: run,
    }, this.inferenceRequest);
    run.check();
    const replyText = parsed.text;
    const triggerIds = batch.map((trigger) => trigger.id);
    const stillPending = (current: SuperagentState) =>
      current.threads.some((item) => item.id === threadId && item.state === "active") &&
      triggerIds.every((id) => current.triggers.some((trigger) => trigger.id === id && trigger.status === "pending"));
    state = this.store.get();
    if (!stillPending(state)) return;

    // 纠正后仍失败才记一次 unparsed,触发保留 pending,连续失败计数防失控循环。
    const recordUnparsed = async (reason: string) => {
      run.check();
      const failures = (this.evalFailures.get(threadId) ?? thread.evalRetry?.unparsed ?? 0) + 1;
      this.evalFailures.set(threadId, failures);
      await this.store.update((next) => {
        run.check();
        const target = next.threads.find((t) => t.id === threadId);
        if (target) target.evalRetry = { errors: target.evalRetry?.errors ?? 0, unparsed: failures, nextAt: null };
        next.decisions.push(
          newDecision(threadId, batch.map((t) => t.id), "unparsed", {
            rationale: reason,
            raw: truncate(replyText, 1200),
            inference: parsed.trace,
          }),
        );
      });
      run.check();
      if (failures === 3) await this.notifyThread(threadId, t("server.engine.verdictFailed"));
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
    for (const action of parsed.verdict.actions) {
      if (action.action !== "respond") continue;
      const target = state.tickets.find((ticket) => ticket.id === action.ticketId);
      const observedAgentId = evaluatedWorkers.get(action.ticketId);
      if ((observedAgentId && observedAgentId !== target?.workerAgentId) ||
        !target?.pendingRequests?.some((request) => request.id === action.requestId)) {
        await recordUnparsed(`respond must name a current pending request: ticketId=${action.ticketId} requestId=${action.requestId}`);
        return;
      }
    }
    this.evalFailures.delete(threadId);
    this.evalErrors.delete(threadId);
    const verdict = parsed.verdict;

    // 4. 执行裁决:每个动作一条 Decision,带副作用的动作另立案待执行记录,一次落盘
    //    (先落盘后副作用);stop 之后的动作作废,不再立案。
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
          pendingRequests: [],
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
      } else if (action.action === "respond") {
        const owner = state.tickets.find((ticket) => ticket.id === action.ticketId);
        const request = owner?.pendingRequests?.find((item) => item.id === action.requestId);
        if (owner && request && !routerMayRespond(request, action.response)) {
          // 硬约束:Router 不能批准授权类请求。不执行,改为把请求原文和批准码交给人,请求保持等待。
          const notice = this.approvalNotice(owner, request);
          decision.outcome = "reply";
          decision.reply = notice;
          decision.ticketId = owner.id;
          decision.rationale = `blocked Router approval of ${request.kind} request ${request.id}: only the human can approve it`;
          replies.push(notice);
          decisions.push(decision);
          actionRecords.push(null);
          continue;
        }
        decision.rationale = `request ${action.requestId}: ${truncate(JSON.stringify(action.response), 1000)}`;
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
      actionRecords.push(planPendingAction(threadId, decision.id, action,
        "ticketId" in action ? state.tickets.find((ticket) => ticket.id === action.ticketId)?.workerAgentId : null));
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
    decisions[0].inference = parsed.trace;

    const recalledMemory = thread.routerMemory ?? [];
    const memorySources = new Set([...batch.filter((item) => !item.context).map((item) => item.id),
      ...recalledMemory.map((item) => item.triggerId)]);
    const memory = verdict.memory?.every((item) => memorySources.has(item.triggerId)) ? verdict.memory : undefined;
    let committed = false;
    await this.store.update((next) => {
      run.check();
      if (!stillPending(next)) return;
      committed = true;
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
        target.evalRetry = { errors: 0, unparsed: 0, nextAt: null };
        target.updatedAt = decidedAt;
        if (memory !== undefined) target.routerMemory = memory;
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
    run.check();

    if (!committed) return;

    // 副作用按序执行;失败的动作留在待执行记录里由看门狗按上限重试,不再重放整批。
    const launchQueue = [...createdTickets];
    for (let index = 0; index < actionRecords.length; index++) {
      run.check();
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
    run.check();
    if (delivery) {
      await this.sendImDelivery(delivery.id);
    } else if (fullReply && !origin) {
      const reply = truncate(fullReply, 2000);
      const replyTarget = batch.find((t) => t.replyToAgentId)?.replyToAgentId ?? null;
      if (replyTarget) {
        try {
          await bounded(() => paseo.agents.ref(replyTarget).send(reply, {
            activeTurnBehavior: "steer",
          }), "Router reply relay");
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
      const ref = delivery.workerRequest;
      if (ref && delivery.nextPart === 0) {
        const current = this.pendingImRequest(ref);
        if (!current) {
          await this.store.update((next) => {
            const target = next.imDeliveries.find((item) => item.id === id);
            if (target) { target.status = "sent"; target.nextPart = target.parts.length; }
          });
          return;
        }
        const { ticket, request } = current;
        const sink = this.replySink;
        if (sink?.sendRequestCard) {
          const card: ImRequestCard = {
            deliveryId: id, title: ticket.title, text: delivery.parts.join("\n"),
            questions: request.kind === "question" ? parseWorkerQuestions(request.input)?.questions : undefined,
            allow: canRespondToWorkerPermission(request, "allow"), deny: canRespondToWorkerPermission(request, "deny"),
          };
          const origin = delivery.origin;
          const cardMessageId = await bounded(() => sink.sendRequestCard!(origin, card), "IM request card").catch(() => undefined);
          if (cardMessageId !== undefined) {
            await this.store.update((next) => {
              const target = next.imDeliveries.find((item) => item.id === id);
              if (!target) return;
              target.nextPart = target.parts.length;
              target.status = "sent";
              target.updatedAt = this.now().toISOString();
              if (cardMessageId) target.sentMessageIds = [...(target.sentMessageIds ?? []), cardMessageId];
            });
            return;
          }
        }
      }
      while (delivery.nextPart < delivery.parts.length) {
        let sentId: string | null = null;
        try {
          if (!this.replySink) throw new Error("IM reply channel is not available");
          const sink = this.replySink;
          const origin = delivery.origin;
          const part = delivery.parts[delivery.nextPart];
          sentId = (await bounded(() => sink.send(origin, part), "IM reply")) || null;
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
    if (delivery.status !== "failed") throw new Error(t("server.engine.resendNotFailed"));
    await this.store.update((next) => {
      const target = next.imDeliveries.find((item) => item.id === id)!;
      target.status = "pending";
    });
    await this.sendImDelivery(id);
    if (this.store.get().imDeliveries.find((item) => item.id === id)?.status === "failed") {
      throw new Error(t("server.engine.resendFailed"));
    }
    if (this.store.get().imDeliveries.find((item) => item.id === id)?.status !== "sent") {
      throw new Error(t("server.engine.resendIncomplete"));
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
    const deadline = new Deadline(30_000, "Router action");
    let outcome: { ok: true } | { ok: false; error: string };
    try {
      outcome = await deadline.wait(() => this.performPendingAction(record, () => deadline.check()));
    } catch (error) {
      deadline.cancel();
      if (!(error instanceof DeadlineError)) throw error;
      // A timed-out send may already have reached the daemon. Hold for review rather than replaying it.
      await this.store.update((next) => {
        next.pendingActions = next.pendingActions.filter((a) => a.id !== recordId);
        const decision = next.decisions.find((d) => d.id === record.decisionId);
        if (decision) decision.rationale = `${decision.rationale ?? ""}\nAction timed out; delivery uncertain; automatic replay paused`.trim();
      });
      await this.notifyThread(record.threadId, t("server.engine.actionTimedOut", { kind: record.kind }));
      return;
    } finally { deadline.cancel(); }
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
    const source = this.store.get().triggers.filter((trigger) => trigger.threadId === record.threadId)
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
      .find((trigger) => trigger.status !== "filtered" && (trigger.origin || trigger.replyToAgentId));
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
        replyToAgentId: source?.replyToAgentId ?? null,
        origin: source?.origin ?? null,
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
    check: () => void = () => {},
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const paseo = this.requirePaseo();
    if (record.kind === "respond") {
      const ticket = this.store.get().tickets.find((item) => item.id === record.ticketId);
      if (!ticket || TERMINAL_TICKET_STATUSES.includes(ticket.status)) return { ok: true };
      if (!record.workerAgentId || ticket.workerAgentId !== record.workerAgentId) {
        return { ok: false, error: "Worker changed since the response was planned; refusing to answer another session" };
      }
      if (!record.requestId || !record.response) return { ok: false, error: "Missing requestId/response" };
      await this.syncWorkerPermissions(record.workerAgentId);
      check();
      const request = this.store.get().tickets.find((item) => item.id === ticket.id)?.pendingRequests
        ?.find((item) => item.id === record.requestId);
      // 人工已答复或崩溃前已经成功发送:幂等完成,不重发或误发给另一个请求。
      if (!request) {
        await this.workerPermissionResolved(record.workerAgentId);
        return { ok: true };
      }
      // 纵深防御(含升级前落盘的旧记录):Router 的批准永不发出,请求留给人确认。
      if (!routerMayRespond(request, record.response)) {
        console.warn(`[superagent] dropped a Router approval of ${request.kind} request ${request.id}; it needs the human's confirmation`);
        await this.notifyThread(record.threadId, this.approvalNotice(ticket, request), {
          outcome: "reply", ticketId: ticket.id, workerApprovalNotice: true,
          rationale: `blocked Router approval of ${request.kind} request ${request.id}: only the human can approve it`,
        });
        return { ok: true };
      }
      if (record.response.selectedActionId) {
        const actions = request.actions as { id: string; behavior: string }[] | undefined;
        if (!Array.isArray(actions) || !actions.some((action) => action.id === record.response?.selectedActionId
          && action.behavior === record.response?.behavior)) {
          return { ok: false, error: "selectedActionId must match a request action and its allow/deny behavior" };
        }
      }
      if (request.kind === "question" && record.response.behavior === "allow") {
        const answers = record.response.updatedInput?.answers;
        const validAnswer = (answer: unknown) => typeof answer === "string" ? Boolean(answer.trim())
          : Array.isArray(answer) && answer.length > 0 && answer.every((value) => typeof value === "string" && value.trim());
        if (!answers || typeof answers !== "object" || Array.isArray(answers) || !Object.keys(answers).length
          || !Object.values(answers).every(validAnswer)) {
          return { ok: false, error: "Question responses require nonempty updatedInput.answers keyed by question header" };
        }
        const input = request.input as { questions?: { header?: string; question?: string }[] } | undefined;
        if (Array.isArray(input?.questions) && input.questions.some((question) => {
          const key = question.header || question.question;
          return key && !validAnswer((answers as Record<string, unknown>)[key]);
        })) return { ok: false, error: "Answer every question using its header (question text when no header)" };
      }
      try {
        await paseo.agents.ref(record.workerAgentId).respondToPermission({ requestId: record.requestId, response: record.response });
        await this.workerPermissionResolved(record.workerAgentId);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    if (record.kind === "steer") {
      // 跨线程 steer:目标票据可能属于其他线程(裁决记录仍挂在本线程)。
      return this.applySteer(record.ticketId ?? "", record.text ?? "", record.mode ?? "steer", check);
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
        await this.retryTicket(ticket.id, check);
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
    let modeId: string;
    let thinkingOptionId: string;
    try {
      ({ provider: workerProvider, profile, modeId, thinkingOptionId } = await this.resolveTicketWorker(ticket, state));
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
        modeId,
        thinkingOptionId,
        workingDir,
        isolation: this.settingsValues.workerIsolation,
        instructionFiles: await this.instructionFilesFor(workingDir),
        sharedWorkspace:
          this.settingsValues.workerIsolation === "shared"
            ? await this.sharedWorkspaceFor(workingDir, custom && current.profile ? current.profile : workspaceTitles(DEFAULT_WORKSPACE_TITLE))
            : null,
        background: this.settingsValues.workerBackground,
      };
      const launch = await launchWorker(
        paseo,
        workerProvider,
        current,
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
        clearWorkerRequests(next, target);
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
    const token = Symbol(ticketId);
    this.watchedTickets.set(ticketId, token);
    const agentId = ticket.workerAgentId;
    const attempt = ticket.attempts;
    void (async () => {
      try {
        const result = await this.requirePaseo().agents.ref(agentId).waitForFinish(
          this.settingsValues.workerTimeoutMin * 60_000,
        );
        if (this.watchedTickets.get(ticketId) !== token) return;
        this.watchedTickets.delete(ticketId);
        const current = this.store.get().tickets.find((item) => item.id === ticketId);
        if (!this.primed || current?.workerAgentId !== agentId || current.attempts !== attempt) return;
        // permission 是一次 wait 的返回值,并不继续观察。先上报请求,响应后重新挂观察。
        if (await this.syncWorkerPermissions(agentId)) return;
        if (result.status === "idle") {
          await this.settleTicketRun(ticketId, null);
        } else if (result.status === "error") {
          await this.settleTicketRun(ticketId, result.error ?? "turn failed");
        } else if (result.status === "permission") {
          // 请求已在 hook/人工中解决,当前 wait 的 permission 结果已经过时。
          this.watchTicket(ticketId);
        }
      } catch (error) {
        console.error("[superagent] worker watch failed", error);
        if (this.watchedTickets.get(ticketId) === token) this.watchedTickets.delete(ticketId);
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
    if (ticket.workerAgentId && await this.syncWorkerPermissions(ticket.workerAgentId)) return;
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
      const command = trigger.threadId ? humanApprovalCommand(trigger) : null;
      const imCommand = trigger.threadId ? imRequestCommand(trigger) : null;
      await this.store.update((next) => {
        const target = next.triggers.find((t) => t.id === trigger.id);
        if (target?.note === QUEUED_BEFORE_START) target.note = null;
        // 启动前排队的批准命令同样由引擎执行,不交 Router 评估。
        if (target && (command || imCommand)) {
          target.status = "delivered";
          target.note = "approval command";
        }
      });
      if (command || imCommand) {
        const target = this.store.get().triggers.find((t) => t.id === trigger.id);
        if (target && imCommand) await this.executeImRequest(target, imCommand);
        else if (target && command) await this.executeApprovalCommand(target, command);
        continue;
      }
      if (trigger.context || !trigger.threadId) continue;
      const direct = this.subscribedTickets(this.store.get(), trigger.threadId).filter((ticket) => ticket.workerAgentId);
      if (direct.length > 0) await this.deliverDirect({ ...trigger, note: null }, direct);
    }
  }

  private async watchdogTick(): Promise<void> {
    if (!this.primed || !this.paseo || this.watchdogInFlight) return;
    this.watchdogInFlight = true;
    try {
      const note = await this.reconcile();
      this.lastWatchdogAt = new Date().toISOString();
      this.lastWatchdogNote = note;
      // LLM 巡检按自己的间隔走,不阻塞程序对账。
      void this.maybePatrol().catch((error) => {
        console.error("[superagent] watchdog patrol failed", error);
      });
    } finally { this.watchdogInFlight = false; }
  }

  /**
   * Persist IM notices before delivery, using the thread's original return destination.
   * Errors default to an "error" row; human-facing notices (approval requests and results) are
   * recorded as a reply so the chat page shows the full text.
   */
  private prepareImDelivery(decision: Decision, origin: TriggerOrigin, text: string, workerRequest?: ImDelivery["workerRequest"]): ImDelivery {
    return {
      id: `im-${decision.id}`, threadId: decision.threadId, origin, workerRequest,
      parts: splitImReply(text, this.settingsValues.imReplyMaxChars), nextPart: 0,
      status: "pending", sentMessageIds: [], createdAt: decision.createdAt, updatedAt: decision.createdAt,
    };
  }

  private async notifyThread(
    threadId: string,
    text: string,
    options: { outcome?: "error" | "reply"; ticketId?: string | null; rationale?: string; triggerIds?: string[];
      workerApprovalNotice?: true; origin?: TriggerOrigin; workerRequest?: ImDelivery["workerRequest"] } = {},
  ): Promise<void> {
    const state = this.store.get();
    const source = state.triggers.filter((t) => t.threadId === threadId && t.status !== "filtered" && (t.origin || t.replyToAgentId))
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))[0];
    const decision = options.outcome === "reply"
      ? newDecision(threadId, options.triggerIds ?? [], "reply", {
        reply: text, rationale: options.rationale ?? null, ticketId: options.ticketId ?? null,
        workerApprovalNotice: options.workerApprovalNotice,
      })
      : newDecision(threadId, options.triggerIds ?? [], "error", { rationale: text, ticketId: options.ticketId ?? null });
    const origin = options.origin ?? source?.origin;
    const delivery = origin ? this.prepareImDelivery(decision, origin, text, options.workerRequest) : null;
    await this.store.update((next) => {
      next.decisions.push(decision);
      if (delivery) next.imDeliveries.push(delivery);
    });
    if (delivery) void this.sendImDelivery(delivery.id);
    else if (source?.replyToAgentId) await bounded(() => this.requirePaseo().agents.ref(source.replyToAgentId!).send(text), "engine notice")
      .catch((error) => console.error("[superagent] notice failed", error));
  }

  private threadHasPendingWork(threadId: string): boolean {
    const state = this.store.get();
    return this.evalRuns.has(threadId) || this.currentEvalThread === threadId || this.evalQueued.has(threadId) || this.batchTimers.has(threadId)
      || state.triggers.some((t) => t.threadId === threadId && t.status === "pending")
      || state.pendingActions.some((a) => a.threadId === threadId)
      || state.imDeliveries.some((d) => d.threadId === threadId && d.status !== "sent");
  }

  private canExpireThread(threadId: string, cutoff: number, daily: boolean): boolean {
    const state = this.store.get();
    const thread = state.threads.find((t) => t.id === threadId);
    if (!thread || thread.state !== "active" || this.threadHasPendingWork(threadId)) return false;
    if (!daily && Date.parse(thread.lastActivityAt ?? thread.updatedAt) > cutoff) return false;
    return !state.tickets.some((ticket) => {
      if (ticket.threadId !== threadId && !followsOf(ticket).includes(threadId)) return false;
      return ["pending", "launching", "running"].includes(ticket.status) || Boolean(ticket.pendingRequests?.length)
        || ticket.retireRequested || (!daily && ticket.status === "waiting")
        || (ticket.threadId === threadId && followsOf(ticket).some((id) => state.threads.some((other) => other.id === id && other.state === "active")));
    });
  }

  private touchThreads(state: SuperagentState, threadIds: string[], at: string): void {
    for (const id of threadIds) {
      const thread = state.threads.find((t) => t.id === id);
      if (thread && Date.parse(at) > Date.parse(thread.lastActivityAt ?? thread.updatedAt)) thread.lastActivityAt = at;
    }
  }

  /** Waiting workers have a separate lease; changing a subscription does not keep a thread alive forever. */
  private async expireIdleWorker(ticketId: string): Promise<void> {
    if (this.retiringTickets.has(ticketId)) return;
    const state = this.store.get();
    const ticket = state.tickets.find((t) => t.id === ticketId);
    if (!ticket?.workerAgentId) return;
    const cutoff = this.now().getTime() - this.settingsValues.workerIdleTimeoutMin * 60_000;
    const eligible = () => !this.sendingWorkers.has(ticketId) && (ticket.retireRequested || (ticket.status === "waiting" && !ticket.pendingRequests?.length
      && Date.parse(ticket.updatedAt) <= cutoff
      && ![ticket.threadId, ...followsOf(ticket)].some((id) => this.threadHasPendingWork(id))));
    if (!eligible()) return;
    this.retiringTickets.add(ticketId);
    const agentId = ticket.workerAgentId;
    try {
      const live = await bounded(() => this.requirePaseo().agents.ref(agentId).refresh(), "idle Worker refresh");
      if (live?.agent.updatedAt && !ticket.retireRequested && Date.parse(live.agent.updatedAt) > Date.parse(ticket.updatedAt)) {
        const at = live.agent.updatedAt;
        await this.store.update((next) => {
          ticket.updatedAt = at;
          this.touchThreads(next, [ticket.threadId, ...followsOf(ticket)], at);
        });
      }
      if (!eligible() || ticket.workerAgentId !== agentId) return;
      if (live && !live.agent.archivedAt && (live.agent.status === "running" || live.agent.status === "initializing" || live.agent.pendingPermissions?.length)) return;
      // Paseo 0.16 reports shells and monitors a Worker left running after its turn: it is not idle
      // yet, so expiry waits. A retirement already recorded before a restart still finishes.
      if (live && !live.agent.archivedAt && !ticket.retireRequested && (live.agent.backgroundWork?.count ?? 0) > 0) return;
      // The retirement intent survives reloads. No future intake may revive this Worker.
      await this.store.update(() => {
        ticket.status = "completed";
        ticket.subscribed = false;
        ticket.follows = [];
        ticket.retireRequested = true;
      });
      await bounded(() => this.requirePaseo().agents.ref(agentId).archive(), "idle Worker archive");
      if (ticket.ownsWorkspace && ticket.workspaceId) {
        const workspaceId = ticket.workspaceId;
        await bounded(() => this.requirePaseo().workspaces.ref(workspaceId).archive(), "idle Worker workspace archive");
      }
      await this.store.update(() => {
        if (ticket.workerAgentId !== agentId) return;
        ticket.workerAgentId = null;
        if (ticket.ownsWorkspace) ticket.workspaceId = null;
        ticket.retireRequested = false;
      });
    } catch (error) {
      console.error("[superagent] idle Worker retirement failed", error);
    } finally { this.retiringTickets.delete(ticketId); }
  }

  private async remindRequestWait(ticketId: string): Promise<void> {
    const ticket = this.store.get().tickets.find((t) => t.id === ticketId);
    if (!ticket?.pendingRequests?.length || ticket.requestWaitNotifiedAt) return;
    const since = ticket.requestWaitSince ?? ticket.updatedAt;
    if (this.now().getTime() - Date.parse(since) < 24 * 60 * 60_000) return;
    await this.store.update(() => { ticket.requestWaitNotifiedAt = this.now().toISOString(); });
    await this.notifyThread(ticket.threadId, t("server.engine.waitingTooLong", { title: ticket.title }));
  }

  // ------------------------------------------------------- LLM watchdog

  /** 到点(或 force)且设置开启时跑一次巡检;失败也记下时间,下个间隔再试,不在 15s 节奏里重试。 */
  async maybePatrol(force = false): Promise<void> {
    await this.store.ready;
    await this.settingsReady;
    if (!this.settingsValues.watchdogEnabled || !this.primed || !this.paseo || this.patrolInFlight) return;
    const last = this.store.get().kv.watchdog?.lastRunAt;
    const due = !last || Date.now() - Date.parse(last) >= this.settingsValues.watchdogIntervalMin * 60_000;
    if (!force && !due) return;
    const run = new Deadline(WATCHDOG_RUN_TIMEOUT_MS, "Watchdog patrol");
    this.patrolRun = run;
    this.patrolInFlight = true;
    this.markChanged();
    try {
      await run.wait(() => this.runPatrol(run));
    } catch (error) {
      if (this.primed) {
        const message = truncate(error instanceof Error ? error.message : String(error), 400);
        await this.updateWatchdogState({ lastRunAt: this.now().toISOString(), lastError: message, lastActions: 0, inference: undefined });
      }
      throw error;
    } finally {
      run.cancel();
      this.patrolRun = null;
      this.patrolInFlight = false;
      this.markChanged();
    }
  }

  private async updateWatchdogState(patch: Partial<WatchdogState>): Promise<void> {
    await this.store.update((next) => {
      const current = next.kv.watchdog ?? { lastActions: 0, seen: {} };
      next.kv.watchdog = { ...current, ...patch, seen: patch.seen ?? current.seen ?? {} };
    });
  }

  private async runPatrol(run: Deadline): Promise<void> {
    const now = this.now();
    const state = this.store.get();
    const tickets = new Map(state.tickets.map((ticket) => [ticket.id, {
      status: ticket.status, workerAgentId: ticket.workerAgentId, attempts: ticket.attempts, updatedAt: ticket.updatedAt,
    }]));
    const threads = new Map(state.threads.filter((thread) => thread.state === "active").map((thread) => [thread.id, {
      updatedAt: thread.updatedAt, evalRetry: thread.evalRetry,
    }]));
    const { digest, seen } = await this.collectPatrolDigest(now, run);
    run.check();
    if (digest.tickets.every((ticket) => ticket.parked) && digest.health.length === 0) {
      const parked = digest.tickets.length;
      const lastSummary = parked > 0 ? `nothing to patrol: ${parked} parked waiting ticket(s)` : "nothing to patrol";
      await this.updateWatchdogState({ lastRunAt: now.toISOString(), lastSummary, lastError: null, lastActions: 0, seen, inference: undefined });
      return;
    }
    const config = this.inferenceConfig("watchdog");
    const parsed = await runInference({
      config, instructions: composeWatchdogInstructions(), context: composePatrolPrompt(digest, null),
      recall: this.inferenceRecall(), parse: parseWatchdogVerdict,
      repair: (error) => `The verdict could not be parsed: ${error}
Return the full patrol JSON with summary and actions.`,
      deadline: run,
    }, this.inferenceRequest);
    run.check();
    if ("error" in parsed) {
      await this.updateWatchdogState({ provider: config.model, lastRunAt: now.toISOString(),
        lastError: `unparsed: ${truncate(parsed.error, 300)}`, lastActions: 0, inference: parsed.trace });
      return;
    }
    const executed = await this.executeWatchdogActions(parsed.verdict.actions, run, (thread, ticket) => {
      const prior = ticket ? tickets.get(ticket.id) : null;
      const priorThread = threads.get(thread.id);
      return Boolean(priorThread && thread.state === "active" && (ticket
        ? prior && ticket.status === prior.status && ticket.workerAgentId === prior.workerAgentId
          && ticket.attempts === prior.attempts && ticket.updatedAt === prior.updatedAt
        : thread.updatedAt === priorThread.updatedAt && isDeepStrictEqual(thread.evalRetry, priorThread.evalRetry)));
    });
    run.check();
    await this.updateWatchdogState({
      provider: config.model, lastRunAt: now.toISOString(), lastSummary: truncate(parsed.verdict.summary, 300),
      lastError: null, lastActions: executed, seen, inference: parsed.trace,
    });
  }

  /** 巡检摘要:未完结票据的会话状态与进展增量,加引擎健康状况。 */
  private async collectPatrolDigest(now: Date, run: Deadline): Promise<{ digest: PatrolDigest; seen: WatchdogState["seen"] }> {
    const paseo = this.requirePaseo();
    const state = this.store.get();
    const previous = state.kv.watchdog?.seen ?? {};
    const seen: WatchdogState["seen"] = {};
    const minutes = (from: number) => Math.max(0, Math.round((now.getTime() - from) / 60_000));
    // 待命票据排在执行中的之后:对话不关它们就一直累积,不能把新票据挤出摘要上限。
    const unfinished = state.tickets
      .filter((t) => !TERMINAL_TICKET_STATUSES.includes(t.status))
      .sort((a, b) => Number(a.status === "waiting") - Number(b.status === "waiting") || a.createdAt.localeCompare(b.createdAt))
      .slice(0, 12);
    const tickets: PatrolTicket[] = [];
    for (const ticket of unfinished) {
      run.check();
      let sessionStatus: string | null = null;
      let pendingPermissions = 0;
      let pendingRequests: readonly unknown[] = [];
      let latestSeq: number | null = null;
      let latestAt: number | null = null;
      let latestMessage: string | null = null;
      if (ticket.workerAgentId) {
        try {
          const ref = paseo.agents.ref(ticket.workerAgentId);
          const snapshot = await run.wait(() => bounded(() => ref.refresh(), "Patrol worker refresh"));
          sessionStatus = snapshot?.agent.status ?? null;
          pendingPermissions = snapshot?.agent.pendingPermissions?.length ?? 0;
          pendingRequests = snapshot?.agent.pendingPermissions ?? [];
          const timeline = await run.wait(() => bounded(() => ref.timeline.refetch({ direction: "tail", limit: 30 }), "Patrol worker timeline"));
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
          run.check();
          console.error("[superagent] watchdog could not read worker", ticket.workerAgentId, error);
        }
      }
      const before = previous[ticket.id];
      if (latestSeq !== null) {
        const changed = !before || before.seq !== latestSeq;
        seen[ticket.id] = { seq: latestSeq, at: changed ? new Date(latestAt ?? now.getTime()).toISOString() : before.at };
      }
      const thread = state.threads.find((t) => t.id === ticket.threadId);
      // 首次见到且读得到时间线的待命票据巡一次建立基线;之后无新动静即视为待命。
      const parked = ticket.status === "waiting" && pendingPermissions === 0
        && sessionStatus !== "running" && sessionStatus !== "initializing"
        && (latestSeq === null || before?.seq === latestSeq);
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
        pendingRequests,
        newEntries: before && latestSeq !== null ? Math.max(0, latestSeq - before.seq) : null,
        quietMin: latestAt !== null ? minutes(latestAt) : seen[ticket.id] ? minutes(Date.parse(seen[ticket.id].at)) : null,
        latestMessage,
        parked,
      });
    }
    return {
      digest: {
        at: now.toISOString(), intervalMin: this.settingsValues.watchdogIntervalMin, tickets, ...this.healthLines(state, now),
        ...(state.kv.watchdog?.lastRunAt ? { previousPatrol: {
          at: state.kv.watchdog.lastRunAt, summary: state.kv.watchdog.lastSummary ?? null, error: state.kv.watchdog.lastError ?? null,
        } } : {}),
        recentInterventions: state.decisions.filter((decision) => decision.outcome === "watchdog")
          .slice(-6).reverse().map((decision) => ({
            at: decision.createdAt, ticketId: decision.ticketId ?? null, threadId: decision.threadId, note: decision.rationale ?? "",
          })),
      },
      seen,
    };
  }

  /**
   * 引擎健康的单行说明。health:评估熔断/连续出错、久候的触发、投递失败、积压动作、近期失败票据——
   * 看门狗可能要介入的异常;notes:Router 已释放这类会自愈、看门狗无动作可做的状态,只作上下文。
   */
  private healthLines(state: SuperagentState, now: Date): { health: string[]; notes: string[] } {
    const lines: string[] = [];
    const notes: string[] = [];
    const ago = (iso: string) => Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60_000));
    const label = (threadId: string) => {
      const thread = state.threads.find((t) => t.id === threadId);
      return thread ? `thread ${thread.id} "${truncate(thread.title, 60)}"` : `thread ${threadId}`;
    };
    for (const thread of state.threads.filter((t) => t.state === "active")) {
      const pending = state.triggers.filter((t) => t.threadId === thread.id && t.status === "pending");
      const unparsed = this.evalFailures.get(thread.id) ?? thread.evalRetry?.unparsed ?? 0;
      const errors = this.evalErrors.get(thread.id) ?? thread.evalRetry?.errors ?? 0;
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
    // 失败记录不随裁剪清除(界面可从断点补发),只在近两个间隔内报给看门狗,免得一条旧失败让它永远空转。
    const window = 2 * this.settingsValues.watchdogIntervalMin;
    for (const delivery of state.imDeliveries.filter((d) => d.status === "failed" && ago(d.updatedAt) <= window)) {
      lines.push(`IM reply ${delivery.id} (${delivery.origin.channel}) failed ${ago(delivery.updatedAt)} min ago at part ${delivery.nextPart + 1}/${delivery.parts.length} on ${label(delivery.threadId)}`);
    }
    if (state.pendingActions.length > 0) {
      lines.push(`${state.pendingActions.length} Router action(s) still waiting to execute (max attempts ${MAX_ACTION_ATTEMPTS})`);
    }
    for (const ticket of state.tickets.filter((t) => t.status === "failed" && ago(t.updatedAt) <= window)) {
      lines.push(`ticket ${ticket.id} "${truncate(ticket.title, 60)}" failed ${ago(ticket.updatedAt)} min ago: ${truncate(ticket.lastError ?? "unknown error", 200)}`);
    }
    return { health: lines, notes };
  }

  /** 执行看门狗动作:每个动作一条 watchdog 裁决留痕;取消/上报经引擎触发交 Router 告知人。 */
  private async executeWatchdogActions(
    actions: WatchdogAction[], run: Deadline, current: (thread: Thread, ticket?: Ticket) => boolean,
  ): Promise<number> {
    let executed = 0;
    for (const action of actions) {
      run.check();
      const state = this.store.get();
      const ticket = "ticketId" in action && action.ticketId ? state.tickets.find((t) => t.id === action.ticketId) : undefined;
      const threadId = ("threadId" in action && action.threadId) || ticket?.threadId;
      const thread = state.threads.find((item) => item.id === threadId);
      if (!thread || ("ticketId" in action && action.ticketId && !ticket)
        || (ticket && ticket.threadId !== thread.id && !followsOf(ticket).includes(thread.id))
        || !current(thread, ticket)) {
        console.warn(`[superagent] watchdog ${action.action} skipped: unknown or changed target`);
        continue;
      }
      let note: string;
      try {
        if (action.action === "nudge" || action.action === "interrupt") {
          if (!ticket) continue;
          const outcome = await this.applySteer(ticket.id, `[watchdog] ${action.text}`, action.action === "interrupt" ? "interrupt" : "steer", () => run.check());
          if (!outcome.ok) throw new Error(outcome.error);
          note = `${action.action}: ${action.text}`;
        } else if (action.action === "cancel") {
          if (!ticket) continue;
          await this.cancelTicket(ticket.id);
          note = `cancel: ${action.reason}`;
          await this.enqueueEngineNote(thread.id, `[watchdog] canceled ticket ${ticket.id} "${ticket.title}": ${action.reason}`);
        } else if (action.action === "retry") {
          if (!ticket) continue;
          await this.retryTicket(ticket.id, () => run.check());
          note = `retry${action.reason ? `: ${action.reason}` : ""}`;
        } else if (action.action === "reeval") {
          await this.forceEval(thread.id);
          note = `reeval${action.reason ? `: ${action.reason}` : ""}`;
        } else {
          note = `escalate: ${action.text}`;
          await this.enqueueEngineNote(thread.id, `[watchdog]${ticket ? ` ticket ${ticket.id} "${ticket.title}":` : ""} ${action.text}`);
        }
      } catch (error) {
        run.check();
        note = `${action.action} failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      run.check();
      executed += 1;
      await this.store.update((next) => {
        next.decisions.push(newDecision(thread.id, [], "watchdog", { ticketId: ticket?.id ?? null, rationale: truncate(note, 500) }));
      });
    }
    return executed;
  }

  /** 引擎以触发形式把看门狗的结论交给线程的 Router,由 Router 统一对人表述。 */
  private async enqueueEngineNote(threadId: string, text: string): Promise<void> {
    const thread = this.store.get().threads.find((t) => t.id === threadId);
    if (!thread || thread.state !== "active") return;
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
    if (state.kv.routerAgentId === agentId || state.threads.some((t) => t.router?.agentId === agentId)) return "router";
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
      } else if (["running", "waiting"].includes(ticket.status) && ticket.workerAgentId) {
        try {
          const handle = paseo.agents.ref(ticket.workerAgentId);
          // 权限/问题优先于 idle 与硬超时。支持错过 hook、插件重载和非阻塞问题。
          if (await this.syncWorkerPermissions(ticket.workerAgentId)) {
            await this.remindRequestWait(ticket.id);
            continue;
          }
          if (ticket.status !== "running") continue;
          const refetched = await bounded(() => handle.refresh(), "Worker refresh");
          if (refetched?.agent.pendingPermissions?.length) {
            await this.syncWorkerPermissions(ticket.workerAgentId);
            continue;
          }
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
              await bounded(() => handle.reload(), "Worker interrupt");
            } catch (error) {
              console.error("[superagent] worker timeout reload failed", error);
            }
            await this.settleTicketRun(ticket.id, `exceeded ${this.settingsValues.workerTimeoutMin}min runtime`);
          } else if (status === "running") {
            this.watchTicket(ticket.id);
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
      // 解析失败三次暂停;基础设施异常按持久化的次数上限和退避时间重查。
      if ((this.evalFailures.get(threadId) ?? thread.evalRetry?.unparsed ?? 0) >= 3) continue;
      if ((this.evalErrors.get(threadId) ?? thread.evalRetry?.errors ?? 0) >= MAX_EVAL_ERRORS) continue;
      if (thread.evalRetry?.nextAt && Date.parse(thread.evalRetry.nextAt) > Date.now()) continue;
      const active =
        this.batchTimers.has(threadId) ||
        this.evalQueued.has(threadId) ||
        (this.evalInFlight && this.currentEvalThread === threadId);
      if (!active) {
        acted += 1;
        this.scheduleEval(threadId, 0);
      }
    }

    if (this.settingsValues.inferenceBaseUrl && this.settingsValues.routerModel) await this.retireLegacyDecisionAgents();
    for (const ticket of this.store.get().tickets) await this.expireIdleWorker(ticket.id);

    // Daily IM rollover and the general idle lease share the same safety checks.
    const cutoff = this.now().getTime() - this.settingsValues.threadIdleTimeoutMin * 60_000;
    for (const thread of this.store.get().threads) {
      const daily = Boolean(thread.imDay && thread.imDay < imDay(this.now()));
      if (!this.canExpireThread(thread.id, cutoff, daily)) continue;
      const ids = this.store.get().tickets.filter((t) => t.threadId === thread.id).map((t) => t.workerAgentId)
        .filter((id): id is string => Boolean(id));
      let busy = false;
      for (const id of ids) {
        try {
          const live = await bounded(() => paseo.agents.ref(id).refresh(), "thread expiry refresh");
          if (live?.agent.updatedAt && !live.agent.archivedAt) {
            const at = live.agent.updatedAt;
            await this.store.update((next) => { this.touchThreads(next, [thread.id], at); });
          }
          if (live && !live.agent.archivedAt && (live.agent.status === "running" || live.agent.status === "initializing" || live.agent.pendingPermissions?.length)) {
            busy = true;
            break;
          }
        } catch { busy = true; break; }
      }
      // Intake, reports and cross-thread subscriptions may change while the RPCs above are pending.
      if (!busy && this.canExpireThread(thread.id, cutoff, daily)) { await this.closeThread(thread.id); acted++; }
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
    await this.store.update((next) => {
      const thread = next.threads.find((t) => t.id === threadId);
      if (thread) thread.evalRetry = { errors: 0, unparsed: 0, nextAt: null };
    });
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
      clearWorkerRequests(next, target);
      target.subscribed = false;
      target.updatedAt = new Date().toISOString();
    });
    this.watchedTickets.delete(ticketId);
    await retireWorker(paseo, ticket, true);
  }

  async retryTicket(ticketId: string, check: () => void = () => {}): Promise<void> {
    const paseo = this.requirePaseo();
    const state = this.store.get();
    const ticket = state.tickets.find((t) => t.id === ticketId);
    if (ticket?.retireRequested || this.retiringTickets.has(ticketId)) throw new Error("Worker is retiring; retry after cleanup completes");
    if (!ticket) throw new Error("ticket not found");
    if (!["failed", "canceled", "completed"].includes(ticket.status)) {
      throw new Error(`ticket is ${ticket.status}; only failed/canceled/completed tickets retry`);
    }
    await this.store.update((next) => {
      const target = next.tickets.find((t) => t.id === ticketId);
      if (!target) return;
      target.status = "pending";
      target.attempts = 0;
      clearWorkerRequests(next, target);
      target.report = null;
      target.lastError = null;
      target.subscribed = true;
      target.updatedAt = new Date().toISOString();
    });
    // 旧 Worker 与其独占工作区随重试作废:先落盘重置再回收,旧实例不会被新票据引用。
    this.watchedTickets.delete(ticketId);
    if (ticket.workerAgentId) await retireWorker(paseo, ticket, true);
    check();
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

  private async retireLegacyDecisionAgents(): Promise<void> {
    const state = this.store.get();
    const ids = new Set([state.kv.routerAgentId, state.kv.watchdog?.agentId, ...state.threads.map((thread) => thread.router?.agentId)]);
    for (const id of ids) {
      if (!id) continue;
      const handle = this.requirePaseo().agents.ref(id);
      const deadline = new Deadline(30_000, "Legacy decision agent cleanup");
      try {
        const live = await deadline.wait(() => handle.refresh());
        if (live && !live.agent.archivedAt) {
          if (["running", "initializing"].includes(live.agent.status) || live.agent.pendingPermissions?.length) continue;
          await deadline.wait(() => detachRoleChildren(this.requirePaseo(), id, () => deadline.check()));
          const latest = await deadline.wait(() => handle.refresh());
          if (latest && !latest.agent.archivedAt) {
            if (["running", "initializing"].includes(latest.agent.status) || latest.agent.pendingPermissions?.length) continue;
            await deadline.wait(() => handle.archive());
          }
        }
        await this.store.update((next) => {
          for (const thread of next.threads) {
            if (thread.router?.agentId === id) thread.router = null;
          }
          if (next.kv.routerAgentId === id) next.kv.routerAgentId = null;
          if (next.kv.watchdog?.agentId === id) next.kv.watchdog = { ...next.kv.watchdog, agentId: null };
        });
      } catch (error) {
        console.error("[superagent] legacy decision agent cleanup failed", error);
      } finally {
        deadline.cancel();
      }
    }
  }

  private inferenceConfig(role: "router" | "watchdog"): InferenceConfig {
    const settings = this.settingsValues;
    return {
      baseUrl: settings.inferenceBaseUrl,
      model: (role === "watchdog" ? settings.watchdogModel : "") || settings.routerModel,
      apiKey: process.env.SUPERAGENT_INFERENCE_API_KEY?.trim(),
    };
  }

  private inferenceRecall(threadId?: string): Recall {
    return {
      list: () => this.listThreads(),
      read: (id) => this.readRecord(id),
      search: (query) => this.searchRecords(query, threadId),
    };
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
          clearWorkerRequests(next, ticket);
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
        ticket.pendingRequests?.length ? `\n## Pending Worker requests\n${JSON.stringify(ticket.pendingRequests, null, 2)}` : null,
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
        thread.imDay ? `IM day: ${thread.imDay} (Asia/Shanghai); conversation: ${thread.imConversationKey}` : null,
        thread.routerMemory?.length ? `thread memory:
${JSON.stringify(thread.routerMemory)}` : null,
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
  async searchRecords(query: string, callerThreadId?: string): Promise<string> {
    await this.store.ready;
    const state = this.store.get();
    // 调用方 Router 本线程的待评估触发与线程本身已在提示词里,命中只会误导模型继续搜。
    const own = callerThreadId ? state.threads.find((t) => t.id === callerThreadId) ?? null : null;
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
      if (own && trigger.threadId === own.id && trigger.status === "pending") continue;
      if (!matches(joined(trigger.text, trigger.note))) continue;
      hits.push({
        at: trigger.receivedAt,
        line: `- [${trigger.id} trigger ${trigger.kind} ${trigger.status}] thread=${trigger.threadId ?? "unknown"} ${trigger.sender}: ${excerptOf(trigger.text, trigger.note)}`,
      });
    }
    for (const ticket of state.tickets) {
      if (!matches(joined(ticket.title, ticket.mandate, ticket.report, ticket.lastError))) continue;
      hits.push({
        at: ticket.updatedAt,
        line: `- [${ticket.id} ticket ${ticket.status}] thread=${ticket.threadId} "${ticket.title}": ${excerptOf(ticket.report, ticket.mandate, ticket.lastError, ticket.title)}`,
      });
    }
    for (const thread of state.threads) {
      if (thread === own) continue;
      if (!matches(joined(thread.title, thread.summary, thread.imDay, thread.imConversationKey))) continue;
      hits.push({
        at: thread.updatedAt,
        line: `- [${thread.id} thread ${thread.state}]${thread.imDay ? ` day=${thread.imDay}` : ""} "${thread.title}": ${excerptOf(thread.summary, thread.title)}`,
      });
    }
    for (const decision of state.decisions) {
      if (!matches(joined(decision.reply, decision.rationale))) continue;
      hits.push({
        at: decision.createdAt,
        line: `- [${decision.id} decision ${decision.outcome}] thread=${decision.threadId} ${excerptOf(decision.reply, decision.rationale)}`,
      });
    }
    hits.sort((a, b) => b.at.localeCompare(a.at));
    if (hits.length === 0) {
      return `No records match all of: ${terms.join(" ")}. No such record exists, and rephrasing rarely finds one: ` +
        "retry at most once with a single distinctive keyword, otherwise treat the request as new and decide from the prompt.";
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
      lines.push(`- thread ${thread.id} "${thread.title}"${thread.imDay ? ` day=${thread.imDay}` : ""}${pending > 0 ? ` pendingTriggers=${pending}` : ""}`);
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
          router: null,
          latestResult: threadResult(thread, state),
          lastDecision: lastDecision ? { outcome: lastDecision.outcome, createdAt: lastDecision.createdAt } : null,
          pendingTriggers: state.triggers.filter(
            (t) => t.threadId === thread.id && t.status === "pending",
          ).length,
          ticketCounts,
        };
      });
    return {
      revision: this.revision,
      configured: Boolean(settings.workingDir),
      inferenceConfigured: Boolean(settings.inferenceBaseUrl && settings.routerModel),
      workingDir: settings.workingDir,
      workingDirIssue: this.cachedWorkingDirIssue(),
      routerAgentId: null,
      routerProvider: settings.routerModel || null,
      workerProvider: state.kv.workerProvider || settings.workerProvider || null,
      workerProfiles: settings.workerProfiles.map(({ name, provider, modeId, thinkingOptionId, description, workingDir }) => ({
        name, provider, modeId: modeId ?? "", thinkingOptionId: thinkingOptionId ?? "", description, workingDir: workingDir ?? "",
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
          preview: deliveryPreview(parts),
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
          agentId: null,
          inference: state.kv.watchdog?.inference,
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
   * 后台与普通工作区分别登记(目录 → id)和缓存,避免角色混用;失效时按标题找回或重建。
   * 串行链防止并发启动的 Ticket 为同一目录重复建区。
   */
  private sharedWorkspaceFor(dir: string, title: string | readonly string[], background = false): Promise<PaseoWorkspaceHandle> {
    const directory = resolve(dir);
    const key = `${background ? "background\u0000" : ""}${directory}`;
    const registry = background ? "backgroundWorkspaces" : "sharedWorkspaces";
    const ensure = this.workspaceChain.then(() => {
      const deadline = new Deadline(30_000, "shared workspace lookup");
      return deadline.wait(async () => {
        const cached = this.sharedWorkspaceCache.get(key);
        if (cached) {
          const descriptor = await cached.refresh().catch(() => null);
          deadline.check();
          if (descriptor && !descriptor.archivingAt && resolve(descriptor.workspaceDirectory) === directory
            && (descriptor.background === true) === background) return cached;
          this.sharedWorkspaceCache.delete(key);
        }
        const remembered = this.store.get().kv[registry]?.[directory];
        const { handle } = await ensureSharedWorkspace(this.requirePaseo(), remembered, directory, title, background, () => deadline.check());
        deadline.check();
        this.sharedWorkspaceCache.set(key, handle);
        if (remembered !== handle.id) {
          await this.store.update((next) => {
            next.kv[registry] = { ...next.kv[registry], [directory]: handle.id };
          });
        }
        return handle;
      });
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
  ): Promise<{ provider: string; profile: string | null; modeId: string; thinkingOptionId: string }> {
    const name = ticket.profile;
    if (name) {
      const profile = this.settingsValues.workerProfiles.find((candidate) => candidate.name === name);
      if (profile) {
        const label = `worker profile "${name}"`;
        const provider = await this.validateConfiguredProvider(label, profile.provider);
        const modeId = await this.validateWorkerMode(label, provider, profile.modeId);
        const thinkingOptionId = await this.validateWorkerThinkingOption(label, provider, profile.thinkingOptionId);
        return { provider, profile: name, modeId, thinkingOptionId };
      }
      console.warn(`[superagent] worker profile "${name}" of ticket ${ticket.id} is no longer configured; using the default worker`);
    }
    const provider = await this.resolveWorkerProvider(state.kv.workerProvider);
    const modeId = await this.validateWorkerMode("worker", provider, this.settingsValues.workerModeId);
    const thinkingOptionId = await this.validateWorkerThinkingOption("worker", provider, this.settingsValues.workerThinkingOptionId);
    return { provider, profile: null, modeId, thinkingOptionId };
  }

  private async validateWorkerMode(role: string, provider: string, configured: string | undefined): Promise<string> {
    const modeId = configured?.trim() ?? "";
    if (!modeId) return "";
    // pi provider 不上报模式:模式来自 pi-permission-modes 扩展,启动时经
    // PI_PERMISSION_MODE 传入。扩展未安装(或模式已被删掉)时回退 Paseo 默认。
    if (isPiProviderSelection(provider)) {
      const pi = readPiPermissionModes();
      if (!pi.available) return "";
      if (pi.modes.some((mode) => mode.id === modeId)) return modeId;
      console.warn(
        `[superagent] ${role} mode "${modeId}" is not defined by pi-permission-modes; ` +
          `using pi's default mode${pi.defaultModeId ? ` ("${pi.defaultModeId}")` : ""}`,
      );
      return "";
    }
    let entries;
    try {
      const paseo = this.requirePaseo();
      await paseo.providers.waitForReady({ timeoutMs: 20_000 }).catch(() => undefined);
      entries = (await paseo.providers.snapshot()).entries;
    } catch (error) {
      console.error("[superagent] provider snapshot unavailable; using configured mode as-is", error);
      return modeId;
    }
    try {
      validateProviderMode(provider, modeId, entries);
    } catch (error) {
      throw new Error(`${role} mode setting is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
    return modeId;
  }

  private async validateWorkerThinkingOption(role: string, provider: string, configured: string | undefined): Promise<string> {
    const thinkingOptionId = configured?.trim() ?? "";
    if (!thinkingOptionId) return "";
    let entries;
    try {
      const paseo = this.requirePaseo();
      await paseo.providers.waitForReady({ timeoutMs: 20_000 }).catch(() => undefined);
      entries = (await paseo.providers.snapshot()).entries;
    } catch (error) {
      console.error("[superagent] provider snapshot unavailable; using configured thinking option as-is", error);
      return thinkingOptionId;
    }
    try {
      validateProviderThinkingOption(provider, thinkingOptionId, entries);
    } catch (error) {
      throw new Error(`${role} thinking setting is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
    return thinkingOptionId;
  }

  /**
   * provider 解析:显式设置优先,其次沿用已记忆值,最后从 daemon 快照选择。
   */
  private async resolveWorkerProvider(remembered: string | null | undefined): Promise<string> {
    const configured = this.settingsValues.workerProvider.trim();
    if (configured) return this.validateConfiguredProvider("worker", configured);
    if (remembered) return remembered;
    const paseo = this.requirePaseo();
    try {
      await paseo.providers.waitForReady({ timeoutMs: 20_000 }).catch(() => undefined);
      const snapshot = await paseo.providers.snapshot();
      const ready = snapshot.entries.filter((entry) => entry.enabled !== false && entry.status === "ready");
      const pick = ready.find((entry) => PREFERRED_PROVIDERS.includes(entry.provider)) ?? ready[0];
      if (!pick) return "";
      const model = pick.models?.find((m) => m.isDefault) ?? pick.models?.[0];
      return model ? `${pick.provider}/${model.id}` : pick.provider;
    } catch (error) {
      console.error("[superagent] provider discovery failed", error);
      return "";
    }
  }

  /**
   * 用快照校验模型和纠正转义。快照不可用时，将配置交给 Paseo 校验。
   */
  private async validateConfiguredProvider(label: string, configured: string): Promise<string> {
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
      throw new Error(`${label} provider setting "${configured}" is invalid: ${result.error}`);
    }
    if (result.note && !this.providerNotes.has(`${label}:${configured}`)) {
      this.providerNotes.add(`${label}:${configured}`);
      console.warn(`[superagent] ${label} provider: ${result.note}`);
    }
    return result.selection;
  }
}
