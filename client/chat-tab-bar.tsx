import { useEffect, useRef, useState, type ReactNode } from "react";
import { Platform, Pressable, ScrollView, Text, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/ui";
import type { SuperagentSnapshot } from "../shared/model";
import { threadStatus, type StatusLabel } from "../shared/labels";
import { TYPE } from "../shared/design";
import { agentStatusColors, RunningStatusRing } from "./agent-status-icon";
import { HAIRLINE, WEB_TRANSITION, chatTokens, radius, space, type Theme } from "./theme-tokens";
import { toneColor } from "./ui";
import { useT } from "./i18n";

/**
 * 对话页顶部的标签栏:每个打开着的对话一个标签,末尾是「新对话」草稿标签(仅在草稿时出现)
 * 与 + 按钮。标签左侧是状态:Router 评估或 Worker 执行中显示运行环,有结果或出错显示色点。
 * 关闭标签只是收起,对话本身仍在侧栏「对话」里。
 */

type Thread = SuperagentSnapshot["threads"][number];

const TAB_HEIGHT = 28;
const STATUS_BOX = 14;
const DRAFT = "__draft__";

export interface ChatTabBarProps {
  /** 标签顺序里的线程 id;当前对话不在其中时(找不到的线程)也会显示。 */
  tabIds: string[];
  activeId: string | null;
  snapshot: SuperagentSnapshot | undefined;
  theme: Theme;
  compact: boolean;
  onSelect(threadId: string | null): void;
  onClose(threadId: string | null): void;
  trailing?: ReactNode;
}

/** 线程是否正在被处理:Router 评估中、有待评估触发,或有启动中/执行中的 Worker。 */
export function threadBusy(thread: Thread, snapshot: SuperagentSnapshot): boolean {
  if (snapshot.engine.currentEvalThreadId === thread.id || thread.pendingTriggers > 0) return true;
  return snapshot.tickets.some((ticket) => ticket.threadId === thread.id && (ticket.status === "launching" || ticket.status === "running"));
}

export function ChatTabBar({ tabIds, activeId, snapshot, theme, compact, onSelect, onClose, trailing }: ChatTabBarProps) {
  const t = useT();
  const ids = activeId && !tabIds.includes(activeId) ? [...tabIds, activeId] : tabIds;
  const draft = activeId === null;
  const threads = new Map((snapshot?.threads ?? []).map((thread) => [thread.id, thread]));
  // 草稿是唯一的标签时不给关闭按钮:关掉也还是草稿。
  const closable = ids.length + (draft ? 1 : 0) > 1;

  // 标签超出宽度时,让当前标签(新开的标签在末尾)滚进可视范围。
  const scroller = useRef<ScrollView>(null);
  const frames = useRef(new Map<string, { x: number; width: number }>());
  const view = useRef({ x: 0, width: 0 });
  const activeKey = activeId ?? DRAFT;
  const [layoutVersion, setLayoutVersion] = useState(0);
  useEffect(() => {
    const frame = frames.current.get(activeKey);
    const { x, width } = view.current;
    if (!frame || !width) return;
    if (frame.x < x) scroller.current?.scrollTo({ x: frame.x, animated: true });
    else if (frame.x + frame.width > x + width) scroller.current?.scrollTo({ x: frame.x + frame.width - width, animated: true });
  }, [activeKey, layoutVersion]);
  const measure = (id: string) => (event: { nativeEvent: { layout: { x: number; width: number } } }) => {
    const { x, width } = event.nativeEvent.layout;
    const before = frames.current.get(id);
    frames.current.set(id, { x, width });
    if (id === activeKey && (before?.x !== x || before?.width !== width)) setLayoutVersion((value) => value + 1);
  };
  return (
    <View style={{ height: 44, flexDirection: "row", alignItems: "center", gap: space.xs,
      paddingLeft: compact ? space.sm : space.md, paddingRight: compact ? space.sm : space.md,
      borderBottomWidth: HAIRLINE, borderBottomColor: theme.colors.border }}>
      <ScrollView ref={scroller} horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0, flexShrink: 1, minWidth: 0 }}
        contentContainerStyle={{ alignItems: "center", gap: space.xs }} scrollEventThrottle={32}
        onScroll={(event) => { view.current.x = event.nativeEvent.contentOffset.x; }}
        onLayout={(event) => { view.current.width = event.nativeEvent.layout.width; }}>
        {ids.map((id) => {
          const thread = threads.get(id);
          const status = thread && snapshot
            ? threadStatus(thread, snapshot.tickets.filter((ticket) => ticket.threadId === id), thread.lastDecision ? [thread.lastDecision] : [], t)
            : null;
          return (
            <Tab key={id} id={id} onLayout={measure(id)} label={thread?.title ?? t("chat.tabs.conversation")} active={id === activeId} closable={closable} compact={compact}
              muted={thread?.state === "closed"} status={status}
              indicator={<ThreadIndicator thread={thread} snapshot={snapshot} status={status} theme={theme} />}
              theme={theme} onSelect={() => onSelect(id)} onClose={() => onClose(id)} />
          );
        })}
        {draft ? (
          <Tab id={DRAFT} onLayout={measure(DRAFT)} label={t("chat.tabs.new")} active closable={closable} compact={compact} muted={false} status={null}
            indicator={<Icon name="SquarePen" size={STATUS_BOX} color={theme.colors.foreground} />}
            theme={theme} onSelect={() => onSelect(null)} onClose={() => onClose(null)} />
        ) : null}
      </ScrollView>
      {draft ? null : <NewTabButton theme={theme} onPress={() => onSelect(null)} />}
      <View style={{ flex: 1 }} />
      {trailing}
    </View>
  );
}

