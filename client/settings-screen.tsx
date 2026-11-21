import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
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
  type SettingsSectionProps,
} from "@getpaseo/plugin/client/ui";
import { MAX_SPECULATIVE_TICKETS, type SuperagentSnapshot } from "../shared/model";
import {
  MAX_WORKER_PROFILES,
  MAX_ROUTER_INSTRUCTIONS_CHARS,
  NUMBER_LIMITS,
  parseAllowlist,
  settingsIssueText,
  superagentSettings,
  WORKER_PROFILE_NAME_HINT,
  type NumberSettingKey,
  type SuperagentSettingsValues,
  type WorkerProfile,
} from "../shared/settings";
import type { MessageKey, Translate } from "../shared/i18n";
import { isDecisionProviderExcluded } from "../shared/decision-provider";
import { isPiProviderSelection, type PiPermissionModes } from "../shared/pi-modes";
import { useT } from "./i18n";
import { STATE_QUERY_KEY, usePiPermissionModes, useProviderSnapshot, type ProviderSnapshotEntry } from "./query";
import { fontSize, radius, space } from "./ui";
import { WeixinAccountPanel } from "./weixin-account";

/**
 * Settings → Plugins → Superagent。宿主负责标题栏、返回、滚动与居中栏宽,并按注册顺序把
 * 多个设置页渲染成标签页:基础 → 模型 → 规则 → 执行 → IM 触发源。
 *
 * 所有修改进同一份模块级草稿(切换标签页不会丢),统一保存(规则用于下一次评估,
 * IM 配置变更会重连)。数值字段在草稿里是字符串,便于边输入边校验。
 */

/** 宿主为每个 addSettingsScreen 渲染一个标签页;这里是本插件的标签页 id。 */
export type SettingsTab = "general" | "models" | "rules" | "execution" | "im";

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
/** pi 权限模式的候选来源:daemon 主机上 pi-permission-modes 扩展的读取状态。 */
type PiModesState = { modes?: PiPermissionModes; status: "loading" | "ready" | "error" };

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

