import { z } from "zod";
import { ChatTabsSchema } from "./chat-tabs";

/**
 * Superagent 领域模型 —— 对齐《Super-agent 设计探索》的事件驱动编排层,
 * 但全部落在这台 Paseo daemon 的 agent 体系上:
 *
 *   Trigger  外部到达的事件(手动派发 / agent 委派 / worker 汇报)
 *   Thread   同一话题的事件流(订阅的聚集点)
 *   Ticket   一个已立案的工作单元,持有一个 Worker agent
 *   Decision Router 对一批 Trigger 的裁决记录(审计轨迹)
 *
 * 持久化为一个 JSON 文件(见 server/store.ts);所有副作用(创建 agent、发消息)
 * 都发生在状态落盘之后,看门狗负责对账恢复。
 */

/**
 * Router 会话在 Paseo agent 目录里的标签(服务端创建时打上,客户端据此枚举全部
 * Router 会话——引擎记住的 id 之外,状态重置后残留的旧 Router 也算)。
 */
export const ROUTER_AGENT_LABEL = "superagent.role";
export const ROUTER_AGENT_LABEL_VALUE = "router";
/** 同一标签键下的 LLM 看门狗会话(§6):独立于 Router 的巡检 agent。 */
export const WATCHDOG_AGENT_LABEL_VALUE = "watchdog";

export const TRIGGER_KINDS = ["manual", "agent", "report", "engine", "feishu", "qq", "dingtalk", "wecom", "weixin"] as const;
export const TriggerKindSchema = z.enum(TRIGGER_KINDS);
export type TriggerKind = z.infer<typeof TriggerKindSchema>;

/** IM 触发的来源信息:outbox 依此把 Router 答复发回原聊天。 */
export const TriggerOriginSchema = z.object({
  channel: z.enum(["feishu", "qq", "dingtalk", "wecom", "weixin"]),
  /** 会话标识:飞书 chat_id / QQ group_id 或私聊对方 QQ 号 / 钉钉 conversationId / 企微 chatid 或 userid / 微信用户 ID。 */
  chatId: z.string().min(1),
  accountId: z.string().optional(),
  /** 通道专属回复引用:飞书/钉钉/企微消息 id,OneBot 用。 */
  messageId: z.string().nullish(),
  /** 通道专属回复通道:钉钉 sessionWebhook、企微 req_id、微信 context_token。 */
  replyRef: z.string().nullish(),
  senderId: z.string().min(1),
  senderName: z.string().nullish(),
});
export type TriggerOrigin = z.infer<typeof TriggerOriginSchema>;

export const TRIGGER_STATUSES = ["pending", "filtered", "evaluated", "delivered", "failed"] as const;
export type TriggerStatus = (typeof TRIGGER_STATUSES)[number];

export const TriggerSchema = z.object({
  id: z.string().min(1),
  kind: TriggerKindSchema,
  /** 产生者标识:用户名、`agent:<agentId>`、`worker:<ticketId>`。 */
  sender: z.string().min(1),
  /** Thread 关联键( intake 时决定)。 */
  threadKey: z.string().min(1),
  text: z.string(),
  /** 是否为上下文补充(不单独要求行动)——影响 Router 提示词与直通判断。 */
  context: z.boolean().default(false),
  /** agent 委派时,Router 的答复要回投给谁。 */
  replyToAgentId: z.string().nullish(),
  /** IM 触发时,答复要发回的来源聊天。 */
  origin: TriggerOriginSchema.nullish(),
  receivedAt: z.string(),
  status: z.enum(TRIGGER_STATUSES),
  /** fast-path 丢弃原因或投递备注。 */
  note: z.string().nullish(),
  threadId: z.string().nullish(),
  /** 权限通知的关联键:用于去重、撤销已解决的通知,不与普通汇报混淆。 */
  workerRequest: z.object({ ticketId: z.string(), agentId: z.string(), requestId: z.string() }).nullish(),
  /**
   * IM 消息引用(回复)的那条消息(§3.3 Inline):在本地记录里找到时内联其摘要与 ID,
   * 找不到时只保留平台消息 id。text 已截断,全文按 triggerId 回读。
   */
  quote: z.object({
    triggerId: z.string().nullish(),
    sender: z.string().nullish(),
    text: z.string().nullish(),
    messageId: z.string().nullish(),
  }).nullish(),
});
export type Trigger = z.infer<typeof TriggerSchema>;

