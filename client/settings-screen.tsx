import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
import { MAX_SPECULATIVE_TICKETS, type SuperagentSnapshot } from "../shared/model";
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
import { STATE_QUERY_KEY, useProviderSnapshot, type ProviderSnapshotEntry } from "./query";
import { fontSize, radius, space } from "./ui";
import { WeixinAccountPanel } from "./weixin-account";

/**
 * Settings → Plugins → Superagent。宿主负责标题栏、返回、滚动与居中栏宽;
 * 这里只按主题分节:工作目录 → 模型 → Router 规则 → Worker 档位 → 执行 → 主动与巡检 → 委派 → IM 触发源 → 保存。
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

/** 模型选择的候选来源:daemon provider 快照的加载状态。 */
type SnapshotState = { entries?: ProviderSnapshotEntry[]; status: "loading" | "ready" | "error" };

function toForm(values: Values): FormValues {
  const form = { ...values } as Record<string, unknown>;
  for (const key of NUMBER_KEYS) form[key] = String(values[key]);
  form.workerProfiles = values.workerProfiles.map((profile, index) => ({ ...profile, key: `saved-${index}` }));
  return form as FormValues;
}

function stripProfileKeys(rows: ProfileRow[]): WorkerProfile[] {
  return rows.map(({ name, provider, modeId, thinkingOptionId, description, workingDir }) => ({ name, provider, modeId, thinkingOptionId, description, workingDir }));
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
    setForm((current) => ({
      ...current,
      [key]: value,
      ...(key === "workerProvider" && splitProviderModel(current.workerProvider).provider !== splitProviderModel(String(value)).provider
        ? { workerModeId: "" } : {}),
    }));
  }, []);

  const nextProfileKey = useRef(0);
  const setProfile = useCallback((key: string, field: ProfileField, value: string) => {
    setForm((current) => ({
      ...current,
      workerProfiles: current.workerProfiles.map((row) => (row.key === key ? {
        ...row, [field]: value,
        ...(field === "provider" && splitProviderModel(row.provider).provider !== splitProviderModel(value).provider
          ? { modeId: "" } : {}),
      } : row)),
    }));
  }, []);
  const addProfile = useCallback(() => {
    nextProfileKey.current += 1;
    const key = `new-${nextProfileKey.current}`;
    setForm((current) => ({
      ...current,
      workerProfiles: [...current.workerProfiles, { key, name: "", provider: "", modeId: "", thinkingOptionId: "", description: "", workingDir: "" }],
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

  // 模型候选:与引擎启动校验同源的 provider 快照;不可用时模型字段回退为手工输入。
  const providers = useProviderSnapshot(hostId);
  const snapshot: SnapshotState = providers.isError
    ? { status: "error" }
    : providers.data
      ? { status: "ready", entries: providers.data }
      : { status: "loading" };

  const disabled = settings.saving;
  const field = { form, errors, set, disabled, snapshot };

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
        info="从 daemon 的 provider 快照中选取(与启动时校验同源),model id 由选项原样带入,不会出现反斜杠转义或笔误;清单读取失败时可退回手工填写 provider 或 provider/model。留空时按 claude → codex → opencode 的顺序自动选择。"
      >
        <SettingsCard>
          <ModelField
            {...field}
            name="routerProvider"
            label="Router"
            hint="只做评估与分派,轻量模型即可"
            emptyLabel="自动选择"
          />
          <ThinkingPicker
            label="Router thinking 档位(可选)"
            providerSelection={form.routerProvider}
            value={form.routerThinkingOptionId}
            onChange={(value) => set("routerThinkingOptionId", value)}
            disabled={disabled}
            error={errors.routerThinkingOptionId ?? null}
            snapshot={snapshot}
            fallbackHint="用于新建或重建的 Router 会话,不影响运行中的会话"
          />
          <ModelField
            {...field}
            name="workerProvider"
            label={form.workerProfiles.length > 0 ? "默认 Worker" : "Worker"}
            hint={
              form.workerProfiles.length > 0
                ? "Router 没有指定档位、或指定的档位不存在时使用"
                : "负责真正干活,建议用最强的模型"
            }
            emptyLabel="自动选择"
          />
          <ModePicker
            label="Worker 模式(可选)"
            providerSelection={form.workerProvider}
            value={form.workerModeId}
            onChange={(value) => set("workerModeId", value)}
            disabled={disabled}
            error={errors.workerModeId ?? null}
            snapshot={snapshot}
          />
          <ThinkingPicker
            label="默认 Worker thinking 档位(可选)"
            providerSelection={form.workerProvider}
            value={form.workerThinkingOptionId}
            onChange={(value) => set("workerThinkingOptionId", value)}
            disabled={disabled}
            error={errors.workerThinkingOptionId ?? null}
            snapshot={snapshot}
            fallbackHint="随新建或重试的 Worker 传入,不修改运行中的会话"
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
            <Text style={{ color: theme.colors.foreground, fontSize: fontSize.base, lineHeight: 20 }}>自定义规则</Text>
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
            <Text style={{ color: errors.routerInstructions ? theme.colors.statusDanger : theme.colors.foregroundMuted, fontSize: fontSize.sm, lineHeight: 18 }}>
              {errors.routerInstructions ? `${errors.routerInstructions},最多 ${MAX_ROUTER_INSTRUCTIONS_CHARS} 字符。` : "留空使用默认规则。内置的职责和输出约束始终保留。"}
              {` ${form.routerInstructions.length}/${MAX_ROUTER_INSTRUCTIONS_CHARS}`}
            </Text>
          </View>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="Worker 档位"
        info="让不同类型的任务跑在不同模型上。Router 派发时按用途说明为每个任务选一个档位;没有选、或选了不存在的名字时用默认 Worker。每个档位可选择该 provider 提供的模式,留空沿用 Paseo 默认,也可另填专属工作目录。模式和模型的修改用于新建或重试的 Worker。"
      >
        {form.workerProfiles.map((row, index) => (
          <ProfileCard
            key={row.key}
            row={row}
            errors={profileErrors[index] ?? {}}
            disabled={disabled}
            snapshot={snapshot}
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
        title="主动与巡检"
        info="投机执行:Router 依据「Router 规则」里写明的主动策略(例如「群里有人反馈问题时,静默复现并尝试简单修复」),对没人明确提出的事项先在后台派 Worker 尝试,结果有价值才交付,否则静默丢弃。LLM 看门狗:独立的巡检会话按间隔检查每个 Worker 是否有实质进展、是否偏离任务,必要时提醒、打断、取消、重试,或交 Router 告诉你;也可以直接打开它的会话问诊。两者都会额外消耗模型调用,默认关闭。"
      >
        <SettingsCard>
          <SwitchField
            {...field}
            name="speculativeEnabled"
            label="投机执行"
            hint={`需要在「Router 规则」里写明主动策略才会触发;同时最多 ${MAX_SPECULATIVE_TICKETS} 个投机任务`}
          />
          <SwitchField {...field} name="watchdogEnabled" label="LLM 看门狗" hint="独立巡检会话,判断 Worker 的进展与偏离" />
          {form.watchdogEnabled ? (
            <>
              <ModelField {...field} name="watchdogProvider" label="看门狗模型" hint="留空沿用 Router 的模型" emptyLabel="同 Router" />
              <TextField {...field} name="watchdogIntervalMin" label="巡检间隔(分钟)" hint="没有进行中的任务、也没有异常时跳过,不调用模型" />
            </>
          ) : null}
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
              hint="逗号分隔。不支持 MCP 的 provider(如 ACP 系)注入会导致会话启动失败;pi 走 pi 扩展通道,填 pi 前先安装扩展(见 README)"
              placeholder="claude,codex,opencode,omp,copilot"
            />
          ) : null}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="IM 触发源"
        info="从聊天软件接收指令,Router 的答复回到原聊天。白名单(发送者或会话至少填一项)是硬门槛:全空时该通道不会启动;微信的扫码人自动在白名单内。保存后自动重连,无需重启 daemon。"
      >
        {CHANNELS.map((channel) => (
          <ChannelCard key={channel.enabled} channel={channel} {...field}>
            {channel.enabled === "weixinEnabled" ? (
              <WeixinAccountPanel hostId={hostId} theme={theme} savedEnabled={settings.values.weixinEnabled} />
            ) : null}
          </ChannelCard>
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
  snapshot,
  onChange,
  onRemove,
}: {
  row: ProfileRow;
  errors: ProfileErrors[number];
  disabled: boolean;
  snapshot: SnapshotState;
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
      <ModelPicker
        label="Provider"
        hint="从 daemon 的 provider 快照中选取;清单缺失时可手动填写 provider/model"
        placeholder="codex/gpt-5.5"
        value={row.provider}
        onChange={(value) => onChange(row.key, "provider", value)}
        disabled={disabled}
        error={errors.provider ?? null}
        snapshot={snapshot}
        emptyLabel="未选择"
      />
      <ModePicker
        label="模式(可选)"
        providerSelection={row.provider}
        value={row.modeId}
        onChange={(value) => onChange(row.key, "modeId", value)}
        disabled={disabled}
        error={errors.modeId ?? null}
        snapshot={snapshot}
      />
      <ThinkingPicker
        label="thinking 档位(可选)"
        providerSelection={row.provider}
        value={row.thinkingOptionId}
        onChange={(value) => onChange(row.key, "thinkingOptionId", value)}
        disabled={disabled}
        error={errors.thinkingOptionId ?? null}
        snapshot={snapshot}
        fallbackHint="留空不继承默认 Worker 的档位"
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
  snapshot: SnapshotState;
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

/** 与引擎 resolveProviderSelection 相同的切分:第一个 `/` 前是 provider,其余是 model id。 */
function splitProviderModel(value: string): { provider: string; model: string } {
  const separator = value.indexOf("/");
  if (separator === -1) return { provider: value.trim(), model: "" };
  return { provider: value.slice(0, separator).trim(), model: value.slice(separator + 1).trim() };
}

function providerOptionLabel(entry: ProviderSnapshotEntry): string {
  const label = entry.label && entry.label !== entry.provider ? `${entry.label}(${entry.provider})` : entry.provider;
  if (entry.enabled === false) return `${label}(已禁用)`;
  if (entry.status === "loading") return `${label}(加载中)`;
  if (entry.status !== "ready") return `${label}(未就绪)`;
  return label;
}

/** 模式来自 provider 快照(含 ACP 动态发现),空值始终表示不传 modeId。 */
function ModePicker({
  label, providerSelection, value, onChange, disabled, error, snapshot,
}: {
  label: string;
  providerSelection: string;
  value: string;
  onChange(value: string): void;
  disabled: boolean;
  error: string | null;
  snapshot: SnapshotState;
}) {
  const { provider } = splitProviderModel(providerSelection);
  const entry = snapshot.entries?.find((candidate) => candidate.provider === provider);
  const modes = entry?.modes ?? [];
  const selected = modes.find((mode) => mode.id === value);
  const options = [
    { label: "Paseo 默认", value: "" },
    ...modes.map((mode) => ({ label: mode.label || mode.id, value: mode.id })),
    ...(value && !selected ? [{ label: `${value}(已保存,当前未上报)`, value }] : []),
  ];
  const hint = !provider
    ? "先选择 Worker 的 provider,即可查看其模式;留空沿用 Paseo 默认"
    : snapshot.status === "loading" || entry?.status === "loading"
      ? "正在读取该 provider 的模式;留空沿用 Paseo 默认"
      : snapshot.status === "error"
        ? "无法读取模式列表,可稍后重新打开设置;已保存的选择会保留"
        : value && !selected
          ? "该 provider 当前未上报已保存的模式,请核对或选择 Paseo 默认"
          : modes.length === 0
            ? "该 provider 未上报可选模式,留空沿用 Paseo 默认"
            : selected?.description ?? "留空沿用 Paseo 默认;所选模式用于新建或重试的 Worker";
  return (
    <SettingsSelect
      label={label}
      hint={hint}
      value={value}
      options={options}
      onValueChange={onChange}
      disabled={disabled}
      error={error}
    />
  );
}

/**
 * thinking 档位选择:候选取所选 provider/model 的 thinkingOptions(pi 为 low/medium/high/…)。
 * 快照缺 thinking 清单时退化为手工输入(已保存值带入),不在插件层拦截。
 */
function ThinkingPicker({
  label, providerSelection, value, onChange, disabled, error, snapshot, fallbackHint,
}: {
  label: string;
  providerSelection: string;
  value: string;
  onChange(value: string): void;
  disabled: boolean;
  error: string | null;
  snapshot: SnapshotState;
  fallbackHint: string;
}) {
  const { provider, model } = splitProviderModel(providerSelection);
  const entry = snapshot.entries?.find((candidate) => candidate.provider === provider);
  const models = entry?.models ?? [];
  const candidates = model ? models.filter((row) => row.id === model) : models;
  const reported = candidates.filter((row) => Array.isArray(row.thinkingOptions));
  // 该 provider/model 未上报 thinking 清单(或快照不可用):退化为手工输入,保留空值=provider 默认。
  if (reported.length === 0) {
    return (
      <SettingsInput
        key={providerSelection}
        label={label}
        hint={`${fallbackHint};当前快照未上报 thinking 档位,可手工填写档位 id(如 high),留空使用 provider 默认`}
        placeholder="留空使用 provider 默认"
        initialValue={value}
        onChangeText={onChange}
        disabled={disabled}
        error={error}
      />
    );
  }
  const options = [
    { label: "Provider 默认", value: "" },
    ...reported.flatMap((row) =>
      (row.thinkingOptions ?? []).map((option) => ({ label: option.label || option.id, value: option.id })),
    ),
    ...(value && !reported.some((row) => (row.thinkingOptions ?? []).some((option) => option.id === value))
      ? [{ label: `${value}(已保存,未在快照中)`, value }]
      : []),
  ];
  return (
    <SettingsSelect
      label={label}
      hint={`留空沿用 provider 默认档位;${fallbackHint}`}
      value={value}
      options={options}
      onValueChange={onChange}
      disabled={disabled}
      error={error}
    />
  );
}

/**
 * Provider/Model 选择:候选来自 daemon 的 provider 快照,选中即写入准确 id
 * (含 ACP 系带反斜杠的 model id),从根本上避免手填转义错误。
 * 快照不可用、或所选 provider 没有上报模型清单时,回退为手工输入。
 */
function ModelPicker({
  label,
  hint,
  placeholder,
  error,
  disabled,
  value,
  onChange,
  snapshot,
  emptyLabel,
}: {
  label: string;
  hint?: string;
  placeholder?: string;
  error?: string | null;
  disabled?: boolean;
  value: string;
  onChange(value: string): void;
  snapshot: SnapshotState;
  /** 留空选项的文案;不提供时字段必填。 */
  emptyLabel?: string;
}) {
  if (!snapshot.entries) {
    const stateHint =
      snapshot.status === "loading"
        ? "正在读取 daemon 的 provider 列表,也可先手动填写 provider 或 provider/model"
        : "无法读取 daemon 的 provider 列表(连接异常或版本过旧),请手动填写 provider 或 provider/model";
    return (
      <SettingsInput
        label={label}
        hint={hint ? `${hint};${stateHint}` : stateHint}
        placeholder={placeholder ?? "provider/model"}
        initialValue={value}
        onChangeText={onChange}
        disabled={disabled}
        error={error ?? null}
      />
    );
  }

  const { provider, model } = splitProviderModel(value);
  const entry = snapshot.entries.find((candidate) => candidate.provider === provider);
  // 已禁用的 provider 不进候选;仅当已保存的值正好是它时保留为选项,避免被静默清掉。
  const enabled = snapshot.entries.filter((candidate) => candidate.enabled !== false);
  const providerOptions = [
    ...(emptyLabel ? [{ label: emptyLabel, value: "" }] : []),
    ...enabled.map((candidate) => ({ label: providerOptionLabel(candidate), value: candidate.provider })),
    ...(provider && !enabled.some((candidate) => candidate.provider === provider)
      ? [{ label: entry ? providerOptionLabel(entry) : `${provider}(本机未提供)`, value: provider }]
      : []),
  ];
  const models = entry?.models ?? [];
  if (provider && models.length > 0) {
    const fallback = models.find((candidate) => candidate.isDefault) ?? models[0];
    const modelOptions = [
      { label: `默认模型(${fallback.label || fallback.id})`, value: "" },
      ...models.map((candidate) => ({ label: candidate.label || candidate.id, value: candidate.id })),
      ...(model && !models.some((candidate) => candidate.id === model)
        ? [{ label: `${model}(不在清单)`, value: model }]
        : []),
    ];
    return (
      <>
        <SettingsSelect
          label={label}
          hint={hint}
          value={provider}
          options={providerOptions}
          onValueChange={(next) => {
            // 重选同一 provider 时保留原值,不清掉已选 model。
            if (next !== provider) onChange(next);
          }}
          disabled={disabled}
          error={error ?? null}
        />
        <SettingsSelect
          label="Model"
          hint="选项 id 原样写入;「默认模型」只填 provider,由引擎按快照取默认"
          value={model}
          options={modelOptions}
          onValueChange={(next) => onChange(next ? `${provider}/${next}` : provider)}
          disabled={disabled}
        />
      </>
    );
  }
  return (
    <>
      <SettingsSelect
        label={label}
        hint={hint}
        value={provider}
        options={providerOptions}
        onValueChange={(next) => {
          if (next !== provider) onChange(next);
        }}
        disabled={disabled}
        error={error ?? null}
      />
      {provider ? (
        // 该 provider 未上报模型清单(如部分 ACP/custom provider):手填完整值。
        // key 绑定 provider,切换 provider 时输入框重挂载以显示新值。
        <SettingsInput
          key={provider}
          label="Model(手动)"
          hint={entry ? "该 provider 未上报模型清单,手动填写 provider 或 provider/model" : "该 provider 不在 daemon 清单中,请手动核对"}
          placeholder={placeholder ?? "provider/model"}
          initialValue={value}
          onChangeText={onChange}
          disabled={disabled}
        />
      ) : null}
    </>
  );
}

function ModelField({
  form,
  errors,
  set,
  disabled,
  snapshot,
  name,
  label,
  hint,
  emptyLabel,
}: FieldContext & { name: StringKey; label: string; hint?: string; emptyLabel?: string }) {
  return (
    <ModelPicker
      label={label}
      hint={hint}
      value={form[name]}
      onChange={(value) => set(name, value)}
      disabled={disabled}
      error={errors[name] ?? null}
      snapshot={snapshot}
      emptyLabel={emptyLabel}
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
  /** 白名单可以全空:登录者自动允许(微信扫码人)。 */
  allowlistOptional?: boolean;
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
  {
    enabled: "weixinEnabled",
    title: "微信",
    hint: "腾讯官方 ClawBot(iLink)通道,扫码登录,免公网;仅私聊",
    allowlistOptional: true,
    fields: [
      {
        name: "weixinAllowUsers",
        label: "另外允许的用户",
        hint: "扫码人自动允许;其他人填微信用户 ID(xxx@im.wechat),逗号分隔",
        allowlist: true,
      },
    ],
  },
];

function ChannelCard({ channel, children, ...field }: FieldContext & { channel: Channel; children?: ReactNode }) {
  const enabled = field.form[channel.enabled];
  const allowlist = channel.fields.filter((f) => f.allowlist);
  const allowlistEmpty = !channel.allowlistOptional && allowlist.every((f) => parseAllowlist(field.form[f.name]).length === 0);
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
      {enabled ? children : null}
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