function parseForm(form: FormValues, t: Translate): { values: Values | null; errors: FormErrors; profileErrors: ProfileErrors } {
  const errors: FormErrors = {};
  const profileErrors: ProfileErrors = form.workerProfiles.map(() => ({}));
  const raw = { ...form, workerProfiles: stripProfileKeys(form.workerProfiles) } as Record<string, unknown>;
  for (const key of NUMBER_KEYS) {
    const { min, max } = NUMBER_LIMITS[key];
    const text = form[key].trim();
    const value = /^\d+$/.test(text) ? Number(text) : Number.NaN;
    if (!Number.isInteger(value) || value < min || value > max) {
      errors[key] = t("settings.validation.intRange", { min, max });
    }
    raw[key] = value;
  }
  const workingDir = form.workingDir.trim();
  if (workingDir && !isAbsolutePath(workingDir)) errors.workingDir = t("settings.validation.absolutePath");
  const imInboxDir = form.imInboxDir.trim();
  if (imInboxDir && !isAbsolutePath(imInboxDir)) errors.imInboxDir = t("settings.validation.absolutePathInbox");
  // 档位专属目录:留空合法(用全局工作目录),填写时必须是绝对路径。
  form.workerProfiles.forEach((row, index) => {
    const dir = row.workingDir.trim();
    if (dir && !isAbsolutePath(dir)) {
      profileErrors[index] = { ...profileErrors[index], workingDir: t("settings.validation.absolutePathProfile") };
    }
  });

  const parsed = superagentSettings.schema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = issue.path[0] as keyof Values | undefined;
      const message = settingsIssueText(issue, t);
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

interface Draft {
  base: { values: Values; revision: Ready["revision"] };
  form: FormValues;
}

/** 草稿按 host 存放:宿主切换标签页会卸载界面组件,草稿必须活在组件之外。 */
const drafts = new Map<string, Draft>();

/** 档位行的本地 key 在标签页切换后仍要唯一,所以计数器也放在组件外。 */
let profileKeySeed = 0;
function newProfileKey(): string {
  profileKeySeed += 1;
  return `new-${profileKeySeed}`;
}

function draftFor(hostId: string, settings: Ready): Draft {
  let draft = drafts.get(hostId);
  if (!draft) {
    draft = {
      base: { values: settings.values, revision: settings.revision },
      form: toForm(settings.values),
    };
    drafts.set(hostId, draft);
  }
  return draft;
}

function isDraftDirty(draft: Draft): boolean {
  return comparable(draft.form) !== comparable(toForm(draft.base.values));
}

export function SuperagentGeneralSettingsScreen(props: PluginSurfaceProps) {
  return <SettingsScreen {...props} tab="general" />;
}

export function SuperagentModelSettingsScreen(props: PluginSurfaceProps) {
  return <SettingsScreen {...props} tab="models" />;
}

export function SuperagentRuleSettingsScreen(props: PluginSurfaceProps) {
  return <SettingsScreen {...props} tab="rules" />;
}

export function SuperagentExecutionSettingsScreen(props: PluginSurfaceProps) {
  return <SettingsScreen {...props} tab="execution" />;
}

export function SuperagentImSettingsScreen(props: PluginSurfaceProps) {
  return <SettingsScreen {...props} tab="im" />;
}

function SettingsScreen({ tab, theme, host }: PluginSurfaceProps & { tab: SettingsTab }) {
  const settings = useSettings(superagentSettings);
  const t = useT();

  if (settings.status === "loading") {
    return <Text style={{ color: theme.colors.foregroundMuted, fontSize: 14 }}>{t("settings.unavailable.loading")}</Text>;
  }
  if (settings.status !== "ready") {
    return (
      <SettingsSection title={t("settings.unavailable.title")}>
        <SettingsCard>
          <SettingsAction
            label={t("settings.unavailable.readFailed")}
            hint={settings.error}
            actionLabel={t("settings.unavailable.reload")}
            onPress={() => void settings.reload()}
          />
          {settings.status === "invalid" ? (
            <SettingsAction
              label={t("settings.unavailable.restoreLabel")}
              hint={t("settings.unavailable.restoreHint")}
              actionLabel={t("settings.unavailable.restoreAction")}
              onPress={() => void settings.reset()}
            />
          ) : null}
        </SettingsCard>
      </SettingsSection>
    );
  }
  return <SettingsForm settings={settings} hostId={host.id} theme={theme} tab={tab} />;
}

/** 只属于某个标签页的分组;不在当前标签页时整段不渲染。 */
function TabSection({ tab, active, ...props }: SettingsSectionProps & { tab: SettingsTab; active: SettingsTab }) {
  if (tab !== active) return null;
  return <SettingsSection {...props} />;
}

function SettingsForm({ settings, hostId, theme, tab }: { settings: Ready; hostId: string; theme: PluginSurfaceProps["theme"]; tab: SettingsTab }) {
  const t = useT();
  // 草稿与它基于的 revision 一起保存:别的客户端先保存时,这里的保存会冲突而不是静默覆盖。
  const draft = draftFor(hostId, settings);
  const [, setVersion] = useState(0);
  const rerender = useCallback(() => setVersion((value) => value + 1), []);
  // SettingsInput 只在挂载时读 initialValue;整体重置草稿时换 key 让输入框重新挂载。
  const [formKey, setFormKey] = useState(0);

  const form = draft.form;
  const dirty = isDraftDirty(draft);
  const { values: parsedValues, errors, profileErrors } = useMemo(() => parseForm(form, t), [form, t]);
  const errorCount = Object.keys(errors).length + countProfileErrors(profileErrors);

  useEffect(() => {
    if (settings.revision === draft.base.revision) return;
    const latest = comparable(toForm(settings.values));
    if (latest === comparable(draft.form)) {
      // 自己刚保存成功:草稿已等于新值,只推进 revision。
      draft.base = { values: settings.values, revision: settings.revision };
      rerender();
    } else if (!isDraftDirty(draft)) {
      // 别处改了设置,本地没有未保存修改:直接跟上。
      draft.base = { values: settings.values, revision: settings.revision };
      draft.form = toForm(settings.values);
      setFormKey((key) => key + 1);
      rerender();
    }
    // 有未保存修改时保留草稿;保存会因 revision 过期而失败,并提示载入最新。
  }, [draft, rerender, settings.revision, settings.values]);

  const set = useCallback(<K extends keyof FormValues>(key: K, value: FormValues[K]) => {
    const current = draft.form;
    draft.form = {
      ...current,
      [key]: value,
      ...(key === "workerProvider" && splitProviderModel(current.workerProvider).provider !== splitProviderModel(String(value)).provider
        ? { workerModeId: "" } : {}),
    };
    rerender();
  }, [draft, rerender]);

  const setProfile = useCallback((key: string, profileField: ProfileField, value: string) => {
    draft.form = {
      ...draft.form,
      workerProfiles: draft.form.workerProfiles.map((row) => (row.key === key ? {
        ...row, [profileField]: value,
        ...(profileField === "provider" && splitProviderModel(row.provider).provider !== splitProviderModel(value).provider
          ? { modeId: "" } : {}),
      } : row)),
    };
    rerender();
  }, [draft, rerender]);
  const addProfile = useCallback(() => {
    draft.form = {
      ...draft.form,
      workerProfiles: [...draft.form.workerProfiles, { key: newProfileKey(), name: "", provider: "", modeId: "", thinkingOptionId: "", description: "", workingDir: "" }],
    };
    rerender();
  }, [draft, rerender]);
  const removeProfile = useCallback((key: string) => {
    draft.form = { ...draft.form, workerProfiles: draft.form.workerProfiles.filter((row) => row.key !== key) };
    rerender();
  }, [draft, rerender]);

  const save = useCallback(async () => {
    if (!parsedValues) return;
    await settings.save(parsedValues, draft.base.revision);
  }, [draft, parsedValues, settings]);

  const discard = useCallback(() => {
    draft.base = { values: settings.values, revision: settings.revision };
    draft.form = toForm(settings.values);
    setFormKey((key) => key + 1);
    rerender();
  }, [draft, rerender, settings.revision, settings.values]);

  // 主界面已拉取过状态时,把服务端检出的工作目录问题标在对应输入行上(只读缓存,不发请求)。
  const cached = useQueryClient().getQueryData<SuperagentSnapshot>([...STATE_QUERY_KEY, hostId, {}]);
  const serverIssue =
    cached?.workingDirIssue && cached.workingDir === settings.values.workingDir && form.workingDir === settings.values.workingDir
      ? t("settings.serverIssue", { issue: cached.workingDirIssue })
      : null;

  // 模型候选:与引擎启动校验同源的 provider 快照;不可用时模型字段回退为手工输入。
  const providers = useProviderSnapshot(hostId);
  const snapshot: SnapshotState = providers.isError
    ? { status: "error" }
    : providers.data
      ? { status: "ready", entries: providers.data }
      : { status: "loading" };

  // pi 的权限模式候选来自 daemon 主机的 pi-permission-modes(pi 本身不向 Paseo 上报模式)。
  const piModesQuery = usePiPermissionModes(hostId);
  const piModes: PiModesState = piModesQuery.isError
    ? { status: "error" }
    : piModesQuery.data
      ? { status: "ready", modes: piModesQuery.data }
      : { status: "loading" };

  const disabled = settings.saving;
  const field = { form, errors, set, disabled, snapshot, piModes };

  let saveLabel = t("settings.status.saved");
  if (dirty) saveLabel = errorCount > 0 ? t("settings.status.errors", { count: errorCount }) : t("settings.status.unsaved");

  return (
    <View key={formKey}>
      <TabSection tab="general" active={tab}
        title={t("settings.workingDir.title")}
        info={t("settings.workingDir.info")}
      >
        <SettingsCard>
          <TextField
            {...field}
            name="workingDir"
            label={t("settings.workingDir.label")}
            hint={t("settings.workingDir.hint")}
            placeholder="/home/me/project"
            errorOverride={serverIssue}
          />
          <SettingsSelect
            label={t("settings.isolation.label")}
            hint={
              form.workerIsolation === "worktree"
                ? t("settings.isolation.worktreeHint")
                : t("settings.isolation.sharedHint")
            }
            value={form.workerIsolation}
            options={[
              { label: t("settings.isolation.worktree"), value: "worktree" },
              { label: t("settings.isolation.shared"), value: "shared" },
            ]}
            onValueChange={(value) => set("workerIsolation", value)}
            disabled={disabled}
          />
          <SwitchField
            {...field}
            name="workerBackground"
            label={t("settings.workerBackground.label")}
            hint={t("settings.workerBackground.hint")}
          />
        </SettingsCard>
      </TabSection>

      <TabSection tab="models" active={tab}
        title={t("settings.model.title")}
        info={t("settings.model.info")}
      >
        <SettingsCard>
          <ModelField
            {...field}
            name="routerProvider"
            label="Router"
            hint={t("settings.model.routerHint")}
            emptyLabel={t("settings.model.auto")}
            decisionOnly
          />
          <ThinkingPicker
            label={t("settings.model.routerThinking")}
            providerSelection={form.routerProvider}
            value={form.routerThinkingOptionId}
            onChange={(value) => set("routerThinkingOptionId", value)}
            disabled={disabled}
            error={errors.routerThinkingOptionId ?? null}
            snapshot={snapshot}
            fallbackHint={t("settings.model.routerThinkingFallback")}
          />
          <ModelField
            {...field}
            name="workerProvider"
            label={form.workerProfiles.length > 0 ? t("settings.model.defaultWorker") : t("settings.model.worker")}
            hint={
              form.workerProfiles.length > 0
                ? t("settings.model.defaultWorkerHint")
                : t("settings.model.workerHint")
            }
            emptyLabel={t("settings.model.auto")}
          />
          <ModePicker
            label={t("settings.model.workerMode")}
            providerSelection={form.workerProvider}
            value={form.workerModeId}
            onChange={(value) => set("workerModeId", value)}
            disabled={disabled}
            error={errors.workerModeId ?? null}
            snapshot={snapshot}
            piModes={piModes}
          />
          <ThinkingPicker
            label={t("settings.model.defaultWorkerThinking")}
            providerSelection={form.workerProvider}
            value={form.workerThinkingOptionId}
            onChange={(value) => set("workerThinkingOptionId", value)}
            disabled={disabled}
            error={errors.workerThinkingOptionId ?? null}
            snapshot={snapshot}
            fallbackHint={t("settings.model.workerThinkingFallback")}
          />
          {form.workerProfiles.length > 0 ? (
            <TextField
              {...field}
              name="workerDescription"
              label={t("settings.model.workerDescriptionLabel")}
              hint={t("settings.model.workerDescriptionHint")}
              placeholder={t("settings.model.workerDescriptionPlaceholder")}
            />
          ) : null}
        </SettingsCard>
      </TabSection>

      <TabSection tab="rules" active={tab}
        title={t("settings.routerRules.title")}
        info={t("settings.routerRules.info")}
      >
        <SettingsCard>
          <View style={{ padding: space.lg, gap: space.sm }}>
            <Text style={{ color: theme.colors.foreground, fontSize: fontSize.base, lineHeight: 20 }}>{t("settings.routerRules.custom")}</Text>
            <TextInput
              accessibilityLabel={t("settings.routerRules.accessibility")}
              multiline
              textAlignVertical="top"
              value={form.routerInstructions}
              onChangeText={(value) => set("routerInstructions", value)}
              editable={!disabled}
              placeholder={t("settings.routerRules.placeholder")}
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
              {errors.routerInstructions ? t("settings.validation.withMax", { error: errors.routerInstructions, max: MAX_ROUTER_INSTRUCTIONS_CHARS }) : t("settings.routerRules.emptyHint")}
              {` ${form.routerInstructions.length}/${MAX_ROUTER_INSTRUCTIONS_CHARS}`}
            </Text>
          </View>
        </SettingsCard>
      </TabSection>

      <TabSection tab="models" active={tab}
        title={t("settings.profiles.title")}
        info={t("settings.profiles.info")}
      >
        {form.workerProfiles.map((row, index) => (
          <ProfileCard
            key={row.key}
            row={row}
            errors={profileErrors[index] ?? {}}
            disabled={disabled}
            snapshot={snapshot}
            piModes={piModes}
            onChange={setProfile}
            onRemove={removeProfile}
          />
        ))}
        <SettingsCard>
          <SettingsAction
            label={form.workerProfiles.length > 0 ? t("settings.profiles.configured", { count: form.workerProfiles.length }) : t("settings.profiles.onlyDefault")}
            hint={
              form.workerProfiles.length >= MAX_WORKER_PROFILES
                ? t("settings.profiles.max", { max: MAX_WORKER_PROFILES })
                : t("settings.profiles.example")
            }
            actionLabel={t("settings.profiles.add")}
            disabled={disabled || form.workerProfiles.length >= MAX_WORKER_PROFILES}
            onPress={addProfile}
          />
        </SettingsCard>
      </TabSection>

      <TabSection tab="execution" active={tab} title={t("settings.execution.title")}>
        <SettingsCard>
          <TextField {...field} name="workerTimeoutMin" label={t("settings.execution.workerTimeout.label")} hint={t("settings.execution.workerTimeout.hint")} />
          <TextField {...field} name="routerEvalTimeoutMin" label={t("settings.execution.routerEvalTimeout.label")} hint={t("settings.execution.routerEvalTimeout.hint")} />
          <TextField {...field} name="routerIdleTimeoutMin" label={t("settings.execution.routerIdleTimeout.label")} hint={t("settings.execution.routerIdleTimeout.hint")} />
          <TextField {...field} name="threadIdleTimeoutMin" label={t("settings.execution.threadIdleTimeout.label")} hint={t("settings.execution.threadIdleTimeout.hint")} />
          <TextField {...field} name="workerIdleTimeoutMin" label={t("settings.execution.workerIdleTimeout.label")} hint={t("settings.execution.workerIdleTimeout.hint")} />
          <TextField {...field} name="maxTicketAttempts" label={t("settings.execution.maxAttempts.label")} hint={t("settings.execution.maxAttempts.hint")} />
          <TextField {...field} name="evalBatchMs" label={t("settings.execution.evalBatch.label")} hint={t("settings.execution.evalBatch.hint")} />
          <TextField {...field} name="triggerMaxChars" label={t("settings.execution.triggerMaxChars.label")} hint={t("settings.execution.triggerMaxChars.hint")} />
        </SettingsCard>
      </TabSection>

      <TabSection tab="rules" active={tab}
        title={t("settings.proactive.title")}
        info={t("settings.proactive.info")}
      >
        <SettingsCard>
          <SwitchField
            {...field}
            name="speculativeEnabled"
            label={t("settings.proactive.speculative.label")}
            hint={t("settings.proactive.speculative.hint", { max: MAX_SPECULATIVE_TICKETS })}
          />
          <SwitchField {...field} name="watchdogEnabled" label={t("settings.proactive.watchdog.label")} hint={t("settings.proactive.watchdog.hint")} />
          {form.watchdogEnabled ? (
            <>
              <ModelField {...field} name="watchdogProvider" label={t("settings.proactive.watchdogModel.label")} hint={t("settings.proactive.watchdogModel.hint")} emptyLabel={t("settings.proactive.watchdogModel.empty")} decisionOnly />
              <TextField {...field} name="watchdogIntervalMin" label={t("settings.proactive.interval.label")} hint={t("settings.proactive.interval.hint")} />
            </>
          ) : null}
        </SettingsCard>
      </TabSection>

      <TabSection tab="general" active={tab}
        title={t("settings.delegation.title")}
        info={t("settings.delegation.info")}
      >
        <SettingsCard>
          <SwitchField
            {...field}
            name="agentToolEnabled"
            label={t("settings.delegation.inject.label")}
            hint={t("settings.delegation.inject.hint")}
          />
          {form.agentToolEnabled ? (
            <TextField
              {...field}
              name="agentToolProviders"
              label={t("settings.delegation.providers.label")}
              hint={t("settings.delegation.providers.hint")}
              placeholder="claude,codex,opencode,omp,copilot"
            />
          ) : null}
        </SettingsCard>
      </TabSection>

      <TabSection tab="im" active={tab}
        title={t("settings.im.title")}
        info={t("settings.im.info")}
      >
        {CHANNELS.map((channel) => (
          <ChannelCard key={channel.enabled} channel={channel} {...field}>
            {channel.enabled === "weixinEnabled" ? (
              <WeixinAccountPanel hostId={hostId} theme={theme} savedEnabled={settings.values.weixinEnabled} />
            ) : null}
          </ChannelCard>
        ))}
        <SettingsCard>
          <TextField {...field} name="imReplyMaxChars" label={t("settings.im.replyMaxChars.label")} hint={t("settings.im.replyMaxChars.hint")} />
          <TextField
            {...field}
            name="imInboxDir"
            label={t("settings.im.inboxDir.label")}
            hint={t("settings.im.inboxDir.hint")}
            placeholder={t("settings.im.inboxDir.placeholder")}
          />
        </SettingsCard>
      </TabSection>

      <SettingsSection title={t("settings.save.title")}>
        <SettingsCard>
          <SettingsAction
            label={saveLabel}
            error={settings.saveError}
            actionLabel={settings.saving ? t("settings.save.saving") : t("settings.save.action")}
            disabled={!dirty || !parsedValues || settings.saving}
            onPress={() => void save()}
          />
          {dirty || settings.saveError ? (
            <SettingsAction
              label={t("settings.save.discardLabel")}
              hint={settings.saveError ? t("settings.save.discardHintConflict") : t("settings.save.discardHint")}
              actionLabel={t("settings.save.discardAction")}
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
  piModes,
  onChange,
  onRemove,
}: {
  row: ProfileRow;
  errors: ProfileErrors[number];
  disabled: boolean;
  snapshot: SnapshotState;
  piModes: PiModesState;
  onChange(key: string, field: ProfileField, value: string): void;
  onRemove(key: string): void;
}) {
  const t = useT();
  return (
    <SettingsCard>
      <SettingsInput
        label={t("settings.profiles.name")}
        hint={t("settings.profiles.nameHint", { hint: t(WORKER_PROFILE_NAME_HINT) })}
        placeholder="code"
        initialValue={row.name}
        onChangeText={(value) => onChange(row.key, "name", value)}
        disabled={disabled}
        error={errors.name ?? null}
      />
      <ModelPicker
        label="Provider"
        hint={t("settings.profiles.providerHint")}
        placeholder="codex/gpt-5.5"
        value={row.provider}
        onChange={(value) => onChange(row.key, "provider", value)}
        disabled={disabled}
        error={errors.provider ?? null}
        snapshot={snapshot}
        emptyLabel={t("settings.profiles.notSelected")}
      />
      <ModePicker
        label={t("settings.profiles.mode")}
        providerSelection={row.provider}
        value={row.modeId}
        onChange={(value) => onChange(row.key, "modeId", value)}
        disabled={disabled}
        error={errors.modeId ?? null}
        snapshot={snapshot}
        piModes={piModes}
      />
      <ThinkingPicker
        label={t("settings.profiles.thinking")}
        providerSelection={row.provider}
        value={row.thinkingOptionId}
        onChange={(value) => onChange(row.key, "thinkingOptionId", value)}
        disabled={disabled}
        error={errors.thinkingOptionId ?? null}
        snapshot={snapshot}
        fallbackHint={t("settings.profiles.thinkingFallback")}
      />
      <SettingsInput
        label={t("settings.profiles.workingDir")}
        hint={t("settings.profiles.workingDirHint")}
        placeholder={t("settings.profiles.workingDirPlaceholder")}
        initialValue={row.workingDir}
        onChangeText={(value) => onChange(row.key, "workingDir", value)}
        disabled={disabled}
        error={errors.workingDir ?? null}
      />
      <SettingsInput
        label={t("settings.profiles.purpose")}
        hint={t("settings.profiles.purposeHint")}
        placeholder={t("settings.profiles.purposePlaceholder")}
        initialValue={row.description}
        onChangeText={(value) => onChange(row.key, "description", value)}
        disabled={disabled}
        error={errors.description ?? null}
      />
      <SettingsAction
        label={t("settings.profiles.removeLabel")}
        hint={t("settings.profiles.removeHint")}
        actionLabel={t("settings.profiles.removeAction")}
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
  piModes: PiModesState;
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

function providerOptionLabel(entry: ProviderSnapshotEntry, t: Translate): string {
  const label = entry.label && entry.label !== entry.provider ? `${entry.label}(${entry.provider})` : entry.provider;
  if (entry.enabled === false) return t("settings.providerOption.disabled", { label });
  if (entry.status === "loading") return t("settings.providerOption.loading", { label });
  if (entry.status !== "ready") return t("settings.providerOption.notReady", { label });
  return label;
}

/**
 * 模式来源:一般 provider 用快照里的 modes(含 ACP 动态发现);pi 家族改用
 * pi-permission-modes 的清单(Paseo 的 pi provider 不上报模式)。空值始终表示不覆盖默认。
 */
function ModePicker({
  label, providerSelection, value, onChange, disabled, error, snapshot, piModes,
}: {
  label: string;
  providerSelection: string;
  value: string;
  onChange(value: string): void;
  disabled: boolean;
  error: string | null;
  snapshot: SnapshotState;
  piModes: PiModesState;
}) {
  const t = useT();
  const { provider } = splitProviderModel(providerSelection);
  const isPi = isPiProviderSelection(providerSelection);
  const entry = snapshot.entries?.find((candidate) => candidate.provider === provider);
  const piReady = piModes.status === "ready" ? piModes.modes : undefined;
  const piAvailable = piReady?.available === true;
  const modes = isPi ? (piReady?.available ? piReady.modes : []) : entry?.modes ?? [];
  const selected = modes.find((mode) => mode.id === value);
  // 扩展未安装(或状态未知)时 pi 没有可选模式:显示「Paseo 默认」,Worker 也按默认启动。
  const shownValue = isPi && (piReady ? !piAvailable : false) ? "" : value;
  const options = [
    { label: t("settings.modePicker.default"), value: "" },
    ...modes.map((mode) => ({ label: mode.label || mode.id, value: mode.id })),
    ...(shownValue && !selected ? [{ label: t("settings.modePicker.saved", { value: shownValue }), value: shownValue }] : []),
  ];
  const piDefaultLabel =
    piReady?.modes.find((mode) => mode.id === piReady.defaultModeId)?.label ?? piReady?.defaultModeId ?? "";
  const hint = !provider
    ? t("settings.modePicker.noProvider")
    : isPi
      ? piModes.status === "loading"
        ? t("settings.modePicker.piLoading")
        : piModes.status === "error"
          ? t("settings.modePicker.piError")
          : !piAvailable
            ? t("settings.modePicker.piMissing")
            : shownValue && !selected
              ? t("settings.modePicker.piSaved", { value: shownValue })
              : t("settings.modePicker.piHint", { defaultMode: piDefaultLabel })
      : snapshot.status === "loading" || entry?.status === "loading"
        ? t("settings.modePicker.loading")
        : snapshot.status === "error"
          ? t("settings.modePicker.error")
          : value && !selected
            ? t("settings.modePicker.missing")
            : modes.length === 0
              ? t("settings.modePicker.none")
              : (selected && "description" in selected ? selected.description : null) ?? t("settings.modePicker.default_hint");
  return (
    <SettingsSelect
      label={label}
      hint={hint}
      value={shownValue}
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
  const t = useT();
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
        hint={t("settings.thinkingPicker.manualHint", { hint: fallbackHint })}
        placeholder={t("settings.thinkingPicker.manualPlaceholder")}
        initialValue={value}
        onChangeText={onChange}
        disabled={disabled}
        error={error}
      />
    );
  }
  const options = [
    { label: t("settings.thinkingPicker.default"), value: "" },
    ...reported.flatMap((row) =>
      (row.thinkingOptions ?? []).map((option) => ({ label: option.label || option.id, value: option.id })),
    ),
    ...(value && !reported.some((row) => (row.thinkingOptions ?? []).some((option) => option.id === value))
      ? [{ label: t("settings.thinkingPicker.saved", { value }), value }]
      : []),
  ];
  return (
    <SettingsSelect
      label={label}
      hint={t("settings.thinkingPicker.hint", { hint: fallbackHint })}
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
  decisionOnly,
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
  /** Router 与看门狗的 provider 选择受限。 */
  decisionOnly?: boolean;
}) {
  const t = useT();
  if (!snapshot.entries) {
    const stateHint =
      snapshot.status === "loading"
        ? t("settings.modelPicker.loading")
        : t("settings.modelPicker.error");
    return (
      <SettingsInput
        label={label}
        hint={hint ? t("settings.modelPicker.withHint", { hint, state: stateHint }) : stateHint}
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
  const enabled = snapshot.entries.filter((candidate) => candidate.enabled !== false
    && !(decisionOnly && isDecisionProviderExcluded(candidate.provider)));
  const providerOptions = [
    ...(emptyLabel ? [{ label: emptyLabel, value: "" }] : []),
    ...enabled.map((candidate) => ({ label: providerOptionLabel(candidate, t), value: candidate.provider })),
    ...(provider && !enabled.some((candidate) => candidate.provider === provider)
      ? [{ label: entry ? providerOptionLabel(entry, t) : t("settings.modelPicker.notProvided", { provider }), value: provider }]
      : []),
  ];
  const models = entry?.models ?? [];
  if (provider && models.length > 0) {
    const fallback = models.find((candidate) => candidate.isDefault) ?? models[0];
    const modelOptions = [
      { label: t("settings.modelPicker.defaultModel", { name: fallback.label || fallback.id }), value: "" },
      ...models.map((candidate) => ({ label: candidate.label || candidate.id, value: candidate.id })),
      ...(model && !models.some((candidate) => candidate.id === model)
        ? [{ label: t("settings.modelPicker.notInList", { model }), value: model }]
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
          hint={t("settings.modelPicker.modelHint")}
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
          label={t("settings.modelPicker.manual")}
          hint={entry ? t("settings.modelPicker.manualNoModels") : t("settings.modelPicker.manualNotInList")}
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
  decisionOnly,
}: FieldContext & { name: StringKey; label: string; hint?: string; emptyLabel?: string; decisionOnly?: boolean }) {
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
      decisionOnly={decisionOnly}
    />
  );
}

interface ChannelField {
  name: StringKey;
  /** 不需翻译的原样标签(如 App ID);需翻译的用 labelKey。 */
  label?: string;
  labelKey?: MessageKey;
  hintKey?: MessageKey;
  placeholder?: string;
  secret?: boolean;
  /** 白名单字段:同一通道至少填一个。 */
  allowlist?: boolean;
}

interface Channel {
  enabled: BooleanKey;
  titleKey: MessageKey;
  hintKey: MessageKey;
  fields: ChannelField[];
  /** 群聊观察模式开关(未 @ 的群消息作为上下文交给 Router);仅支持该模式的通道填写。 */
  observe?: BooleanKey;
  /** 白名单可以全空:登录者自动允许(微信扫码人)。 */
  allowlistOptional?: boolean;
}

const CHANNELS: Channel[] = [
  {
    enabled: "feishuEnabled",
    titleKey: "settings.channels.feishu.title",
    hintKey: "settings.channels.feishu.hint",
    observe: "feishuObserve",
    fields: [
      { name: "feishuAppId", label: "App ID", placeholder: "cli_..." },
      { name: "feishuAppSecret", label: "App Secret", secret: true },
      { name: "feishuAllowUsers", labelKey: "settings.channels.feishu.allowUsers.label", hintKey: "settings.channels.feishu.allowUsers.hint", allowlist: true },
      { name: "feishuAllowChats", labelKey: "settings.channels.feishu.allowChats.label", hintKey: "settings.channels.feishu.allowChats.hint", allowlist: true },
    ],
  },
  {
    enabled: "qqEnabled",
    titleKey: "settings.channels.qq.title",
    hintKey: "settings.channels.qq.hint",
    observe: "qqObserve",
    fields: [
      { name: "qqEndpoint", labelKey: "settings.channels.qq.endpoint.label", placeholder: "ws://127.0.0.1:3001" },
      { name: "qqToken", label: "Access Token", hintKey: "settings.channels.qq.token.hint", secret: true },
      { name: "qqAllowUsers", labelKey: "settings.channels.qq.allowUsers.label", hintKey: "settings.channels.qq.allowUsers.hint", allowlist: true },
      { name: "qqAllowGroups", labelKey: "settings.channels.qq.allowGroups.label", hintKey: "settings.channels.qq.allowGroups.hint", allowlist: true },
    ],
  },
  {
    enabled: "dingtalkEnabled",
    titleKey: "settings.channels.dingtalk.title",
    hintKey: "settings.channels.dingtalk.hint",
    fields: [
      { name: "dingtalkClientId", label: "AppKey(ClientId)" },
      { name: "dingtalkClientSecret", label: "AppSecret(ClientSecret)", secret: true },
      { name: "dingtalkAllowUsers", labelKey: "settings.channels.dingtalk.allowUsers.label", hintKey: "settings.channels.dingtalk.allowUsers.hint", allowlist: true },
      { name: "dingtalkAllowChats", labelKey: "settings.channels.dingtalk.allowChats.label", hintKey: "settings.channels.dingtalk.allowChats.hint", allowlist: true },
    ],
  },
  {
    enabled: "wecomEnabled",
    titleKey: "settings.channels.wecom.title",
    hintKey: "settings.channels.wecom.hint",
    fields: [
      { name: "wecomBotId", label: "Bot ID" },
      { name: "wecomSecret", label: "Secret", secret: true },
      { name: "wecomAllowUsers", labelKey: "settings.channels.wecom.allowUsers.label", hintKey: "settings.channels.wecom.allowUsers.hint", allowlist: true },
      { name: "wecomAllowChats", labelKey: "settings.channels.wecom.allowChats.label", hintKey: "settings.channels.wecom.allowChats.hint", allowlist: true },
    ],
  },
  {
    enabled: "weixinEnabled",
    titleKey: "settings.channels.weixin.title",
    hintKey: "settings.channels.weixin.hint",
    allowlistOptional: true,
    fields: [
      {
        name: "weixinAllowUsers",
        labelKey: "settings.channels.weixin.allowUsers.label",
        hintKey: "settings.channels.weixin.allowUsers.hint",
        allowlist: true,
      },
    ],
  },
];

function ChannelCard({ channel, children, ...field }: FieldContext & { channel: Channel; children?: ReactNode }) {
  const t = useT();
  const tk = t as unknown as (key: MessageKey) => string;
  const enabled = field.form[channel.enabled];
  const allowlist = channel.fields.filter((f) => f.allowlist);
  const allowlistEmpty = !channel.allowlistOptional && allowlist.every((f) => parseAllowlist(field.form[f.name]).length === 0);
  return (
    <SettingsCard>
      <SwitchField {...field} name={channel.enabled} label={tk(channel.titleKey)} hint={tk(channel.hintKey)} />
      {enabled && channel.observe ? (
        <SwitchField
          {...field}
          name={channel.observe}
          label={t("settings.channels.observe.label")}
          hint={t("settings.channels.observe.hint")}
        />
      ) : null}
      {enabled ? children : null}
      {enabled
        ? channel.fields.map((f) => (
            <TextField
              key={f.name}
              {...field}
              name={f.name}
              label={f.labelKey ? tk(f.labelKey) : (f.label ?? "")}
              hint={f.hintKey ? tk(f.hintKey) : undefined}
              placeholder={f.placeholder}
              secret={f.secret}
              errorOverride={
                allowlistEmpty && f === allowlist[0] ? t("settings.validation.allowlistEmpty") : null
              }
            />
          ))
        : null}
    </SettingsCard>
  );
}
