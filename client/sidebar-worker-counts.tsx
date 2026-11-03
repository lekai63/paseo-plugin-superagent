import { Text, View } from "react-native";
import { agentStatusColors } from "./agent-status-icon";
import { fontSize, space, type Theme } from "./ui";

export function SidebarWorkerCounts({ counts, theme }: { counts: { running: number; done: number } | null; theme: Theme }) {
  const colors = agentStatusColors(theme);
  return <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingRight: space.sm }}>
    {(["running", "done"] as const).map((kind) => {
      const label = kind === "running" ? "运行中的 Worker" : "本轮完成、待命的 Worker";
      return <View key={kind} accessibilityLabel={`${label}：${counts ? counts[kind] : "状态不可用"}`}
        testID={`superagent-workers-${kind}`} style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: counts ? kind === "running" ? colors.running : colors.success : theme.colors.foregroundMuted }} />
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.sm, fontVariant: ["tabular-nums"] }}>{counts ? counts[kind] : "—"}</Text>
      </View>;
    })}
  </View>;
}
