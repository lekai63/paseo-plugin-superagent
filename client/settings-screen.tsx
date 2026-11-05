import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  TextInput,
} from "@getpaseo/plugin/client/ui";
import type { SuperagentSnapshot } from "../shared/model";
import {
  MAX_WORKER_PROFILES,
  MAX_ROUTER_INSTRUCTIONS_CHARS,
  NUMBER_LIMITS,
  parseAllowlist,
  superagentSettings,
  WORKER_PROFILE_NAME_HINT,
  type NumberSettingKey,
  type SuperagentSettingsValues,
  type WorkerProfile,
} from "../shared/settings";
import { STATE_QUERY_KEY } from "./query";
import { fontSize, radius, space } from "./ui";

/**
 * Settings → Plugins → Superagent。宿主负责标题栏、返回、滚动与居中栏宽;
 * 这里只按主题分节:工作目录 → 模型 → Router 规则 → Worker 档位 → 执行 → 委派 → IM 触发源 → 保存。
 *
 * 所有修改先进草稿,统一保存(规则用于下一次评估,IM 配置变更会重连)。
 * 数值字段在草稿里是字符串,便于边输入边校验。
 */

type Values = SuperagentSettingsValues;
type Ready = Extract<SettingsState<typeof superagentSettings.schema>, { status: "ready" }>;
/** 档位行带一个本地 key:SettingsInput 只在挂载时读初值,删行时其余行不能重新挂载。 */
type ProfileRow = WorkerProfile & { key: string };
type ProfileField = keyof WorkerProfile;
type ProfileErrors = Partial<Record<ProfileField, string>>[];
type FormValues = {
  [K in keyof Values]: K extends "workerProfiles" ? ProfileRow[] : Values[K] extends number ? string : Values[K];
};
type FormErrors = Partial<Record<keyof Values, string>>;
type StringKey = { [K in keyof Values]: Values[K] extends string ? K : never }[keyof Values];
type BooleanKey = { [K in keyof Values]: Values[K] extends boolean ? K : never }[keyof Values];

const NUMBER_KEYS = Object.keys(NUMBER_LIMITS) as NumberSettingKey[];

function toForm(values: Values): FormValues {
  const form = { ...values } as Record<string, unknown>;
  for (const key of NUMBER_KEYS) form[key] = String(values[key]);
  form.workerProfiles = values.workerProfiles.map((profile, index) => ({ ...profile, key: `saved-${index}` }));
  return form as FormValues;
}

function stripProfileKeys(rows: ProfileRow[]): WorkerProfile[] {
  return rows.map(({ name, provider, description, workingDir }) => ({ name, provider, description, workingDir }));
}

/** 草稿比较用的序列化:去掉档位行的本地 key。 */
function comparable(form: FormValues): string {
  return JSON.stringify({ ...form, workerProfiles: stripProfileKeys(form.workerProfiles) });
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

function parseForm(form: FormValues): { values: Values | null; errors: FormErrors; profileErrors: ProfileErrors } {
  const errors: FormErrors = {};
  const profileErrors: ProfileErrors = form.workerProfiles.map(() => ({}));
  const raw = { ...form, workerProfiles: stripProfileKeys(form.workerProfiles) } as Record<string, unknown>;
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
  // 档位专属目录:留空合法(用全局工作目录),填写时必须是绝对路径。
  form.workerProfiles.forEach((row, index) => {
    const dir = row.workingDir.trim();
    if (dir && !isAbsolutePath(dir)) {
      profileErrors[index] = { ...profileErrors[index], workingDir: "需要绝对路径,留空使用上方的工作目录" };
    }
  });

  const parsed = superagentSettings.schema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = issue.path[0] as keyof Values | undefined;
      const message = issue.code === "too_big" ? "内容过长" : issue.message;
      if (key === "workerProfiles" && typeof issue.path[1] === "number") {
        // 档位错误标在对应行的对应输入框上。
        const row = profileErrors[issue.path[1]];
        const field = issue.path[2] as ProfileField | undefined;
        if (row && field && !row[field]) row[field] = message;
        else if (row && !field && !row.name) row.name = message;
        continue;
      }
      if (key && !errors[key]) errors[key] = message;
    }
  }
  const valid = parsed.success && Object.keys(errors).length === 0 && countProfileErrors(profileErrors) === 0;
  return { values: valid ? parsed.data : null, errors, profileErrors };
}

function countProfileErrors(profileErrors: ProfileErrors): number {
  return profileErrors.reduce((total, row) => total + Object.keys(row).length, 0);
}

