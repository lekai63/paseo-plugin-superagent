import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Platform, View, type ViewStyle } from "react-native";
import { STATUS_DOT, isDarkColor } from "../shared/design";
import type { Theme } from "./theme-tokens";
import { startWebPulse, startWebRotation, subscribeWebReducedMotion } from "./web";

/**
 * 状态点颜色取宿主 theme.ts 的 statusDot* 色带:点要比同排的文字徽标更亮才压得住行,
 * 宿主侧栏状态点即用此带(PluginTheme 未暴露,故按 surface0 亮度在两套宿主值中二选)。
 * 非活跃点宿主不用此带,而是 border 色,见 SidebarRouterMark。
 */
export function agentStatusColors(theme: Theme) {
  return isDarkColor(theme.colors.surface0) ? STATUS_DOT.dark : STATUS_DOT.light;
}

/** 状态图形在 size 方框内的直径:与 better-paseo `statusMarkSize` 一致(16 → 12,14 → 10.5)。 */
export function statusMarkSize(box: number): number {
  return box < 16 ? box * 0.75 : 12 + (box - 16) / 2;
}

/** 系统「减少动态效果」设置;Web 跟随 prefers-reduced-motion。 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (Platform.OS === "web") {
      return subscribeWebReducedMotion(setReduced);
    }
    let mounted = true;
    // 查询失败时保持默认动画;未处理的拒绝会被宿主上报为异常(better-paseo 同款处理)。
    AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => { if (mounted) setReduced(value); })
      .catch(() => {});
    const listener = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduced);
    return () => { mounted = false; listener.remove(); };
  }, []);
  return reduced;
}

/** 沿用 better-paseo 的 900ms Worker 运行环;无运行时卸载,减少动态效果设置下保持静止。 */
export function RunningStatusRing({ color, size = 16 }: { color: string; size?: number }) {
  const rotation = useRef(new Animated.Value(0)).current;
  const arc = useRef<unknown>(null);
  const reduced = useReducedMotion();
  useEffect(() => {
    if (reduced) return;
    if (Platform.OS === "web") {
      return startWebRotation(arc.current);
    }
    // 判别实验(iOS 闪退排查):原生端先停用 Animated 循环,画静止圆弧。
    // 若闪退消失,则问题锁定在 useNativeDriver 动画链路;确认后再换安全实现。
    rotation.setValue(0.25);
    return undefined;
  }, [reduced, rotation]);
  const mark = statusMarkSize(size);
  const scale = mark / 12;
  const dot = 6 * scale;
  const offset = (size - mark) / 2;
  const circle: ViewStyle = { position: "absolute", left: offset, top: offset, width: mark, height: mark, borderRadius: mark / 2, borderWidth: 1.5 * scale };
  const head: ViewStyle = { ...circle, borderColor: "transparent", borderTopColor: color, opacity: 0.9 };
  return <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
    <View style={{ ...circle, borderColor: color, opacity: 0.3 }} />
    {Platform.OS === "web" ? <View ref={(node) => { arc.current = node; }} style={head} />
      : <Animated.View style={[head, { transform: [{ rotate: rotation.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] }) }] }]} />}
    <View style={{ width: dot, height: dot, borderRadius: dot / 2, backgroundColor: color }} />
  </View>;
}

/**
 * better-paseo 的运行点:对话行里「正在进行」的唯一动态,6px 圆点在全不透明与 30% 之间呼吸。
 * 只改不透明度,版面不动;Web 用 CSS 动画,原生画静止的点(与运行环同样避开原生 Animated 循环),
 * 减少动态效果时也保持静止。卸载即停止。
 */
export function RunningDot({ color, size = 6, accessibilityLabel }: { color: string; size?: number; accessibilityLabel?: string }) {
  const node = useRef<unknown>(null);
  const reduced = useReducedMotion();
  useEffect(() => (reduced ? undefined : startWebPulse(node.current)), [reduced]);
  return <View ref={(value) => { node.current = value; }} accessibilityRole="progressbar" accessibilityLabel={accessibilityLabel ?? "进行中"}
    style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color, flexShrink: 0 }} />;
}
