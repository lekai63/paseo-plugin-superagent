import { useMemo } from "react";
import { Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { Icon, Loading, ScrollView } from "@getpaseo/plugin/client/ui";
import { superagentStateRpc } from "../shared/rpc";
import { DispatchCard } from "./dispatch-card";
import { SetupCard } from "./setup-card";
import { ThreadCard } from "./thread-card";

const STATE_QUERY_KEY = ["superagent", "state"];
export { STATE_QUERY_KEY };

/** Superagent 主界面:配置 → 派发 → 线程/Ticket/裁决监控。 */
export function SuperagentScreen(props: PluginScreenProps) {
  const { theme, layout } = props;
  const fetchState = useRpc(superagentStateRpc);
  const gap = layout.compact ? 10 : 16;

  const stateQuery = useQuery({
    queryKey: STATE_QUERY_KEY,
    queryFn: () => fetchState({}),
    refetchInterval: 3000,
  });
  const snapshot = stateQuery.data;

  const stats = useMemo(() => {
    if (!snapshot) return null;
    const running = snapshot.tickets.filter((t) => ["launching", "running"].includes(t.status)).length;
    const pending = snapshot.threads.reduce((sum, t) => sum + t.pendingTriggers, 0);
    return { threads: snapshot.threads.length, running, pending };
  }, [snapshot]);

  // agent 深链由 navigation 提供(旧宿主可能缺失)。
  const navigation = "navigation" in props ? props.navigation : undefined;

  if (stateQuery.isLoading && !snapshot) {
    return <Loading />;
  }
  if (stateQuery.isError && !snapshot) {
    return (
      <View style={{ padding: gap }}>
        <Text style={{ color: theme.colors.statusDanger }}>
          状态加载失败:{stateQuery.error instanceof Error ? stateQuery.error.message : String(stateQuery.error)}
        </Text>
      </View>
    );
  }

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: gap, gap }}>
      <SetupCard {...props} required={!snapshot?.configured} issue={snapshot?.workingDirIssue ?? null} />

      {snapshot && stats && (
        <View style={{ flexDirection: "row", gap: 12, alignItems: "center" }}>
          <Stat icon="Layers" label={`线程 ${stats.threads}`} theme={theme} />
          <Stat icon="Bot" label={`运行 ${stats.running}`} theme={theme} />
          <Stat icon="Inbox" label={`待评估 ${stats.pending}`} theme={theme} />
          {snapshot.engine.evalInFlight && (
            <Stat icon="Brain" label="Router 评估中" theme={theme} />
          )}
          {snapshot.routerAgentId && (
            <Stat
              icon="Radio"
              label={snapshot.routerProvider ?? "router"}
              theme={theme}
              onPress={() => navigation?.openAgent({ agentId: snapshot.routerAgentId! })}
            />
          )}
        </View>
      )}

      <DispatchCard theme={theme} layout={layout} host={props.host} />

      {snapshot && snapshot.threads.length === 0 && (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>
          还没有线程。派发第一个任务,或在任意 agent 里使用 superagent_dispatch 工具委派工作。
        </Text>
      )}

      {snapshot?.threads.map((thread) => (
        <ThreadCard
          key={thread.id}
          thread={thread}
          tickets={snapshot.tickets}
          triggers={snapshot.triggers}
          decisions={snapshot.decisions}
          theme={theme}
          layout={layout}
          host={props.host}
          navigation={navigation}
        />
      ))}

      {snapshot?.engine.lastWatchdogNote && (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
          看门狗 {new Date(snapshot.engine.lastWatchdogAt ?? "").toLocaleTimeString()}:{snapshot.engine.lastWatchdogNote}
        </Text>
      )}
      {!snapshot?.engine.primed && (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
          引擎尚未 prime(首次派发或任意 agent 事件后自动启动)。
        </Text>
      )}
    </ScrollView>
  );
}

function Stat({
  icon,
  label,
  theme,
  onPress,
}: {
  icon: string;
  label: string;
  theme: PluginScreenProps["theme"];
  onPress?(): void;
}) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
      <Icon name={icon} size={14} color={theme.colors.foregroundMuted} />
      <Text
        style={{ color: onPress ? theme.colors.statusWarning : theme.colors.foregroundMuted, fontSize: 12 }}
        onPress={onPress}
      >
        {label}
      </Text>
    </View>
  );
}
