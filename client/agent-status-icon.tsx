import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Platform, View, type ViewStyle } from "react-native";
import type { Theme } from "./ui";

export function agentStatusColors(theme: Theme) {
  const hex = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})/i.exec(theme.colors.surface0);
  const dark = hex ? (0.299 * parseInt(hex[1], 16) + 0.587 * parseInt(hex[2], 16) + 0.114 * parseInt(hex[3], 16)) < 127.5 : false;
  return dark ? { running: "#5caaf6", success: "#35c264" } : { running: "#268ae0", success: "#299f51" };
}

/** 状态图形在 size 方框内的直径:与 better-paseo `statusMarkSize` 一致(16 → 12,14 → 10.5)。 */
export function statusMarkSize(box: number): number {
  return box < 16 ? box * 0.75 : 12 + (box - 16) / 2;
}

/** 沿用 better-paseo 的 900ms Worker 运行环;无运行时卸载,减少动态效果设置下保持静止。 */
export function RunningStatusRing({ color, size = 16 }: { color: string; size?: number }) {
  const rotation = useRef(new Animated.Value(0)).current;
  const arc = useRef<unknown>(null);
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (Platform.OS === "web") {
      const query = window.matchMedia("(prefers-reduced-motion: reduce)");
      const update = () => setReduced(query.matches);
      update(); query.addEventListener("change", update);
      return () => query.removeEventListener("change", update);
    }
    let mounted = true;
    // 查询失败时保持默认动画;未处理的拒绝会被宿主上报为异常(better-paseo 同款处理)。
    AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => { if (mounted) setReduced(value); })
      .catch(() => {});
    const listener = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduced);
    return () => { mounted = false; listener.remove(); };
  }, []);
  useEffect(() => {
    if (reduced) return;
    if (Platform.OS === "web") {
      const node = arc.current as HTMLElement | null;
      if (!node?.animate) return;
      const animation = node.animate([{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }], { duration: 900, iterations: Infinity });
      animation.startTime = 0;
      return () => animation.cancel();
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
