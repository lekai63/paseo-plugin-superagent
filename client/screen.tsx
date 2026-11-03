import { useMemo } from "react";
import { Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useRpc, useSettings, type PluginScreenProps } from "@getpaseo/plugin/client";
import {
  Loading,
  ScrollView,
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSection,
} from "@getpaseo/plugin/client/ui";
import type { SuperagentSnapshot } from "../shared/model";
import { ACTIVE_TICKET_STATUSES, clockTime, watchdogNoteLabel } from "../shared/labels";
import { superagentStateRpc } from "../shared/rpc";
import { superagentSettings, type SuperagentSettingsValues } from "../shared/settings";
import { DispatchCard } from "./dispatch-card";
import { STATE_QUERY_KEY } from "./query";
import { ThreadCard } from "./thread-card";
import { Button, Card, MAX_CONTENT_WIDTH, Notice, StatTile, fontSize, space, type Theme } from "./ui";

export { STATE_QUERY_KEY };

export interface SuperagentScreenProps extends PluginScreenProps {
  /** 打开本插件的设置页(Settings → Plugins → Superagent)。 */
  openSettings(): void;
}

/**
 * Superagent 主界面,自上而下:
 *   提示(未配置 / 工作目录不可用) → 概览数字 → 新任务 → 线程 → 运行状态。
 * 先放"要操作的",再放"要理解的";配置项都在设置页。
 */
export function SuperagentScreen(props: SuperagentScreenProps) {
  const { theme, layout, navigation, openSettings } = props;
  const fetchState = useRpc(superagentStateRpc);
  const settings = useSettings(superagentSettings);
  const settingsValues = settings.status === "ready" ? settings.values : null;
  const padding = layout.compact ? space.lg : space.xl;

  const stateQuery = useQuery({
    queryKey: STATE_QUERY_KEY,
    queryFn: () => fetchState({}),
    refetchInterval: 3000,
  });
  const snapshot = stateQuery.data;

  if (stateQuery.isLoading && !snapshot) return <Loading />;

  if (!snapshot) {
    const message = stateQuery.error instanceof Error ? stateQuery.error.message : String(stateQuery.error ?? "");
    return (
      <View style={{ flex: 1, backgroundColor: theme.colors.surface0, padding }}>
        <View style={{ width: "100%", maxWidth: MAX_CONTENT_WIDTH, alignSelf: "center" }}>
          <Notice theme={theme} tone="danger" title="无法读取 Superagent 状态" description={message || null}>
            <Button theme={theme} variant="outline" size="xs" label="重试" onPress={() => void stateQuery.refetch()} />
          </Notice>
        </View>
      </View>
    );
  }

  let disabledReason: string | null = null;
  if (!snapshot.configured) disabledReason = "先在设置里填写工作目录";
  else if (snapshot.workingDirIssue) disabledReason = "工作目录不可用,Worker 暂时无法启动";

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{ padding, paddingBottom: padding + space.lg }}
      keyboardShouldPersistTaps="handled"
    >
      <View style={{ width: "100%", maxWidth: MAX_CONTENT_WIDTH, alignSelf: "center" }}>
        <Notices
          snapshot={snapshot}
          theme={theme}
          openSettings={openSettings}
          staleError={stateQuery.isError ? stateQuery.error : null}
        />

        <SettingsSection
          title="概览"
          trailing={<Button theme={theme} variant="ghost" size="xs" icon="Settings" label="设置" onPress={openSettings} />}
        >
          <Overview snapshot={snapshot} theme={theme} compact={layout.compact} />
        </SettingsSection>

        <SettingsSection
          title="新任务"
          info="Router 先评估任务:直接答复、派发 Worker 执行,或忽略。Worker 在工作目录(或独立 worktree)里干活,完成后把汇报送回线程。"
        >
          <DispatchCard theme={theme} disabledReason={disabledReason} />
        </SettingsSection>

        <SettingsSection
          title={snapshot.threads.length > 0 ? `线程 · ${snapshot.threads.length}` : "线程"}
          info="每个线程是同一话题的事件流。线程里有订阅中的 Worker 时,追加的消息直接发给它(不经过 Router);否则交给 Router 评估。"
        >
          {snapshot.threads.length === 0 ? (
            <EmptyThreads theme={theme} />
          ) : (
            snapshot.threads.map((thread) => (
              <ThreadCard
                key={thread.id}
                thread={thread}
                tickets={snapshot.tickets}
                triggers={snapshot.triggers}
                decisions={snapshot.decisions}
                theme={theme}
                navigation={navigation}
                defaultExpanded={snapshot.threads.length === 1}
              />
            ))
          )}
        </SettingsSection>

        <SettingsSection title="运行状态">
          <SystemCard snapshot={snapshot} settings={settingsValues} navigation={navigation} />
        </SettingsSection>
      </View>
    </ScrollView>
  );
}

