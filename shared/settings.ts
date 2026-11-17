import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import type { MessageKey, Translate } from "./i18n";

/** 数值设置的取值范围:schema 与设置页的输入校验共用这一份。 */
export const NUMBER_LIMITS = {
  evalBatchMs: { min: 0, max: 60000 },
  workerTimeoutMin: { min: 5, max: 1440 },
  routerEvalTimeoutMin: { min: 1, max: 60 },
  routerIdleTimeoutMin: { min: 1, max: 1440 },
  threadIdleTimeoutMin: { min: 5, max: 43200 },
  workerIdleTimeoutMin: { min: 1, max: 43200 },
  maxTicketAttempts: { min: 0, max: 5 },
  triggerMaxChars: { min: 500, max: 64000 },
  imReplyMaxChars: { min: 100, max: 4000 },
  watchdogIntervalMin: { min: 5, max: 240 },
} as const;
export type NumberSettingKey = keyof typeof NUMBER_LIMITS;

function boundedInt(key: NumberSettingKey, fallback: number) {
  const { min, max } = NUMBER_LIMITS[key];
  return z.number().int().min(min).max(max).default(fallback);
}

/**
 * Worker 档位:默认 Worker(workerProvider)之外的具名 provider/model。Router 派发时用
 * `profile` 从这份名单里选一个名字,选不到或省略即用默认 Worker——Router 永远只能用到
 * 这里列出的 provider,触发文本无法把 Worker 引向任意 provider。
 */
export const DEFAULT_WORKER_PROFILE = "default";
export const MAX_WORKER_PROFILES = 8;
export const MAX_ROUTER_INSTRUCTIONS_CHARS = 12000;
export const WORKER_PROFILE_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,23}$/;
/**
 * schema 的校验消息存消息键(daemon 与设置页共用同一份 schema,而语言只有界面知道);
 * 设置页用 settingsIssueText 把键译成当前语言,带插值的键把值放在 issue.params 里。
 */
export const WORKER_PROFILE_NAME_HINT = "validation.profileNameFormat" satisfies MessageKey;

/** 共享隔离下 Router 与默认 Worker 合用的持久工作区标题(消息键);按「标题 + 目录」找回或新建。 */
export const DEFAULT_WORKSPACE_TITLE = "labels.workspace.default" satisfies MessageKey;

/** thinking 档位 id(pi: low/medium/high/…);空串 = 不指定。 */
export const THINKING_OPTION_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const THINKING_OPTION_HINT = "validation.thinkingOption" satisfies MessageKey;
const ThinkingOptionSchema = z
  .string()
  .trim()
  .max(64)
  .regex(new RegExp(`^(?:${THINKING_OPTION_PATTERN.source})?$`), THINKING_OPTION_HINT)
  .default("");

export const WorkerProfileSchema = z.object({
  /** Router 在 dispatch 里填写的档位名。 */
  name: z
    .string()
    .trim()
    .regex(WORKER_PROFILE_NAME_PATTERN, WORKER_PROFILE_NAME_HINT)
    .refine((name) => name !== DEFAULT_WORKER_PROFILE, {
      message: "validation.reservedProfileName" satisfies MessageKey,
      params: { name: DEFAULT_WORKER_PROFILE },
    }),
  /** `provider` 或 `provider/model`,与 workerProvider 同一格式。 */
  provider: z.string().trim().min(1, "validation.providerRequired" satisfies MessageKey).max(120),
  /** provider 上报的模式 ID;留空不覆盖 Paseo 默认模式。 */
  modeId: z.string().trim().max(500).default(""),
  /** 该档位 Worker 的 thinking 档位;留空不指定(回落 provider 默认)。 */
  thinkingOptionId: ThinkingOptionSchema,
  /** 用途说明:原样写进 Router 提示词,是 Router 选档位的唯一依据。 */
  description: z.string().trim().min(1, "validation.descriptionRequired" satisfies MessageKey).max(300),
  /** 该档位 Worker 的专属基础目录(绝对路径);留空用全局 workingDir。 */
  workingDir: z.string().trim().max(1024).default(""),
});
export type WorkerProfile = z.infer<typeof WorkerProfileSchema>;

const WorkerProfilesSchema = z
  .array(WorkerProfileSchema)
  .max(MAX_WORKER_PROFILES)
  .superRefine((profiles, ctx) => {
    const seen = new Set<string>();
    profiles.forEach((profile, index) => {
      if (seen.has(profile.name)) {
        ctx.addIssue({
          code: "custom",
          path: [index, "name"],
          message: "validation.duplicateProfileName" satisfies MessageKey,
          params: { name: profile.name },
        });
      }
      seen.add(profile.name);
    });
  })
  .default([]);

