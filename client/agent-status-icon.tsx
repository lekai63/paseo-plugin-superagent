import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Platform, View, type ViewStyle } from "react-native";
import { SIDEBAR_STATUS_LABELS, type SidebarStatus } from "../shared/sidebar-status";
import type { Theme } from "./ui";

export function agentStatusColors(theme: Theme) {
  const hex = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})/i.exec(theme.colors.surface0);
  const dark = hex ? (0.299 * parseInt(hex[1], 16) + 0.587 * parseInt(hex[2], 16) + 0.114 * parseInt(hex[3], 16)) < 127.5 : false;
  return dark ? { running: "#5caaf6", success: "#35c264", warning: "#db932e", danger: "#f7796d" }
    : { running: "#268ae0", success: "#299f51", warning: "#b37824", danger: "#f12e2f" };
}

/** 沿用 better-paseo 的 16px 状态图形、配色与 900ms 运行环。 */
export function AgentStatusIcon({ status, theme }: { status: SidebarStatus; theme: Theme }) {
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
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => { if (mounted) setReduced(value); });
    const listener = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduced);
    return () => { mounted = false; listener.remove(); };
  }, []);
  useEffect(() => {
    if (status !== "running" || reduced) return;
    if (Platform.OS === "web") {
      const node = arc.current as HTMLElement | null;
      if (!node?.animate) return;
      const animation = node.animate([{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }], { duration: 900, iterations: Infinity });
      animation.startTime = 0;
      return () => animation.cancel();
    }
    rotation.setValue(0);
    const loop = Animated.loop(Animated.timing(rotation, { toValue: 1, duration: 900, easing: (value) => Math.floor(value * 12) / 12, useNativeDriver: true, isInteraction: false }));
    loop.start();
    return () => loop.stop();
  }, [status, reduced, rotation]);
  const colors = agentStatusColors(theme);
  const circle: ViewStyle = { position: "absolute", width: 12, height: 12, borderRadius: 6, borderWidth: 1.5 };
  const head: ViewStyle = { ...circle, borderColor: "transparent", borderTopColor: colors.running, opacity: 0.9 };
  return <View accessibilityLabel={`Router ${SIDEBAR_STATUS_LABELS[status]}`} testID={`superagent-router-status-${status}`}
    style={{ width: 16, height: 16, alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
    {status === "running" ? <>
      <View style={{ ...circle, borderColor: colors.running, opacity: 0.3 }} />
      {Platform.OS === "web" ? <View ref={(node) => { arc.current = node; }} style={head} />
        : <Animated.View style={[head, { transform: [{ rotate: rotation.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] }) }] }]} />}
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.running }} />
    </> : status === "needs_input" ? <View style={{ ...circle, borderColor: colors.warning }} />
      : <View style={{ width: status === "failed" ? 8 : 6, height: status === "failed" ? 8 : 6, borderRadius: 4,
        backgroundColor: status === "failed" ? colors.danger : theme.colors.foregroundMuted }} />}
  </View>;
}
