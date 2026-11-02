import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useSettings, type PluginSurfaceProps, type SettingsState } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import type { SuperagentSnapshot } from "../shared/model";
import {
  NUMBER_LIMITS,
  parseAllowlist,
  superagentSettings,
  type NumberSettingKey,
  type SuperagentSettingsValues,
} from "../shared/settings";
import { STATE_QUERY_KEY } from "./query";

/**
 * Settings → Plugins → Superagent。宿主负责标题栏、返回、滚动与居中栏宽;
 * 这里只按主题分节:工作目录 → 模型 → 执行 → 委派 → IM 触发源 → 保存。
 *
 * 所有修改先进草稿,统一保存(保存会热重载 Router/IM 连接,不宜逐字触发)。
 * 数值字段在草稿里是字符串,便于边输入边校验。
 */

type Values = SuperagentSettingsValues;
type Ready = Extract<SettingsState<typeof superagentSettings.schema>, { status: "ready" }>;
type FormValues = { [K in keyof Values]: Values[K] extends number ? string : Values[K] };
type FormErrors = Partial<Record<keyof Values, string>>;
type StringKey = { [K in keyof Values]: Values[K] extends string ? K : never }[keyof Values];
type BooleanKey = { [K in keyof Values]: Values[K] extends boolean ? K : never }[keyof Values];

const NUMBER_KEYS = Object.keys(NUMBER_LIMITS) as NumberSettingKey[];

function toForm(values: Values): FormValues {
  const form = { ...values } as Record<string, unknown>;
  for (const key of NUMBER_KEYS) form[key] = String(values[key]);
  return form as FormValues;
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

function parseForm(form: FormValues): { values: Values | null; errors: FormErrors } {
  const errors: FormErrors = {};
  const raw = { ...form } as Record<string, unknown>;
  for (const key of NUMBER_KEYS) {
    const { min, max } = NUMBER_LIMITS[key];
    const text = form[key].trim();
    const value = /^\d+$/.test(text) ? Number(text) : Number.NaN;
    if (!Number.isInteger(value) || value < min || value > max) {
      errors[key] = `请输入 ${min}–${max} 之间的整数`;
    }
    raw[key] = value;
  }
  const workingDir = form.workingDir.trim();
  if (workingDir && !isAbsolutePath(workingDir)) errors.workingDir = "需要绝对路径,例如 /home/me/project";

  const parsed = superagentSettings.schema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = issue.path[0] as keyof Values | undefined;
      if (key && !errors[key]) errors[key] = issue.code === "too_big" ? "内容过长" : issue.message;
    }
  }
  const valid = parsed.success && Object.keys(errors).length === 0;
  return { values: valid ? parsed.data : null, errors };
}

export function SuperagentSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(superagentSettings);

  if (settings.status === "loading") {
    return <Text style={{ color: theme.colors.foregroundMuted, fontSize: 14 }}>正在加载设置...</Text>;
  }
  if (settings.status !== "ready") {
    return (
      <SettingsSection title="设置不可用">
        <SettingsCard>
          <SettingsAction
            label="读取设置失败"
            hint={settings.error}
            actionLabel="重新加载"
            onPress={() => void settings.reload()}
          />
          {settings.status === "invalid" ? (
            <SettingsAction
              label="恢复默认设置"
              hint="已保存的设置无法解析,恢复后需要重新填写"
              actionLabel="恢复默认"
              onPress={() => void settings.reset()}
            />
          ) : null}
        </SettingsCard>
      </SettingsSection>
    );
  }
  return <SettingsForm settings={settings} />;
}

