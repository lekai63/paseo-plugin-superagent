import { useMemo } from "react";
import { View } from "react-native";
import { useSettings, type PluginScreenProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsRow, SettingsSection } from "@getpaseo/plugin/client/ui";
import type { SuperagentSnapshot } from "../shared/model";
import { ACTIVE_TICKET_STATUSES, clockTime, watchdogNoteLabel } from "../shared/labels";
import { superagentSettings, type SuperagentSettingsValues } from "../shared/settings";
import { useSuperagentState } from "./query";
import { ScreenLayout, StateFeedback } from "./screen-layout";
import { Button, StatTile, space, type Theme } from "./ui";

export function StatusScreen(props: PluginScreenProps & { openMain(): void; openSettings(): void }) {
  const query = useSuperagentState(props.host.id);
  const settings = useSettings(superagentSettings);
  return (
    <ScreenLayout {...props}>
      <View style={{ gap: space.lg }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", gap: space.sm }}>
          <Button theme={props.theme} variant="ghost" icon="ArrowLeft" label="返回主界面" onPress={props.openMain} />
          <Button theme={props.theme} variant="outline" icon="Settings" label="设置" onPress={props.openSettings} />
        </View>
        <StateFeedback query={query} theme={props.theme} />
        {query.data ? <>
          <SettingsSection title="运行概览">
            <Overview snapshot={query.data} theme={props.theme} compact={props.layout.compact} />
          </SettingsSection>
          <SettingsSection title="组件运行状态">
            <SystemCard snapshot={query.data} settings={settings.status === "ready" ? settings.values : null} navigation={props.navigation} />
          </SettingsSection>
        </> : null}
      </View>
    </ScreenLayout>
  );
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
  navigation: PluginScreenProps["navigation"];
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
