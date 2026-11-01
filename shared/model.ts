import { z } from "zod";

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

export const TRIGGER_KINDS = ["manual", "agent", "report", "feishu", "qq", "dingtalk", "wecom"] as const;
export const TriggerKindSchema = z.enum(TRIGGER_KINDS);
export type TriggerKind = z.infer<typeof TriggerKindSchema>;

/** IM 触发的来源信息:outbox 依此把 Router 答复发回原聊天。 */
export const TriggerOriginSchema = z.object({
  channel: z.enum(["feishu", "qq", "dingtalk", "wecom"]),
  /** 会话标识:飞书 chat_id / QQ group_id 或私聊对方 QQ 号 / 钉钉 conversationId / 企微 chatid 或 userid。 */
  chatId: z.string().min(1),
  /** 通道专属回复引用:飞书/钉钉/企微消息 id,OneBot 用。 */
  messageId: z.string().nullish(),
  /** 通道专属回复通道:钉钉 sessionWebhook、企微 req_id。 */
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
});
export type Trigger = z.infer<typeof TriggerSchema>;

export const THREAD_STATES = ["active", "closed"] as const;
export type ThreadState = (typeof THREAD_STATES)[number];

export const ThreadSchema = z.object({
  id: z.string().min(1),
  /** 稳定关联键,例如 `manual:<uuid>`、`agent:<agentId>:<slug>`。 */
  key: z.string().min(1),
  title: z.string().min(1),
  state: z.enum(THREAD_STATES),
  /** Router 维护的一句话摘要,供下次评估的上下文存根。 */
  summary: z.string().nullish(),
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

export const TicketSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  title: z.string().min(1),
  /** 交给 Worker 的任务书。 */
  mandate: z.string(),
  status: z.enum(TICKET_STATUSES),
  workerAgentId: z.string().nullish(),
  workspaceId: z.string().nullish(),
  /** 当前(或最近一次)Worker 启动时间,看门狗超时判定的基准。 */
  startedAt: z.string().nullish(),
  attempts: z.number().int().nonnegative().default(0),
  /** 线程后续事件是否直通该 Worker(多对多订阅中的一个成员)。 */
  subscribed: z.boolean().default(true),
  report: z.string().nullish(),
  lastError: z.string().nullish(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Ticket = z.infer<typeof TicketSchema>;

export const DECISION_OUTCOMES = ["dispatch", "reply", "ignore", "stop", "unparsed", "error"] as const;
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

/** Router 的结构化裁决(JSON 块)在执行前的校验形状。 */
export const RouterVerdictSchema = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("dispatch"),
    title: z.string().min(1).max(120),
    mandate: z.string().min(1),
    reply: z.string().max(2000).optional(),
    unsubscribe: z.boolean().optional(),
  }),
  z.object({
    decision: z.literal("reply"),
    reply: z.string().min(1).max(2000),
  }),
  z.object({
    decision: z.literal("ignore"),
    rationale: z.string().max(500).optional(),
  }),
  z.object({
    decision: z.literal("stop"),
    rationale: z.string().max(500).optional(),
  }),
]);
export type RouterVerdict = z.infer<typeof RouterVerdictSchema>;

/** 整个持久化文件的形状。 */
export const SuperagentStateSchema = z.object({
  version: z.literal(1),
  kv: z.object({
    routerAgentId: z.string().nullish(),
    routerProvider: z.string().nullish(),
    workerProvider: z.string().nullish(),
  }),
  threads: z.array(ThreadSchema),
  triggers: z.array(TriggerSchema),
  tickets: z.array(TicketSchema),
  decisions: z.array(DecisionSchema),
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
  };
}

/** 面向 UI 的状态快照(RPC 出参),带计数与裁剪。 */
export const SuperagentSnapshotSchema = z.object({
  configured: z.boolean(),
  workingDir: z.string(),
  routerAgentId: z.string().nullish(),
  routerProvider: z.string().nullish(),
  workerProvider: z.string().nullish(),
  threads: z.array(
    ThreadSchema.extend({
      pendingTriggers: z.number().int(),
      ticketCounts: z.record(z.string(), z.number().int()),
    }),
  ),
  tickets: z.array(TicketSchema),
  triggers: z.array(TriggerSchema),
  decisions: z.array(DecisionSchema),
  engine: z.object({
    running: z.boolean(),
    primed: z.boolean(),
    lastWatchdogAt: z.string().nullish(),
    lastWatchdogNote: z.string().nullish(),
    evalInFlight: z.boolean(),
  }),
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

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}
