import { z } from "zod";
import { defineRpc } from "@getpaseo/plugin";
import { SuperagentSnapshotSchema } from "./model";

/**
 * 插件 RPC 契约。客户端经 `useRpc` 调用;server/handlers.ts 实现同名 handler。
 * 每个契约同时是 server 端首次 prime 引擎的入口(见 index.server.ts)。
 */

const OkSchema = z.object({ ok: z.boolean(), error: z.string().nullish() });

export const superagentDispatchRpc = defineRpc({
  name: "superagent.dispatch",
  input: z.object({
    /** 新话题标题;省略时取任务文本首行。 */
    title: z.string().max(200).optional(),
    task: z.string().min(1).max(16000),
    /** 在既有线程内追加(触发订阅直通或 Router 评估)。 */
    threadId: z.string().optional(),
    sender: z.string().max(120).optional(),
    /** 上下文补充:不单独要求行动。 */
    context: z.boolean().optional(),
    /** agent 委派:Router 答复回投目标。 */
    replyToAgentId: z.string().optional(),
  }),
  output: z.object({
    threadId: z.string(),
    triggerId: z.string(),
    /** true = 订阅直通,零 LLM 参与已投递给 Worker。 */
    directDelivered: z.boolean(),
    note: z.string().nullish(),
  }),
});

export const superagentStateRpc = defineRpc({
  name: "superagent.state",
  input: z.object({
    includeClosed: z.boolean().optional(),
    /** 详情页只读取当前线程的消息,避免被其他线程占用最近记录窗口。 */
    threadId: z.string().optional(),
  }),
  output: SuperagentSnapshotSchema,
});

export const superagentForceEvalRpc = defineRpc({
  name: "superagent.force_eval",
  input: z.object({ threadId: z.string() }),
  output: OkSchema,
});

export const superagentCancelTicketRpc = defineRpc({
  name: "superagent.cancel_ticket",
  input: z.object({ ticketId: z.string() }),
  output: OkSchema,
});

export const superagentRetryTicketRpc = defineRpc({
  name: "superagent.retry_ticket",
  input: z.object({ ticketId: z.string() }),
  output: OkSchema,
});

export const superagentCloseThreadRpc = defineRpc({
  name: "superagent.close_thread",
  input: z.object({ threadId: z.string() }),
  output: OkSchema,
});

export const superagentUnsubscribeRpc = defineRpc({
  name: "superagent.unsubscribe",
  input: z.object({ threadId: z.string(), ticketId: z.string() }),
  output: OkSchema,
});