export const THREAD_STATES = ["active", "closed"] as const;
export type ThreadState = (typeof THREAD_STATES)[number];

/** 最近一次对人的答复/汇报,随线程保留,不依赖 Worker 会话或活动窗口。 */
export const ThreadResultSchema = z.object({
  id: z.string(),
  kind: z.enum(["router_reply", "worker_report"]),
  text: z.string(),
  ticketIds: z.array(z.string()),
  createdAt: z.string(),
});
export type ThreadResult = z.infer<typeof ThreadResultSchema>;

/** 一个 Thread 的 Router 及已送达游标;失败标记在发送前落盘,防崩溃后复用半轮上下文。 */
export const ThreadRouterSchema = z.object({
  agentId: z.string(),
  provider: z.string(),
  configHash: z.string(),
  sessionId: z.string().nullable(),
  initialized: z.boolean().default(false),
  dirty: z.boolean().default(false),
  compactionSeq: z.number().default(0),
  evaluations: z.number().default(0),
  lastUsedAt: z.string().optional(),
  triggerIds: z.array(z.string()).default([]),
});
export type ThreadRouter = z.infer<typeof ThreadRouterSchema>;

export const ThreadSchema = z.object({
  id: z.string().min(1),
  /** 稳定关联键,例如 `manual:<uuid>`、`agent:<agentId>:<slug>`。 */
  key: z.string().min(1),
  title: z.string().min(1),
  state: z.enum(THREAD_STATES),
  /** Router 维护的一句话摘要,供下次评估的上下文存根。 */
  summary: z.string().nullish(),
  latestResult: ThreadResultSchema.nullish(),
  lastActivityAt: z.string().optional(),
  evalRetry: z.object({
    errors: z.number().int().nonnegative().default(0),
    unparsed: z.number().int().nonnegative().default(0),
    nextAt: z.string().nullable().default(null),
  }).optional(),
  router: ThreadRouterSchema.nullish(),
  /** 仅 IM 入站按该日期和渠道会话分流;旧任务的汇报仍回原线程。 */
  imDay: z.string().optional(),
  imConversationKey: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Thread = z.infer<typeof ThreadSchema>;

export const TICKET_STATUSES = [
  "pending",
  "launching",
  "running",
  "waiting",
  "completed",
  "failed",
  "canceled",
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

/** 这些状态的 Ticket 若仍订阅线程,线程后续事件程序直通其 Worker,不过 Router。 */
export const SUBSCRIBED_STATUSES: readonly TicketStatus[] = ["running", "waiting"];
/** 已结束的 Ticket:不再占用 Worker,关闭线程时不会被取消。 */
export const TERMINAL_TICKET_STATUSES: readonly TicketStatus[] = ["completed", "failed", "canceled"];

/** 保留 provider 的问题、选项、命令和动作原文;不在 shared 引入宿主运行时。 */
export const WorkerRequestSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  kind: z.string(),
}).passthrough();
export type WorkerRequest = z.infer<typeof WorkerRequestSchema>;

/** 仅响应本次请求,不支持扩大后续请求的持久授权范围。 */
export const WorkerResponseSchema = z.discriminatedUnion("behavior", [
  z.object({
    behavior: z.literal("allow"),
    selectedActionId: z.string().optional(),
    updatedInput: z.record(z.string(), z.unknown()).optional(),
  }).strict(),
  z.object({
    behavior: z.literal("deny"),
    selectedActionId: z.string().optional(),
    message: z.string().optional(),
    interrupt: z.boolean().optional(),
  }).strict(),
]);
export type WorkerResponse = z.infer<typeof WorkerResponseSchema>;

export const TicketSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  title: z.string().min(1),
  /** 交给 Worker 的任务书。 */
  mandate: z.string(),
  status: z.enum(TICKET_STATUSES),
  workerAgentId: z.string().nullish(),
  pendingRequests: z.array(WorkerRequestSchema).default([]),
  requestWaitSince: z.string().nullish(),
  requestWaitNotifiedAt: z.string().nullish(),
  retireRequested: z.boolean().optional(),
  workspaceId: z.string().nullish(),
  /**
   * 该 Ticket 是否独占 workspaceId 指向的工作区(worktree 隔离 = true;共享隔离的
   * 持久工作区 = false,回收 Ticket 时不得归档)。旧票据为 null,按 false 处理。
   */
  ownsWorkspace: z.boolean().nullish(),
  /** worktree 隔离的 Worker 分支名(评估提示词与 UI 由此告知人去哪审查);shared 隔离为空。 */
  branchName: z.string().nullish(),
  /** Router 为该 Ticket 选的 Worker 档位;空 = 默认 Worker。retry 沿用此档位。 */
  profile: z.string().nullish(),
  /** 当前(或最近一次)Worker 实际使用的 provider/model,启动时按档位解析后记录。 */
  provider: z.string().nullish(),
  /** 当前(或最近一次)Worker 启动时间,看门狗超时判定的基准。 */
  startedAt: z.string().nullish(),
  attempts: z.number().int().nonnegative().default(0),
  /** 本线程(threadId)的后续事件是否直通该 Worker。 */
  subscribed: z.boolean().default(true),
  /**
   * 额外订阅的其他线程(§3.2 多对多):这些线程的后续事件同样直通该 Worker,
   * 汇报也回流到这些线程。由 Router 的 subscribe 动作加入,Worker 可按线程退订。
   */
  follows: z.array(z.string()).default([]),
  /**
   * 投机执行(§3.4):没人明确提出、由 Router 依据主动策略在后台先行尝试的任务。
   * 不订阅线程;汇报首行 DISCARD 时引擎静默丢弃并回收 Worker,否则交 Router 转述。
   */
  speculative: z.boolean().default(false),
  report: z.string().nullish(),
  lastError: z.string().nullish(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Ticket = z.infer<typeof TicketSchema>;

export const DECISION_OUTCOMES = [
  "dispatch",
  "steer",
  "respond",
  "cancel",
  "retry",
  "reply",
  "ignore",
  "stop",
  "subscribe",
  "watchdog",
  "unparsed",
  "error",
] as const;
export type DecisionOutcome = (typeof DECISION_OUTCOMES)[number];

export const DecisionSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  /** 本批裁决覆盖的 Trigger(批处理:一次 LLM 调用吃掉整批)。 */
  triggerIds: z.array(z.string()),
  outcome: z.enum(DECISION_OUTCOMES),
  reply: z.string().nullish(),
  rationale: z.string().nullish(),
  ticketId: z.string().nullish(),
  /** 解析失败时保留的原始回复存根(排障用)。 */
  raw: z.string().nullish(),
  createdAt: z.string(),
});
export type Decision = z.infer<typeof DecisionSchema>;

