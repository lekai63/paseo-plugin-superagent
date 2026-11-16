import { z } from "zod";
import { defineRpc } from "@getpaseo/plugin";
import { SuperagentSnapshotSchema } from "./model";
import { ChatTabsSchema } from "./chat-tabs";
import { WeixinStatusSchema } from "./weixin";
import { FileKindSchema, FilePreviewSchema, MAX_STAT_PATHS } from "./file-preview";

/**
 * 插件 RPC 契约。客户端经 `useRpc` 调用;server/handlers.ts 实现同名 handler。
 * 每个契约同时是 server 端首次 prime 引擎的入口(见 index.server.ts)。
 */

const OkSchema = z.object({ ok: z.boolean(), error: z.string().nullish() });

export const superagentRetryImDeliveryRpc = defineRpc({
  name: "superagent.retry_im_delivery",
  input: z.object({ deliveryId: z.string() }),
  output: OkSchema,
});

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
    /** 对话页只读取当前线程的消息,避免被其他线程占用最近记录窗口。 */
    threadId: z.string().optional(),
    /** 线程列表只需要线程与 Ticket:不带触发与裁决正文,减轻轮询负担。 */
    omitRecords: z.boolean().optional(),
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

/**
 * 客户端上报 app 语言(宿主解析后的标签,如 `zh-CN`、`en`)。daemon 生成的文字
 * (IM 消息描述、引擎通知、扫码状态等)随之切换;简体中文以外一律英文。
 */
export const superagentSetLocaleRpc = defineRpc({
  name: "superagent.set_locale",
  input: z.object({ locale: z.string().max(64) }),
  output: OkSchema,
});

/** 对话页的标签列表与最后查看的对话;daemon 落盘,离开页面或重启 app 后恢复。 */
export const superagentSaveChatTabsRpc = defineRpc({
  name: "superagent.save_chat_tabs",
  input: ChatTabsSchema,
  output: OkSchema,
});

/**
 * 对话页的文件预览:Router 答复里链接到的任意绝对路径,只读。文本截断到上限,图片以
 * base64 返回,目录列出条目;读不了时返回 kind=error 而不是抛错。
 */
export const superagentReadFileRpc = defineRpc({
  name: "superagent.read_file",
  input: z.object({ path: z.string().min(1).max(4096) }),
  output: FilePreviewSchema,
});

/** 文件药丸的类型:一段对话里链接到的路径各是文件、目录还是已不存在。 */
export const superagentStatFilesRpc = defineRpc({
  name: "superagent.stat_files",
  input: z.object({ paths: z.array(z.string().min(1).max(4096)).max(MAX_STAT_PATHS) }),
  output: z.object({ kinds: z.record(z.string(), FileKindSchema) }),
});

/** 微信通道状态:已保存的 bot 账号、扫码登录进度与长轮询状态。 */
export const superagentWeixinStatusRpc = defineRpc({
  name: "superagent.weixin_status",
  input: z.object({}),
  output: WeixinStatusSchema,
});

/**
 * 微信扫码登录与账号管理:login 取新二维码(取消进行中的登录)、verify 提交手机上
 * 显示的验证码、cancel 取消登录、logout 删除本机凭证并停止通道。返回最新状态。
 */
export const superagentWeixinAccountRpc = defineRpc({
  name: "superagent.weixin_account",
  input: z.object({
    action: z.enum(["login", "verify", "cancel", "logout"]),
    code: z.string().max(32).optional(),
  }),
  output: WeixinStatusSchema,
});