export function SuperagentSettingsScreen({ theme, host }: PluginSurfaceProps) {
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
  return <SettingsForm settings={settings} hostId={host.id} theme={theme} />;
}

function SettingsForm({ settings, hostId, theme }: { settings: Ready; hostId: string; theme: PluginSurfaceProps["theme"] }) {
  // 草稿与它基于的 revision 一起保存:别的客户端先保存时,这里的保存会冲突而不是静默覆盖。
  const [base, setBase] = useState({ values: settings.values, revision: settings.revision });
  const [form, setForm] = useState<FormValues>(() => toForm(settings.values));
  // SettingsInput 只在挂载时读 initialValue;整体重置草稿时换 key 让输入框重新挂载。
  const [formKey, setFormKey] = useState(0);

  const baseForm = useMemo(() => comparable(toForm(base.values)), [base.values]);
  const dirty = comparable(form) !== baseForm;
  const { values: parsedValues, errors, profileErrors } = useMemo(() => parseForm(form), [form]);
  const errorCount = Object.keys(errors).length + countProfileErrors(profileErrors);

  useEffect(() => {
    if (settings.revision === base.revision) return;
    const latest = comparable(toForm(settings.values));
    if (latest === comparable(form)) {
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

  const nextProfileKey = useRef(0);
  const setProfile = useCallback((key: string, field: ProfileField, value: string) => {
    setForm((current) => ({
      ...current,
      workerProfiles: current.workerProfiles.map((row) => (row.key === key ? { ...row, [field]: value } : row)),
    }));
  }, []);
  const addProfile = useCallback(() => {
    nextProfileKey.current += 1;
    const key = `new-${nextProfileKey.current}`;
    setForm((current) => ({
      ...current,
      workerProfiles: [...current.workerProfiles, { key, name: "", provider: "", description: "", workingDir: "" }],
    }));
  }, []);
  const removeProfile = useCallback((key: string) => {
    setForm((current) => ({ ...current, workerProfiles: current.workerProfiles.filter((row) => row.key !== key) }));
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
  const cached = useQueryClient().getQueryData<SuperagentSnapshot>([...STATE_QUERY_KEY, hostId, {}]);
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
        info="默认的基础目录:Router 与默认 Worker 共用它。共享目录隔离时,两者都住在按此目录创建的「默认 workspace」里;独立 worktree 隔离时,每个 Ticket 从它切出独立分支。Router 的自定义规则在下方直接填写。"
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
            label={form.workerProfiles.length > 0 ? "默认 Worker" : "Worker"}
            hint={
              form.workerProfiles.length > 0
                ? "Router 没有指定档位、或指定的档位不存在时使用"
                : "负责真正干活,建议用最强的模型"
            }
            placeholder="自动选择"
          />
          {form.workerProfiles.length > 0 ? (
            <TextField
              {...field}
              name="workerDescription"
              label="默认 Worker 的用途"
              hint="写进 Router 提示词,和下方各档位的用途一起供 Router 选择;留空时视为「其他档位都不合适的通用任务」"
              placeholder="通用任务、调研、中文文档与报告"
            />
          ) : null}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="Router 规则"
        info="设置答复语言、任务分派偏好和汇报格式。仅影响 Router;保存后从下一次评估开始使用,无需重建会话。"
      >
        <SettingsCard>
          <View style={{ padding: space.lg, gap: space.sm }}>
            <Text style={{ color: theme.colors.foreground, fontSize: fontSize.base }}>自定义规则</Text>
            <TextInput
              accessibilityLabel="Router 自定义规则"
              multiline
              textAlignVertical="top"
              value={form.routerInstructions}
              onChangeText={(value) => set("routerInstructions", value)}
              editable={!disabled}
              placeholder={"面向用户使用中文。\n独立任务分别派发给 Worker。\n汇报包含结论、产出路径、验证情况与未解决问题。"}
              placeholderTextColor={theme.colors.foregroundMuted}
              style={{
                minHeight: 180, maxHeight: 420, padding: space.md, borderWidth: 1,
                borderColor: errors.routerInstructions ? theme.colors.statusDanger : theme.colors.border,
                borderRadius: radius.md, backgroundColor: theme.colors.surface0,
                color: theme.colors.foreground, fontSize: fontSize.base, lineHeight: 22,
                opacity: disabled ? 0.5 : 1,
              }}
            />
            <Text style={{ color: errors.routerInstructions ? theme.colors.statusDanger : theme.colors.foregroundMuted, fontSize: fontSize.sm }}>
              {errors.routerInstructions ? `${errors.routerInstructions},最多 ${MAX_ROUTER_INSTRUCTIONS_CHARS} 字符。` : "留空使用默认规则。内置的职责和输出约束始终保留。"}
              {` ${form.routerInstructions.length}/${MAX_ROUTER_INSTRUCTIONS_CHARS}`}
            </Text>
          </View>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="Worker 档位"
        info="让不同类型的任务跑在不同模型上。Router 派发时按用途说明为每个任务选一个档位;没有选、或选了不存在的名字时用默认 Worker。Router 只能使用这里列出的模型。档位可另填专属工作目录,让该档位的 Worker 在别的仓库或目录里工作。"
      >
        {form.workerProfiles.map((row, index) => (
          <ProfileCard
            key={row.key}
            row={row}
            errors={profileErrors[index] ?? {}}
            disabled={disabled}
            onChange={setProfile}
            onRemove={removeProfile}
          />
        ))}
        <SettingsCard>
          <SettingsAction
            label={form.workerProfiles.length > 0 ? `已配置 ${form.workerProfiles.length} 个档位` : "只使用默认 Worker"}
            hint={
              form.workerProfiles.length >= MAX_WORKER_PROFILES
                ? `最多 ${MAX_WORKER_PROFILES} 个档位`
                : "例如:code → codex,负责写码、修 bug、跑测试"
            }
            actionLabel="添加档位"
            disabled={disabled || form.workerProfiles.length >= MAX_WORKER_PROFILES}
            onPress={addProfile}
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
          <TextField {...field} name="imReplyMaxChars" label="IM 单条消息上限(字符)" hint="包含分段序号;长答复自动分成多条依次发完" />
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

function ProfileCard({
  row,
  errors,
  disabled,
  onChange,
  onRemove,
}: {
  row: ProfileRow;
  errors: ProfileErrors[number];
  disabled: boolean;
  onChange(key: string, field: ProfileField, value: string): void;
  onRemove(key: string): void;
}) {
  return (
    <SettingsCard>
      <SettingsInput
        label="档位名"
        hint={`Router 在派发时填写的名字;${WORKER_PROFILE_NAME_HINT}`}
        placeholder="code"
        initialValue={row.name}
        onChangeText={(value) => onChange(row.key, "name", value)}
        disabled={disabled}
        error={errors.name ?? null}
      />
      <SettingsInput
        label="Provider / Model"
        hint="格式同上方的 Worker,保存后启动时会对照 provider 列表校验"
        placeholder="codex/gpt-5.5"
        initialValue={row.provider}
        onChangeText={(value) => onChange(row.key, "provider", value)}
        disabled={disabled}
        error={errors.provider ?? null}
      />
      <SettingsInput
        label="工作目录(可选)"
        hint="该档位 Worker 的专属基础目录,可与上方的工作目录不同;留空使用它。共享目录隔离时以其档位名单独建工作区"
        placeholder="留空使用上方的工作目录"
        initialValue={row.workingDir}
        onChangeText={(value) => onChange(row.key, "workingDir", value)}
        disabled={disabled}
        error={errors.workingDir ?? null}
      />
      <SettingsInput
        label="用途"
        hint="原样写进 Router 提示词:说清楚哪类任务该交给这个档位"
        placeholder="仓库内写码、修 bug、重构、跑测试"
        initialValue={row.description}
        onChangeText={(value) => onChange(row.key, "description", value)}
        disabled={disabled}
        error={errors.description ?? null}
      />
      <SettingsAction
        label="删除这个档位"
        hint="运行中的任务不受影响;尚未启动或之后重试的任务会改用默认 Worker"
        actionLabel="删除"
        disabled={disabled}
        onPress={() => onRemove(row.key)}
      />
    </SettingsCard>
  );
}

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
  /** 群聊观察模式开关(未 @ 的群消息作为上下文交给 Router);仅支持该模式的通道填写。 */
  observe?: BooleanKey;
}

const CHANNELS: Channel[] = [
  {
    enabled: "feishuEnabled",
    title: "飞书",
    hint: "官方长连接,免公网;私聊直接触发,群聊需 @机器人",
    observe: "feishuObserve",
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
    observe: "qqObserve",
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
      {enabled && channel.observe ? (
        <SwitchField
          {...field}
          name={channel.observe}
          label="群聊观察模式"
          hint="未 @ 机器人的群消息作为上下文交给 Router 判断,不再丢弃;关闭时记为已过滤留痕"
        />
      ) : null}
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