/** 一次裁决最多包含的动作数:fan-out 上限,防止失控派发。 */
export const ROUTER_ACTION_LIMIT = 5;
/** 同时存活的投机执行 Ticket 上限(§3.4):后台试探消耗算力,超出的投机派发直接丢弃。 */
export const MAX_SPECULATIVE_TICKETS = 2;

/**
 * Router 的单个动作。一次裁决是一组动作(可 fan-out 多个 dispatch、票级操控),
 * 由引擎按序执行;旧版单裁决格式({decision:...})在 parseVerdict 里归一成 actions。
 */
export const RouterActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("respond"),
    ticketId: z.string().min(1),
    requestId: z.string().min(1),
    response: WorkerResponseSchema,
  }),
  z.object({
    action: z.literal("dispatch"),
    title: z.string().min(1).max(120),
    mandate: z.string().min(1),
    unsubscribe: z.boolean().optional(),
    /** Worker 档位名;省略或不在设置名单里时用默认 Worker。 */
    profile: z.string().max(60).nullish(),
    /** 投机执行:后台静默尝试,结果有价值才交付(仅在设置开启时生效)。 */
    speculative: z.boolean().optional(),
  }),
  z.object({
    action: z.literal("steer"),
    ticketId: z.string().min(1),
    text: z.string().min(1),
    /** steer(默认)让运行中的轮次吸收指令;interrupt 打断当前轮接管。 */
    mode: z.enum(["steer", "interrupt"]).optional(),
  }),
  z.object({
    action: z.literal("cancel"),
    ticketId: z.string().min(1),
    rationale: z.string().max(500).optional(),
  }),
  z.object({
    action: z.literal("retry"),
    ticketId: z.string().min(1),
  }),
  z.object({
    /** 让一个已有 Ticket 的 Worker 也订阅当前线程(多对多订阅),后续消息直通给它。 */
    action: z.literal("subscribe"),
    ticketId: z.string().min(1),
  }),
  z.object({
    action: z.literal("reply"),
    reply: z.string().min(1),
  }),
  z.object({
    action: z.literal("ignore"),
    rationale: z.string().max(500).optional(),
  }),
  z.object({
    action: z.literal("stop"),
    rationale: z.string().max(500).optional(),
  }),
]);
export type RouterAction = z.infer<typeof RouterActionSchema>;

