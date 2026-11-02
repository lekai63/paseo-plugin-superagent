import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/** 数值设置的取值范围:schema 与设置页的输入校验共用这一份。 */
export const NUMBER_LIMITS = {
  evalBatchMs: { min: 0, max: 60000 },
  workerTimeoutMin: { min: 5, max: 1440 },
  maxTicketAttempts: { min: 0, max: 5 },
  triggerMaxChars: { min: 500, max: 64000 },
  imReplyMaxChars: { min: 100, max: 4000 },
} as const;
export type NumberSettingKey = keyof typeof NUMBER_LIMITS;

function boundedInt(key: NumberSettingKey, fallback: number) {
  const { min, max } = NUMBER_LIMITS[key];
  return z.number().int().min(min).max(max).default(fallback);
}

/**
 * Host 级设置。provider 留空时引擎会在首次需要时从 daemon 的 provider 快照里
 * 自动挑一个稳定的默认(优先 claude → codex → opencode → 任意可用),并记入 kv,
 * 保证 Router/Worker 的模型选择跨重启稳定。
 *
 * IM 触发源(飞书/QQ)的准入白名单是硬门槛:allowUsers/allowChats 全空时
 * 该 source 拒绝启动(对齐 Paseo Hub from_users 的安全设计)。
 */
export const superagentSettings = defineSettings({
  id: "superagent",
  scope: "host",
  version: 4,
  schema: z.object({
    /** `provider` 或 `provider/model`。Router 用轻量模型即可。 */
    routerProvider: z.string().trim().max(120).default(""),
    /** Worker 用最强模型。 */
    workerProvider: z.string().trim().max(120).default(""),
    /** Router agent 的 cwd;也是 Worker worktree 的基准仓库。必须是主机上的绝对路径。 */
    workingDir: z.string().trim().max(1024).default(""),
    /** Worker 隔离方式:worktree 独立工作区,或共享 workingDir 的目录工作区。 */
    workerIsolation: z.enum(["worktree", "shared"]).default("worktree"),
    /** 触发积攒窗口:窗口内同线程触发合并进一次 Router 评估(批处理)。 */
    evalBatchMs: boundedInt("evalBatchMs", 1500),
    /** Worker 单轮运行上限,超时看门狗中断并判失败。 */
    workerTimeoutMin: boundedInt("workerTimeoutMin", 120),
    /** Ticket 失败重试上限。 */
    maxTicketAttempts: boundedInt("maxTicketAttempts", 1),
    /** 单个触发文本上限,超出即被 fast-path 截断。 */
    triggerMaxChars: boundedInt("triggerMaxChars", 8000),
    /**
     * 是否向所有(非本插件创建的)agent 注入 superagent_dispatch 委派 MCP server。
     * 插件自持通道:不受宿主 "Paseo tools"(mcp.injectIntoAgents)开关影响。
     */
    agentToolEnabled: z.boolean().default(true),
    /**
     * 允许注入委派 MCP 的 provider,逗号分隔;留空 = 默认已知支持 MCP server 的
     * 内置 provider(claude/codex/opencode/omp/copilot)。不支持 MCP 的 provider
     * 注入会让会话启动失败,故需显式列出。
     */
    agentToolProviders: z.string().trim().max(500).default(""),

    // ---- 飞书触发源(长连接,无需公网回调) ----
    feishuEnabled: z.boolean().default(false),
    feishuAppId: z.string().trim().max(120).default(""),
    feishuAppSecret: z.string().trim().max(200).default(""),
    /** 允许的发送者 open_id,逗号分隔。 */
    feishuAllowUsers: z.string().trim().max(2000).default(""),
    /** 允许的会话 chat_id,逗号分隔(群聊需 @ 机器人)。 */
    feishuAllowChats: z.string().trim().max(2000).default(""),

    // ---- QQ 触发源(OneBot 11,配合 NapCat 正向 WebSocket) ----
    qqEnabled: z.boolean().default(false),
    /** 如 ws://127.0.0.1:3001。 */
    qqEndpoint: z.string().trim().max(300).default(""),
    qqToken: z.string().trim().max(200).default(""),
    /** 允许的发送者 QQ 号,逗号分隔(私聊与群聊通用)。 */
    qqAllowUsers: z.string().trim().max(2000).default(""),
    /** 允许的群号,逗号分隔(群里需 @ 机器人)。 */
    qqAllowGroups: z.string().trim().max(2000).default(""),

    // ---- 钉钉触发源(Stream 模式 WebSocket,免公网) ----
    dingtalkEnabled: z.boolean().default(false),
    /** 企业内部应用 AppKey(ClientId)。 */
    dingtalkClientId: z.string().trim().max(120).default(""),
    dingtalkClientSecret: z.string().trim().max(200).default(""),
    /** 允许的发送者 staffId,逗号分隔。 */
    dingtalkAllowUsers: z.string().trim().max(2000).default(""),
    /** 允许的会话 conversationId,逗号分隔(群聊被 @ 才会收到)。 */
    dingtalkAllowChats: z.string().trim().max(2000).default(""),

    // ---- 企业微信触发源(智能机器人 WebSocket 长连接,免公网) ----
    wecomEnabled: z.boolean().default(false),
    /** 智能机器人 botId(企业微信后台获取)。 */
    wecomBotId: z.string().trim().max(120).default(""),
    wecomSecret: z.string().trim().max(200).default(""),
    /** 允许的发送者 userid,逗号分隔。 */
    wecomAllowUsers: z.string().trim().max(2000).default(""),
    /** 允许的会话 chatid(群聊),逗号分隔;群聊被 @ 才会收到。 */
    wecomAllowChats: z.string().trim().max(2000).default(""),

    /** IM 回复截断上限(字符)。 */
    imReplyMaxChars: boundedInt("imReplyMaxChars", 600),
  }),
  /** v1/v2 → v3:新字段由 schema 默认值补齐;v3 → v4:新增 agentToolProviders 同理。 */
  migrate: (values) => values,
});

export type SuperagentSettingsValues = z.infer<typeof superagentSettings.schema>;

export const SETTINGS_DEFAULTS: SuperagentSettingsValues = superagentSettings.schema.parse({});

/** 逗号分隔白名单解析。 */
export function parseAllowlist(input: string): string[] {
  return input
    .split(/[,，\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}