/**
 * Host 级设置。provider 留空时引擎会在首次需要时从 daemon 的 provider 快照里
 * 自动挑一个稳定的默认(优先 claude → codex → opencode → 任意可用),并记入 kv,
 * 保证 Router/Worker 的模型选择跨重启稳定。
 *
 * IM 触发源的准入白名单是硬门槛:allowUsers/allowChats 全空时该 source 拒绝启动
 * (对齐 Paseo Hub from_users 的安全设计)。微信例外:扫码人自动在白名单里,
 * 凭证由扫码登录写在 daemon 本机,不进设置。
 */
export const superagentSettings = defineSettings({
  id: "superagent",
  scope: "host",
  version: 15,
  schema: z.object({
    /** `provider` 或 `provider/model`。Router 用轻量模型即可。 */
    routerProvider: z.string().trim().max(120).default(""),
    /** Router 会话的 thinking 档位;留空不指定(回落 provider 默认)。 */
    routerThinkingOptionId: ThinkingOptionSchema,
    /** 每次评估直接注入,不依赖 provider 读取工作目录中的规则文件。 */
    routerInstructions: z.string().trim().max(MAX_ROUTER_INSTRUCTIONS_CHARS).default(""),
    /** 默认 Worker:dispatch 未指定档位(或档位不存在)时使用。 */
    workerProvider: z.string().trim().max(120).default(""),
    /** 默认 Worker 的模式;留空不覆盖 Paseo 默认模式。 */
    workerModeId: z.string().trim().max(500).default(""),
    /** 默认 Worker 的 thinking 档位;留空不指定(回落 provider 默认)。 */
    workerThinkingOptionId: ThinkingOptionSchema,
    /** 默认 Worker 的用途说明;配置了其他档位时写进 Router 提示词,留空用通用说明。 */
    workerDescription: z.string().trim().max(300).default(""),
    /** 默认 Worker 之外的具名档位,Router 按用途说明为每个 dispatch 选择。 */
    workerProfiles: WorkerProfilesSchema,
    /** Router agent 的 cwd;也是 Worker worktree 的基准仓库。必须是主机上的绝对路径。 */
    workingDir: z.string().trim().max(1024).default(""),
    /** Worker 隔离方式:worktree 独立工作区,或共享 workingDir 的目录工作区。 */
    workerIsolation: z.enum(["worktree", "shared"]).default("worktree"),
    /**
     * Worker 建成后台 agent(Paseo 0.16):不进 Paseo 的标签页、默认列表与通知,
     * 在本插件对话页按 Ticket 打开;worktree 隔离时 Ticket 独占的工作区也建成后台工作区。
     * 只影响新建(含重试)的 Worker,已有会话不变。
     */
    workerBackground: z.boolean().default(false),
    /** 触发积攒窗口:窗口内同线程触发合并进一次 Router 评估(批处理)。 */
    evalBatchMs: boundedInt("evalBatchMs", 1500),
    /** Worker 单轮运行上限,超时看门狗中断并判失败。 */
    workerTimeoutMin: boundedInt("workerTimeoutMin", 120),
    routerEvalTimeoutMin: boundedInt("routerEvalTimeoutMin", 10),
    routerIdleTimeoutMin: boundedInt("routerIdleTimeoutMin", 30),
    threadIdleTimeoutMin: boundedInt("threadIdleTimeoutMin", 1440),
    workerIdleTimeoutMin: boundedInt("workerIdleTimeoutMin", 1440),
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
    /**
     * 群聊观察模式:允许会话里未 @ 机器人的群消息不再丢弃,作为上下文触发交给
     * Router 判断(§3.1 候选档);关闭时这类消息记为 filtered 留痕。
     */
    feishuObserve: z.boolean().default(false),

    // ---- QQ 触发源(OneBot 11,配合 NapCat 正向 WebSocket) ----
    qqEnabled: z.boolean().default(false),
    /** 如 ws://127.0.0.1:3001。 */
    qqEndpoint: z.string().trim().max(300).default(""),
    qqToken: z.string().trim().max(200).default(""),
    /** 允许的发送者 QQ 号,逗号分隔(私聊与群聊通用)。 */
    qqAllowUsers: z.string().trim().max(2000).default(""),
    /** 允许的群号,逗号分隔(群里需 @ 机器人)。 */
    qqAllowGroups: z.string().trim().max(2000).default(""),
    /** 群聊观察模式(同 feishuObserve):未 @ 机器人的群消息作为上下文交给 Router。 */
    qqObserve: z.boolean().default(false),

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

    // ---- 微信触发源(腾讯官方 iLink / 微信 ClawBot,扫码登录,HTTP 长轮询,免公网) ----
    weixinEnabled: z.boolean().default(false),
    /** 扫码人之外允许的微信用户 ID(xxx@im.wechat),逗号分隔;仅私聊。 */
    weixinAllowUsers: z.string().trim().max(2000).default(""),

    /** IM 单条消息上限(含分段序号);长答复完整分段发送。 */
    imReplyMaxChars: boundedInt("imReplyMaxChars", 600),
    /**
     * IM 附件的收件根目录(daemon 主机上的绝对路径),各通道再分子目录(如 weixin/);
     * 留空 = $PASEO_HOME/plugin-data/superagent/inbox。
     */
    imInboxDir: z.string().trim().max(1024).default(""),

    // ---- 主动与巡检(§3.4 投机执行 / §6 看门狗) ----
    /**
     * 投机执行:允许 Router 依据「Router 规则」里写的主动策略,对没人明确提出的事项
     * (如观察到的群聊反馈)在后台静默派发 Worker 先行尝试;结果有价值才交付,否则丢弃。
     */
    speculativeEnabled: z.boolean().default(false),
    /**
     * LLM 看门狗:独立的巡检 agent 按间隔检查每个 Worker 是否有实质进展、是否偏离任务,
     * 必要时提醒/打断/取消/重试或上报 Router;维护者也可直接在该会话里问诊。
     */
    watchdogEnabled: z.boolean().default(false),
    /** 看门狗的 `provider` 或 `provider/model`;留空沿用 Router 的模型。 */
    watchdogProvider: z.string().trim().max(120).default(""),
    /** 巡检间隔(分钟)。没有进行中的任务(无新动静的待命任务不算)、也没有异常时跳过,不调用模型。 */
    watchdogIntervalMin: boundedInt("watchdogIntervalMin", 30),
  }),
  /**
   * v1/v2 → v3:新字段由 schema 默认值补齐;v3 → v4:新增 agentToolProviders 同理;
   * v4 → v5:新增 workerDescription/workerProfiles 同理(无档位 = 与旧版一致的单一 Worker);
   * v5 → v6:新增 routerInstructions,留空沿用内置编排规则;
   * v6 → v7:档位新增 workingDir(留空 = 全局 workingDir),旧档位由默认值补齐;
   * v7 → v8:新增 feishuObserve/qqObserve(默认关闭,行为与旧版一致);
   * v8 → v9:新增 speculativeEnabled 与 watchdog* 字段(默认关闭,行为与旧版一致);
   * v9 → v10:新增 workerModeId 与档位 modeId(留空沿用 Paseo 默认模式);
   * v10 → v11:新增 weixinEnabled/weixinAllowUsers(默认关闭,行为与旧版一致);
   * v11 → v12:新增 routerThinkingOptionId/workerThinkingOptionId 与档位 thinkingOptionId
   * (留空不传,回落 provider 默认,行为与旧版一致);
   * v12 → v13:新增 imInboxDir(留空 = 默认收件目录,行为与旧版一致);
   * v13 → v14:新增 Router 评估/空闲、Thread 空闲与 Worker 待命超时;
   * v14 → v15:新增 workerBackground(默认关闭,Worker 照旧显示在 Paseo 中)。
   */
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

const VALIDATION_KEYS = new Set<string>([
  "validation.profileNameFormat",
  "validation.thinkingOption",
  "validation.reservedProfileName",
  "validation.providerRequired",
  "validation.descriptionRequired",
  "validation.duplicateProfileName",
] satisfies MessageKey[]);

/**
 * 设置校验 issue 的显示文字:schema 自己的消息键按当前语言翻译(插值取自 issue.params),
 * 超长统一说「内容过长」,其余(zod 内置消息)原样显示。
 */
export function settingsIssueText(issue: { code: string; message: string; params?: Record<string, unknown> }, t: Translate): string {
  if (issue.code === "too_big") return t("validation.tooLong");
  if (!VALIDATION_KEYS.has(issue.message)) return issue.message;
  const name = typeof issue.params?.name === "string" ? issue.params.name : "";
  return (t as (key: string, vars?: Record<string, string>) => string)(issue.message, { name });
}