/** Router 的结构化裁决(JSON 块)在执行前的校验形状:1-5 个动作,按序执行。 */
export const RouterVerdictSchema = z.object({
  actions: z.array(RouterActionSchema).min(1).max(ROUTER_ACTION_LIMIT),
});
export type RouterVerdict = z.infer<typeof RouterVerdictSchema>;

/** 照抄提示词 JSON 示例产生的占位值:整个字符串仅由省略号/句点/空白组成("..."、"…" 等)。 */
const PLACEHOLDER_ELLIPSIS = /^[\s.。…·]*$/;
/** 票据 id 的占位值:可选 tkt_ 前缀加纯省略号/句点("tkt_...")。 */
const PLACEHOLDER_TICKET_ID = /^(?:tkt_)?[\s.。…·]*$/;

/**
 * 裁决里的示例占位值检查。模型在多块自我纠正时可能照抄提示词里的动作示例
 * ("title":"..."、"ticketId":"tkt_..."):这类裁决 schema 完全合法,执行出去却
 * 是空标题/空指令/空目标的工单,必须当无效候选跳过。返回问题描述;全部为真实值时
 * 返回 null。
 */
export function verdictPlaceholderIssue(verdict: RouterVerdict): string | null {
  for (const action of verdict.actions) {
    let field: string | null = null;
    if (action.action === "dispatch") {
      if (PLACEHOLDER_ELLIPSIS.test(action.title) || PLACEHOLDER_ELLIPSIS.test(action.mandate)) {
        field = "dispatch title/mandate";
      }
    } else if (action.action === "steer") {
      if (PLACEHOLDER_TICKET_ID.test(action.ticketId) || PLACEHOLDER_ELLIPSIS.test(action.text)) {
        field = "steer ticketId/text";
      }
    } else if (action.action === "respond") {
      if (PLACEHOLDER_TICKET_ID.test(action.ticketId) || PLACEHOLDER_ELLIPSIS.test(action.requestId)) field = "respond ticketId/requestId";
    } else if (action.action === "cancel" || action.action === "retry" || action.action === "subscribe") {
      if (PLACEHOLDER_TICKET_ID.test(action.ticketId)) field = `${action.action} ticketId`;
    } else if (action.action === "reply") {
      if (PLACEHOLDER_ELLIPSIS.test(action.reply)) field = "reply text";
    }
    if (field) return `router echoed the JSON example ("..." placeholder in ${field})`;
  }
  return null;
}

/**
 * dispatch mandate 的派发兜底:剥除空白后仅剩省略号/句点的指令不可能承载任务。
 * parseVerdict 已把此类裁决当无效候选拒绝;引擎在落盘工单前再拦一次,防未来解析
 * 路径放宽后空工单再次漏网。返回问题描述;可用时返回 null。
 */
export function dispatchMandateIssue(mandate: string): string | null {
  if (PLACEHOLDER_ELLIPSIS.test(mandate)) {
    return 'dispatch mandate is only "..." — the router echoed the JSON example instead of a real instruction';
  }
  return null;
}

/**
 * 引擎待执行的动作记录:带副作用的裁决动作(steer/cancel/retry/stop)在消费触发时
 * 先落盘此记录,执行成功后移除;崩溃后由恢复流程按序补执行,失败重试有次数上限。
 * dispatch 的补执行由 pending 票据 + 看门狗承担,不在此列。
 */