function Tab({ id, label, active, closable, compact, muted, status, indicator, theme, onSelect, onClose, onLayout }: {
  id: string;
  onLayout(event: { nativeEvent: { layout: { x: number; width: number } } }): void;
  label: string;
  active: boolean;
  closable: boolean;
  compact: boolean;
  muted: boolean;
  status: StatusLabel | null;
  indicator: ReactNode;
  theme: Theme;
  onSelect(): void;
  onClose(): void;
}) {
  const [hovered, setHovered] = useState(false);
  const [closeHovered, setCloseHovered] = useState(false);
  const tokens = chatTokens(theme);
  // 触屏没有悬停:只在当前标签上给关闭按钮;桌面悬停时也显示。
  const t = useT();
  const showClose = closable && (active || (hovered && Platform.OS === "web"));
  const color = active || hovered ? theme.colors.foreground : theme.colors.foregroundMuted;
  return (
    <View testID={`superagent-tab-${id}`} onLayout={onLayout} onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}
      style={{ flexDirection: "row", alignItems: "center", height: TAB_HEIGHT, maxWidth: compact ? 168 : 220, borderRadius: radius.block,
        backgroundColor: active ? tokens.pressed : hovered ? tokens.hover : "transparent", ...WEB_TRANSITION }}>
      <Pressable accessibilityRole="tab" accessibilityState={{ selected: active }}
        accessibilityLabel={status ? `${label},${status.label}` : label} onPress={onSelect}
        style={{ flexShrink: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: space.xs + 2, height: TAB_HEIGHT,
          paddingLeft: space.sm, paddingRight: closable ? space.xs : space.sm }}>
        <View style={{ width: STATUS_BOX, height: STATUS_BOX, alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{indicator}</View>
        <Text numberOfLines={1} style={{ flexShrink: 1, minWidth: 0, color, opacity: muted ? 0.7 : 1, fontSize: TYPE.label.size,
          lineHeight: TYPE.label.lineHeight, fontWeight: active ? "500" : "400" }}>{label}</Text>
      </Pressable>
      {closable ? (
        <Pressable accessibilityRole="button" accessibilityLabel={t("chat.tabs.closeTab", { label })} hitSlop={4} onPress={onClose}
          disabled={!showClose} accessibilityElementsHidden={!showClose}
          onHoverIn={() => setCloseHovered(true)} onHoverOut={() => setCloseHovered(false)}
          style={({ pressed }) => ({ width: 20, height: 20, marginRight: space.xs, flexShrink: 0, alignItems: "center", justifyContent: "center",
            borderRadius: radius.chip, opacity: showClose ? 1 : 0,
            backgroundColor: pressed || closeHovered ? tokens.card.controlHover : "transparent", ...WEB_TRANSITION })}>
          <Icon name="X" size={12} color={closeHovered ? theme.colors.foreground : theme.colors.foregroundMuted} />
        </Pressable>
      ) : null}
    </View>
  );
}

function NewTabButton({ theme, onPress }: { theme: Theme; onPress(): void }) {
  const t = useT();
  const [hovered, setHovered] = useState(false);
  const tokens = chatTokens(theme);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={t("chat.tabs.new")} hitSlop={4} onPress={onPress}
      onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)}
      style={({ pressed }) => ({ width: TAB_HEIGHT, height: TAB_HEIGHT, flexShrink: 0, alignItems: "center", justifyContent: "center",
        borderRadius: radius.block, backgroundColor: pressed ? tokens.pressed : hovered ? tokens.hover : "transparent", ...WEB_TRANSITION })}>
      <Icon name="Plus" size={16} color={hovered ? theme.colors.foreground : theme.colors.foregroundMuted} />
    </Pressable>
  );
}

function ThreadIndicator({ thread, snapshot, status, theme }: {
  thread: Thread | undefined;
  snapshot: SuperagentSnapshot | undefined;
  status: StatusLabel | null;
  theme: Theme;
}) {
  if (thread && snapshot && threadBusy(thread, snapshot)) {
    return <RunningStatusRing color={agentStatusColors(theme).running} size={STATUS_BOX} />;
  }
  if (status && (status.tone === "success" || status.tone === "danger" || status.tone === "warning")) {
    const color = status.tone === "success" ? agentStatusColors(theme).success : toneColor(status.tone, theme);
    return <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color }} />;
  }
  return <Icon name="MessageSquare" size={12} color={theme.colors.foregroundMuted} />;
}
