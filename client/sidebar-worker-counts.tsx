import { Text, View } from "react-native";
import { scaleFontSize } from "../shared/host-font";
import { agentStatusColors, RunningStatusRing, statusMarkSize } from "./agent-status-icon";
import { useHostUiFontSize } from "./host-font-scale";
import { fontSize, space, type Theme } from "./ui";

/**
 * 与 better-paseo「任务」行的计数同一套几何,两行上下对齐:
 * 宿主的 trailing 槽已有 8 的右内边距,这里不再叠加;状态图形放在 14 的方框里,
 * 图形与数字间距 3,各组间距 8;数字字号随 Paseo 界面字号缩放(图形尺寸不变),与宿主行标签同一刻度。
 */
const STATUS_BOX = 14;
const DONE_DOT = 6 * (statusMarkSize(STATUS_BOX) / 12);

export function SidebarWorkerCounts({ counts, theme }: { counts: { running: number; done: number }; theme: Theme }) {
  const colors = agentStatusColors(theme);
  const countSize = scaleFontSize(fontSize.sm, useHostUiFontSize(theme));
  return <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
    {(["running", "done"] as const).filter((kind) => counts[kind] > 0).map((kind) => {
      const label = kind === "running" ? "运行中的 Worker" : "本轮完成、待命的 Worker";
      const color = kind === "running" ? colors.running : colors.success;
      return <View key={kind} accessibilityLabel={`${label}：${counts[kind]}`}
        testID={`superagent-workers-${kind}`} style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
        {kind === "running" ? <RunningStatusRing color={color} size={STATUS_BOX} />
          : <View style={{ width: STATUS_BOX, height: STATUS_BOX, alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <View style={{ width: DONE_DOT, height: DONE_DOT, borderRadius: DONE_DOT / 2, backgroundColor: color }} />
          </View>}
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: countSize, fontVariant: ["tabular-nums"] }}>{counts[kind]}</Text>
      </View>;
    })}
  </View>;
}