function Notices({
  snapshot,
  theme,
  openSettings,
  staleError,
}: {
  snapshot: SuperagentSnapshot;
  theme: Theme;
  openSettings(): void;
  staleError: unknown;
}) {
  const notices = [];
  if (!snapshot.configured) {
    notices.push(
      <Notice
        key="setup"
        theme={theme}
        tone="warning"
        title="还差一步:设置工作目录"
        description="Router 和所有 Worker 都在这个目录(或其 worktree)里工作。provider 可以留空,会自动选用宿主上可用的默认。"
      >
        <Button theme={theme} variant="outline" size="xs" icon="Settings" label="打开设置" onPress={openSettings} />
      </Notice>,
    );
  } else if (snapshot.workingDirIssue) {
    notices.push(
      <Notice key="workdir" theme={theme} tone="danger" title="Worker 无法启动" description={snapshot.workingDirIssue}>
        <Button theme={theme} variant="outline" size="xs" icon="Settings" label="打开设置" onPress={openSettings} />
      </Notice>,
    );
  }
  if (staleError) {
    notices.push(
      <Notice
        key="stale"
        theme={theme}
        tone="warning"
        title="状态刷新失败,当前显示的是上一次的数据"
        description={staleError instanceof Error ? staleError.message : String(staleError)}
      />,
    );
  }
  if (notices.length === 0) return null;
  return <View style={{ gap: space.md, marginBottom: space.xl }}>{notices}</View>;
}

function Overview({ snapshot, theme, compact }: { snapshot: SuperagentSnapshot; theme: Theme; compact: boolean }) {
  const stats = useMemo(() => {
    const running = snapshot.tickets.filter((t) => ACTIVE_TICKET_STATUSES.includes(t.status)).length;
    const failed = snapshot.tickets.filter((t) => t.status === "failed").length;
    const pending = snapshot.threads.reduce((sum, t) => sum + t.pendingTriggers, 0);
    return { threads: snapshot.threads.length, running, failed, pending };
  }, [snapshot]);

  return (
    <View style={{ flexDirection: "row", gap: compact ? space.sm : space.md }}>
      <StatTile theme={theme} label="线程" value={stats.threads} />
      <StatTile theme={theme} label="运行中" value={stats.running} tone={stats.running > 0 ? "warning" : "default"} />
      {/* Router 评估中:数字转为进行中色;宽屏再补一句文字(窄屏放不下)。 */}
      <StatTile
        theme={theme}
        label="待评估"
        value={stats.pending}
        tone={snapshot.engine.evalInFlight ? "warning" : "default"}
        caption={snapshot.engine.evalInFlight && !compact ? "评估中" : null}
      />
      <StatTile theme={theme} label="失败" value={stats.failed} tone={stats.failed > 0 ? "danger" : "default"} />
    </View>
  );
}

function EmptyThreads({ theme }: { theme: Theme }) {
  return (
    <Card theme={theme} style={{ paddingVertical: space.xl, paddingHorizontal: space.lg, alignItems: "center", gap: space.xs }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.base }}>还没有线程</Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.sm, textAlign: "center" }}>
        在上方派发第一个任务,或在 agent 会话里用 /superagent 委派
      </Text>
    </Card>
  );
}

const CHANNEL_LABELS: [keyof SuperagentSettingsValues, string][] = [
  ["feishuEnabled", "飞书"],
  ["qqEnabled", "QQ"],
  ["dingtalkEnabled", "钉钉"],
  ["wecomEnabled", "企业微信"],
];

function SystemCard({
  snapshot,
  settings,
  navigation,
}: {
  snapshot: SuperagentSnapshot;
  settings: SuperagentSettingsValues | null;
  navigation: SuperagentScreenProps["navigation"];
}) {
  const { engine } = snapshot;
  let routerState = "未启动";
  if (engine.evalInFlight) routerState = "正在评估";
  else if (snapshot.routerAgentId) routerState = "待命";
  else if (engine.primed) routerState = "首次评估时创建";
  const routerHint = `${snapshot.routerProvider || "自动选择"} · ${routerState}`;

  const isolation = settings?.workerIsolation === "shared" ? "共享目录" : "独立 worktree";
  const sources = ["App"];
  if (settings?.agentToolEnabled) sources.push("Agent 委派");
  for (const [key, label] of CHANNEL_LABELS) {
    if (settings?.[key]) sources.push(label);
  }

  let watchdog = "引擎未启动,首次派发或任意 agent 事件后自动启动";
  if (engine.primed) {
    watchdog = engine.lastWatchdogAt
      ? `${clockTime(engine.lastWatchdogAt)} 巡检 · ${watchdogNoteLabel(engine.lastWatchdogNote)}`
      : "等待首次巡检(每 15 秒一次)";
  }

  const routerAgentId = snapshot.routerAgentId;
  return (
    <SettingsCard>
      {routerAgentId && navigation ? (
        <SettingsAction
          label="Router"
          hint={routerHint}
          actionLabel="打开会话"
          onPress={() => navigation.openAgent({ agentId: routerAgentId })}
        />
      ) : (
        <SettingsRow label="Router" hint={routerHint} />
      )}
      <SettingsRow
        label={snapshot.workerProfiles.length > 0 ? "默认 Worker" : "Worker"}
        hint={`${snapshot.workerProvider || "自动选择"} · ${isolation}`}
      />
      {snapshot.workerProfiles.length > 0 ? (
        <SettingsRow
          label="Worker 档位"
          hint={snapshot.workerProfiles.map((profile) => `${profile.name} → ${profile.provider}`).join(" · ")}
        />
      ) : null}
      <SettingsRow label="工作目录" hint={snapshot.workingDir || "未配置"} />
      <SettingsRow label="触发来源" hint={sources.join(" · ")} />
      <SettingsRow label="看门狗" hint={watchdog} />
    </SettingsCard>
  );
}