export const PendingActionSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  /** 关联的 Decision(审计与失败备注定位)。 */
  decisionId: z.string().min(1),
  kind: z.enum(["steer", "respond", "cancel", "retry", "stop"]),
  ticketId: z.string().nullish(),
  /** 响应绑定到当时的 Worker,不能在重试换 Worker 后误答新的会话。 */
  workerAgentId: z.string().nullish(),
  requestId: z.string().nullish(),
  response: WorkerResponseSchema.nullish(),
  /** steer 的指令文本。 */
  text: z.string().nullish(),
  /** steer 的模式;其余动作为空。 */
  mode: z.enum(["steer", "interrupt"]).nullish(),
  attempts: z.number().int().nonnegative().default(0),
  createdAt: z.string(),
});
export type PendingAction = z.infer<typeof PendingActionSchema>;

/** IM 答复先落盘;逐段确认后推进 nextPart,失败后从该位置补发。 */
export const ImDeliverySchema = z.object({
  id: z.string(),
  threadId: z.string(),
  origin: TriggerOriginSchema,
  parts: z.array(z.string()).min(1),
  nextPart: z.number().int().nonnegative(),
  status: z.enum(["pending", "failed", "sent"]),
  /** 通道回执里的已发送消息 id:用户引用 Router 答复时,据此找回所属线程与原文。 */
  sentMessageIds: z.array(z.string()).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ImDelivery = z.infer<typeof ImDeliverySchema>;

/** 旧版 Router 会话游标,仅为兼容已保存的状态保留;独立评估不再读取。 */
const RouterPromptStateSchema = z.object({
  agentId: z.string(),
  sessionId: z.string().nullable(),
  configHash: z.string(),
  compactionSeq: z.number().int().nonnegative(),
  threadIds: z.array(z.string()),
  triggerIds: z.array(z.string()),
});

/**
 * LLM 看门狗(§6)的持久状态:最近一次会话 id、上次巡检结论,以及每个 Ticket
 * 上次巡检时看到的时间线位置(判断"有没有实质进展"的依据)。
 */
const WatchdogStateSchema = z.object({
  agentId: z.string().nullish(),
  provider: z.string().nullish(),
  /** 旧版规则游标,独立巡检不再使用。 */
  configHash: z.string().nullish(),
  lastRunAt: z.string().nullish(),
  lastSummary: z.string().nullish(),
  lastError: z.string().nullish(),
  lastActions: z.number().int().nonnegative().default(0),
  seen: z.record(z.string(), z.object({ seq: z.number(), at: z.string() })).default({}),
});
export type WatchdogState = z.infer<typeof WatchdogStateSchema>;

/** 整个持久化文件的形状。 */
export const SuperagentStateSchema = z.object({
  version: z.literal(1),
  kv: z.object({
    routerAgentId: z.string().nullish(),
    routerProvider: z.string().nullish(),
    workerProvider: z.string().nullish(),
    routerPromptState: RouterPromptStateSchema.nullish(),
    /** 共享隔离的持久工作区登记:绝对路径(已 resolve)→ workspace id,跨重启复用。 */
    sharedWorkspaces: z.record(z.string(), z.string()).nullish(),
    /** Router/看门狗专用后台工作区,绝对路径 → workspace id;与 Worker 登记分离。 */
    backgroundWorkspaces: z.record(z.string(), z.string()).nullish(),
    /** 对话页打开着的标签;从未保存过时为空,快照按界面发起的对话给出初始标签。 */
    chatTabs: ChatTabsSchema.nullish(),
    watchdog: WatchdogStateSchema.nullish(),
    /** 最近一次客户端上报的界面语言;daemon 生成的文字用它,从未上报时为英文。 */
    language: z.enum(["en", "zh-CN"]).nullish(),
  }),
  threads: z.array(ThreadSchema),
  triggers: z.array(TriggerSchema),
  tickets: z.array(TicketSchema),
  decisions: z.array(DecisionSchema),
  /** 旧状态文件没有此字段,解析时补空数组。 */
  pendingActions: z.array(PendingActionSchema).default([]),
  imDeliveries: z.array(ImDeliverySchema).default([]),
});
export type SuperagentState = z.infer<typeof SuperagentStateSchema>;

export function emptyState(): SuperagentState {
  return {
    version: 1,
    kv: { routerAgentId: null, routerProvider: null, workerProvider: null },
    threads: [],
    triggers: [],
    tickets: [],
    decisions: [],
    pendingActions: [],
    imDeliveries: [],
  };
}

/** 面向 UI 的状态快照(RPC 出参),带计数与裁剪。 */
export const SuperagentSnapshotSchema = z.object({
  /**
   * 引擎状态版本(进程启动标识 + 自增序号),与 superagent.state_events 推送的版本对照:
   * 推送的版本与缓存快照相同就不必重新读取。旧 daemon 不带。
   */
  revision: z.string().nullish(),
  configured: z.boolean(),
  workingDir: z.string(),
  /** Worker 基础目录的问题(如 worktree 隔离但不是 git 仓库);可用时为空。 */
  workingDirIssue: z.string().nullish(),
  routerAgentId: z.string().nullish(),
  routerProvider: z.string().nullish(),
  workerProvider: z.string().nullish(),
  /** 默认 Worker 之外的具名档位(设置原样,UI 展示用)。 */
  workerProfiles: z.array(z.object({
    name: z.string(), provider: z.string(), description: z.string(),
    modeId: z.string().default(""),
    thinkingOptionId: z.string().default(""),
    /** 档位专属基础目录;空 = 用全局 workingDir。 */
    workingDir: z.string().default(""),
  })),
  threads: z.array(
    ThreadSchema.extend({
      pendingTriggers: z.number().int(),
      ticketCounts: z.record(z.string(), z.number().int()),
      /** 最近一次裁决:线程列表不带裁决记录时也能推导「评估失败」「已答复」。 */
      lastDecision: z.object({ outcome: z.enum(DECISION_OUTCOMES), createdAt: z.string() }).nullish(),
    }),
  ),
  tickets: z.array(TicketSchema),
  triggers: z.array(TriggerSchema),
  decisions: z.array(DecisionSchema),
  /** 只暴露投递进度,不把 webhook 等通道凭据带到 UI。 */
  imDeliveries: z.array(z.object({
    id: z.string(), threadId: z.string(), title: z.string(), channel: TriggerOriginSchema.shape.channel,
    totalParts: z.number().int(), nextPart: z.number().int(), status: ImDeliverySchema.shape.status,
    updatedAt: z.string(),
    /** 回复正文的一行摘要:卡片靠它认出是哪条回复(线程标题是首条消息,认不出)。 */
    preview: z.string().default(""),
  })).default([]),
  /** 包含已关闭线程的最近结果,供 Router 区域展示。 */
  recentResults: z.array(ThreadResultSchema.extend({
    threadId: z.string(),
    title: z.string(),
    workspaceIds: z.array(z.string()),
  })).default([]),
  engine: z.object({
    running: z.boolean(),
    primed: z.boolean(),
    lastWatchdogAt: z.string().nullish(),
    lastWatchdogNote: z.string().nullish(),
    evalInFlight: z.boolean(),
    /** 当前正在评估的线程;仅运行时状态,不写入持久化文件。 */
    currentEvalThreadId: z.string().nullish(),
    /** LLM 看门狗巡检(设置开启时):上次巡检时间与结论。 */
    patrol: z.object({
      enabled: z.boolean(),
      agentId: z.string().nullish(),
      lastRunAt: z.string().nullish(),
      lastSummary: z.string().nullish(),
      lastError: z.string().nullish(),
      running: z.boolean(),
    }).nullish(),
  }),
  /** 对话页顶部标签(已去掉不存在的线程)。 */
  chatTabs: ChatTabsSchema.nullish(),
});
export type SuperagentSnapshot = z.infer<typeof SuperagentSnapshotSchema>;

export function newId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  const time = Date.now().toString(36);
  return `${prefix}_${time}${rand}`;
}

export function slugify(input: string, max = 32): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max);
  return slug || "task";
}

/** 中国不实行夏令时,北京时间恒为 UTC+8。 */
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * 北京时间日期 `YYYY-MM-DD`:插件落盘命名(IM 收件目录、Ticket 兜底目录)统一用它,
 * 与 daemon 主机所在时区无关。无效时间按当前时间算。
 */
export function beijingDate(now: Date): string {
  const time = Number.isFinite(now.getTime()) ? now.getTime() : Date.now();
  return new Date(time + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}