function SettingsForm({ settings }: { settings: Ready }) {
  // 草稿与它基于的 revision 一起保存:别的客户端先保存时,这里的保存会冲突而不是静默覆盖。
  const [base, setBase] = useState({ values: settings.values, revision: settings.revision });
  const [form, setForm] = useState<FormValues>(() => toForm(settings.values));
  // SettingsInput 只在挂载时读 initialValue;整体重置草稿时换 key 让输入框重新挂载。
  const [formKey, setFormKey] = useState(0);

  const baseForm = useMemo(() => JSON.stringify(toForm(base.values)), [base.values]);
  const dirty = JSON.stringify(form) !== baseForm;
  const { values: parsedValues, errors } = useMemo(() => parseForm(form), [form]);
  const errorCount = Object.keys(errors).length;

  useEffect(() => {
    if (settings.revision === base.revision) return;
    const latest = JSON.stringify(toForm(settings.values));
    if (latest === JSON.stringify(form)) {
      // 自己刚保存成功:草稿已等于新值,只推进 revision。
      setBase({ values: settings.values, revision: settings.revision });
    } else if (!dirty) {
      // 别处改了设置,本地没有未保存修改:直接跟上。
      setBase({ values: settings.values, revision: settings.revision });
      setForm(toForm(settings.values));
      setFormKey((key) => key + 1);
    }
    // 有未保存修改时保留草稿;保存会因 revision 过期而失败,并提示载入最新。
  }, [base.revision, dirty, form, settings.revision, settings.values]);

  const set = useCallback(<K extends keyof FormValues>(key: K, value: FormValues[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  }, []);

  const save = useCallback(async () => {
    if (!parsedValues) return;
    await settings.save(parsedValues, base.revision);
  }, [base.revision, parsedValues, settings]);

  const discard = useCallback(() => {
    setBase({ values: settings.values, revision: settings.revision });
    setForm(toForm(settings.values));
    setFormKey((key) => key + 1);
  }, [settings.revision, settings.values]);

  // 主界面已拉取过状态时,把服务端检出的工作目录问题标在对应输入行上(只读缓存,不发请求)。
  const cached = useQueryClient().getQueryData<SuperagentSnapshot>(STATE_QUERY_KEY);
  const serverIssue =
    cached?.workingDirIssue && cached.workingDir === settings.values.workingDir && form.workingDir === settings.values.workingDir
      ? `Worker 无法启动:${cached.workingDirIssue}`
      : null;

  const disabled = settings.saving;
  const field = { form, errors, set, disabled };

  let saveLabel = "所有修改已保存";
  if (dirty) saveLabel = errorCount > 0 ? `有 ${errorCount} 处需要修正` : "有未保存的修改";

  return (
    <View key={formKey}>
      <SettingsSection
        title="工作目录"
        info="Router 在这个目录里运行,所有 Worker 也只在这里(或从它派生的 worktree)工作。"
      >
        <SettingsCard>
          <TextField
            {...field}
            name="workingDir"
            label="工作目录"
            hint="主机上的绝对路径;选择独立 worktree 时必须位于 git 仓库内"
            placeholder="/home/me/project"
            errorOverride={serverIssue}
          />
          <SettingsSelect
            label="Worker 隔离"
            hint={
              form.workerIsolation === "worktree"
                ? "每个 Ticket 在独立分支的 worktree 里工作,互不干扰"
                : "直接在工作目录里工作,不需要 git;产出按 AGENTS.md 规则或放进 tasks/ 子目录"
            }
            value={form.workerIsolation}
            options={[
              { label: "独立 worktree", value: "worktree" },
              { label: "共享目录", value: "shared" },
            ]}
            onValueChange={(value) => set("workerIsolation", value)}
            disabled={disabled}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="模型"
        info="格式为 provider 或 provider/model,model id 以 `paseo provider models <provider>` 列出的为准。留空时按 claude → codex → opencode 的顺序自动选择。"
      >
        <SettingsCard>
          <TextField
            {...field}
            name="routerProvider"
            label="Router"
            hint="只做评估与分派,轻量模型即可"
            placeholder="自动选择"
          />
          <TextField
            {...field}
            name="workerProvider"
            label="Worker"
            hint="负责真正干活,建议用最强的模型"
            placeholder="自动选择"
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="执行">
        <SettingsCard>
          <TextField {...field} name="workerTimeoutMin" label="Worker 超时(分钟)" hint="单轮运行超过这个时长会被中断并判为失败" />
          <TextField {...field} name="maxTicketAttempts" label="失败重试次数" hint="Ticket 失败后自动重试的上限,0 表示不重试" />
          <TextField {...field} name="evalBatchMs" label="批处理窗口(毫秒)" hint="窗口内同一线程的多条消息合并成一次 Router 评估" />
          <TextField {...field} name="triggerMaxChars" label="单条消息上限(字符)" hint="超出部分会被截断" />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="委派"
        info="向普通 agent 会话注入 superagent_dispatch 工具,让 agent 自己把工作委派给编排层。走插件自带的本地 MCP 通道,不受 Paseo tools 开关影响。"
      >
        <SettingsCard>
          <SwitchField
            {...field}
            name="agentToolEnabled"
            label="向 agent 注入委派工具"
            hint="在任意会话里也可以直接输入 /superagent <任务>"
          />
          {form.agentToolEnabled ? (
            <TextField
              {...field}
              name="agentToolProviders"
              label="注入的 provider"
              hint="逗号分隔。不支持 MCP 的 provider(如 pi、ACP 系)注入会导致会话启动失败"
              placeholder="claude,codex,opencode,omp,copilot"
            />
          ) : null}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="IM 触发源"
        info="从聊天软件接收指令,Router 的答复回到原聊天。白名单(发送者或会话至少填一项)是硬门槛:全空时该通道不会启动。保存后自动重连,无需重启 daemon。"
      >
        {CHANNELS.map((channel) => (
          <ChannelCard key={channel.enabled} channel={channel} {...field} />
        ))}
        <SettingsCard>
          <TextField {...field} name="imReplyMaxChars" label="IM 回复上限(字符)" hint="发回聊天的答复超出时截断" />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="保存">
        <SettingsCard>
          <SettingsAction
            label={saveLabel}
            error={settings.saveError}
            actionLabel={settings.saving ? "保存中..." : "保存"}
            disabled={!dirty || !parsedValues || settings.saving}
            onPress={() => void save()}
          />
          {dirty || settings.saveError ? (
            <SettingsAction
              label="放弃修改"
              hint={settings.saveError ? "载入别处保存的最新设置,丢弃这里的草稿" : "恢复为已保存的设置"}
              actionLabel="放弃"
              disabled={settings.saving}
              onPress={discard}
            />
          ) : null}
        </SettingsCard>
      </SettingsSection>
    </View>
  );
}

// ---------------------------------------------------------------- Fields

interface FieldContext {
  form: FormValues;
  errors: FormErrors;
  set<K extends keyof FormValues>(key: K, value: FormValues[K]): void;
  disabled: boolean;
}

type TextFieldName = StringKey | NumberSettingKey;

function TextField({
  form,
  errors,
  set,
  disabled,
  name,
  label,
  hint,
  placeholder,
  secret,
  errorOverride,
}: FieldContext & {
  name: TextFieldName;
  label: string;
  hint?: string;
  placeholder?: string;
  secret?: boolean;
  errorOverride?: string | null;
}) {
  return (
    <SettingsInput
      label={label}
      hint={hint}
      placeholder={placeholder}
      initialValue={form[name]}
      onChangeText={(value) => set(name, value)}
      secureTextEntry={secret}
      disabled={disabled}
      error={errors[name] ?? errorOverride ?? null}
    />
  );
}

function SwitchField({
  form,
  set,
  disabled,
  name,
  label,
  hint,
}: FieldContext & { name: BooleanKey; label: string; hint?: string }) {
  return (
    <SettingsSwitch
      label={label}
      hint={hint}
      value={form[name]}
      onValueChange={(value) => set(name, value)}
      disabled={disabled}
    />
  );
}

interface ChannelField {
  name: StringKey;
  label: string;
  hint?: string;
  placeholder?: string;
  secret?: boolean;
  /** 白名单字段:同一通道至少填一个。 */
  allowlist?: boolean;
}

interface Channel {
  enabled: BooleanKey;
  title: string;
  hint: string;
  fields: ChannelField[];
}

const CHANNELS: Channel[] = [
  {
    enabled: "feishuEnabled",
    title: "飞书",
    hint: "官方长连接,免公网;私聊直接触发,群聊需 @机器人",
    fields: [
      { name: "feishuAppId", label: "App ID", placeholder: "cli_..." },
      { name: "feishuAppSecret", label: "App Secret", secret: true },
      { name: "feishuAllowUsers", label: "允许的发送者", hint: "open_id,逗号分隔", allowlist: true },
      { name: "feishuAllowChats", label: "允许的会话", hint: "chat_id,逗号分隔", allowlist: true },
    ],
  },
  {
    enabled: "qqEnabled",
    title: "QQ",
    hint: "OneBot 11(NapCat)正向 WebSocket;群里需 @机器人",
    fields: [
      { name: "qqEndpoint", label: "WebSocket 地址", placeholder: "ws://127.0.0.1:3001" },
      { name: "qqToken", label: "Access Token", hint: "没有设置可留空", secret: true },
      { name: "qqAllowUsers", label: "允许的 QQ 号", hint: "逗号分隔,私聊与群聊通用", allowlist: true },
      { name: "qqAllowGroups", label: "允许的群号", hint: "逗号分隔", allowlist: true },
    ],
  },
  {
    enabled: "dingtalkEnabled",
    title: "钉钉",
    hint: "Stream 模式长连接,免公网;群里被 @ 才会收到",
    fields: [
      { name: "dingtalkClientId", label: "AppKey(ClientId)" },
      { name: "dingtalkClientSecret", label: "AppSecret(ClientSecret)", secret: true },
      { name: "dingtalkAllowUsers", label: "允许的发送者", hint: "staffId,逗号分隔", allowlist: true },
      { name: "dingtalkAllowChats", label: "允许的会话", hint: "conversationId,逗号分隔", allowlist: true },
    ],
  },
  {
    enabled: "wecomEnabled",
    title: "企业微信",
    hint: "智能机器人长连接,免公网;群里需 @机器人",
    fields: [
      { name: "wecomBotId", label: "Bot ID" },
      { name: "wecomSecret", label: "Secret", secret: true },
      { name: "wecomAllowUsers", label: "允许的发送者", hint: "userid,逗号分隔", allowlist: true },
      { name: "wecomAllowChats", label: "允许的群", hint: "chatid,逗号分隔", allowlist: true },
    ],
  },
];

function ChannelCard({ channel, ...field }: FieldContext & { channel: Channel }) {
  const enabled = field.form[channel.enabled];
  const allowlist = channel.fields.filter((f) => f.allowlist);
  const allowlistEmpty = allowlist.every((f) => parseAllowlist(field.form[f.name]).length === 0);
  return (
    <SettingsCard>
      <SwitchField {...field} name={channel.enabled} label={channel.title} hint={channel.hint} />
      {enabled
        ? channel.fields.map((f) => (
            <TextField
              key={f.name}
              {...field}
              name={f.name}
              label={f.label}
              hint={f.hint}
              placeholder={f.placeholder}
              secret={f.secret}
              errorOverride={
                allowlistEmpty && f === allowlist[0] ? "白名单全空时该通道不会启动,至少填写一项" : null
              }
            />
          ))
        : null}
    </SettingsCard>
  );
}
