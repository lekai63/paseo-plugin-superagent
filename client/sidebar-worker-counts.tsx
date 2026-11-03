import { Text, View } from "react-native";
import { agentStatusColors, RunningStatusRing } from "./agent-status-icon";
import { fontSize, space, type Theme } from "./ui";

export function SidebarWorkerCounts({ counts, theme }: { counts: { running: number; done: number }; theme: Theme }) {
  const colors = agentStatusColors(theme);
  return <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingRight: space.sm }}>
    {(["running", "done"] as const).filter((kind) => counts[kind] > 0).map((kind) => {
      const label = kind === "running" ? "运行中的 Worker" : "本轮完成、待命的 Worker";
      const color = kind === "running" ? colors.running : colors.success;
      return <View key={kind} accessibilityLabel={`${label}：${counts[kind]}`}
        testID={`superagent-workers-${kind}`} style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
        <View style={{ width: kind === "running" ? 16 : 6, height: 16, alignItems: "center", justifyContent: "center" }}>
          {kind === "running" ? <RunningStatusRing color={color} />
            : <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color }} />}
        </View>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.sm, fontVariant: ["tabular-nums"] }}>{counts[kind]}</Text>
      </View>;
    })}
  </View>;
}
