import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Pressable,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollView as NativeScrollView,
} from "react-native";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { Icon, Markdown, ScrollView } from "@getpaseo/plugin/client/ui";
import type { Ticket } from "../shared/model";
import { userStatusLabel, type ChatEntry } from "../shared/chat";
import { elapsedTime } from "../shared/execution";
import { markdownPreview, relativeTime, ticketStatusLabel, ticketStatusTone, type Tone } from "../shared/labels";
import { agentStatusColors, RunningStatusRing } from "./agent-status-icon";
import { StatusBadge, radius, space, toneColor, type Theme } from "./ui";

/**
 * 对话消息流:版式对齐 Paseo 的 agent 会话——居中 820 宽的内容列、右侧用户气泡、
 * 无气泡的 Markdown 答复、可展开的紧凑动作行,以及底部的运行指示。
 */

export const CHAT_MAX_WIDTH = 820;
export const CHAT_FONT = { size: 15, lineHeight: 21, meta: 13 } as const;

type Navigation = PluginScreenProps["navigation"];
type UserEntry = Extract<ChatEntry, { kind: "user" }>;
type EventEntry = Extract<ChatEntry, { kind: "event" }>;

export interface WorkingState {
  label: string;
  /** 计时起点;为空时不显示用时。 */
  since: string | null;
}

/** 与 Paseo 的消息间距一致:同类连续消息贴近,换说话方时拉开。 */
function gapBefore(previous: ChatEntry | undefined, entry: ChatEntry): number {
  if (!previous) return 0;
  if (previous.kind === entry.kind) return entry.kind === "user" ? space.xs : 0;
  if (entry.kind === "user") return space.lg;
  if (previous.kind === "user") return space.sm;
  return space.xs;
}

export function ChatMessages({
  entries,
  tickets,
  pendingText,
  working,
  truncated,
  theme,
  navigation,
  compact,
  empty,
}: {
  entries: ChatEntry[];
  tickets: Ticket[];
  /** 已提交、尚未出现在快照里的消息。 */
  pendingText: string | null;
  working: WorkingState | null;
  truncated: boolean;
  theme: Theme;
  navigation: Navigation;
  compact: boolean;
  /** 没有任何消息时代替消息列显示。 */
  empty?: ReactNode;
}) {
  const scrollRef = useRef<NativeScrollView>(null);
  // 停在底部附近时跟随新消息;用户往上翻阅时不打断。只有向上滚动才停止跟随:
  // 内容(如 Markdown)增高时也会触发滚动事件,那时离底部变远但并不是用户在翻阅。
  const following = useRef(true);
  const lastOffset = useRef(0);
  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    if (contentSize.height - contentOffset.y - layoutMeasurement.height < 120) following.current = true;
    else if (contentOffset.y < lastOffset.current - 4) following.current = false;
    lastOffset.current = contentOffset.y;
  };
  useEffect(() => {
    if (!pendingText) return;
    following.current = true;
    scrollRef.current?.scrollToEnd({ animated: true });
  }, [pendingText]);

  const ticketById = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  const hasContent = entries.length > 0 || Boolean(pendingText);
  return (
    <ScrollView
      ref={scrollRef}
      style={{ flex: 1 }}
      contentContainerStyle={{ flexGrow: 1, paddingHorizontal: compact ? space.md : space.lg, paddingVertical: space.lg }}
      onScroll={onScroll}
      scrollEventThrottle={64}
      onContentSizeChange={() => {
        if (following.current) scrollRef.current?.scrollToEnd({ animated: false });
      }}
      // 输入框增高、窗口变矮时视口变小:跟随状态下保持贴底。
      onLayout={() => {
        if (following.current) scrollRef.current?.scrollToEnd({ animated: false });
      }}
      keyboardShouldPersistTaps="handled"
    >
      <View style={{ flexGrow: 1, width: "100%", maxWidth: CHAT_MAX_WIDTH, alignSelf: "center", paddingHorizontal: space.sm }}>
        {!hasContent && empty ? empty : null}
        {truncated ? (
          <Text style={{ alignSelf: "center", marginBottom: space.lg, color: theme.colors.foregroundMuted, fontSize: CHAT_FONT.meta }}>
            只显示最近的记录
          </Text>
        ) : null}
        {entries.map((entry, index) => (
          <View key={entry.id} style={{ marginTop: gapBefore(entries[index - 1], entry) }}>
            {entry.kind === "user" ? (
              <UserBubble entry={entry} theme={theme} />
            ) : entry.kind === "reply" ? (
              <ReplyMessage text={entry.text} at={entry.at} theme={theme} />
            ) : (
              <EventRow entry={entry} ticket={entry.ticketId ? ticketById.get(entry.ticketId) : undefined} theme={theme} navigation={navigation} />
            )}
          </View>
        ))}
        {pendingText ? (
          <View style={{ marginTop: entries.length ? space.lg : 0 }}>
            <UserBubble entry={{ kind: "user", id: "pending", at: "", text: pendingText, source: null, status: "pending", note: null }}
              theme={theme} sending />
          </View>
        ) : null}
        {working ? <WorkingIndicator working={working} theme={theme} /> : null}
      </View>
    </ScrollView>
  );
}

// ---------------------------------------------------------------- user

/** 很长的 IM 消息先折叠,避免一条消息占满屏幕。 */
const LONG_MESSAGE_LINES = 14;

function UserBubble({ entry, theme, sending = false }: { entry: UserEntry; theme: Theme; sending?: boolean }) {
  const [open, setOpen] = useState(false);
  const long = entry.text.length > 900 || entry.text.split("\n").length > LONG_MESSAGE_LINES;
  const status = sending ? { label: "发送中", tone: "muted" as Tone } : userStatusLabel(entry);
  const meta = [entry.source, sending ? null : relativeTime(entry.at)].filter(Boolean).join(" · ");
  return (
    <View style={{ alignItems: "flex-end" }}>
      <View
        style={{
          maxWidth: "85%",
          minWidth: 0,
          backgroundColor: theme.colors.surface2,
          borderRadius: 16,
          borderTopRightRadius: 2,
          paddingHorizontal: space.lg,
          paddingVertical: space.md + 2,
          opacity: sending ? 0.7 : 1,
        }}
      >
        <Text selectable numberOfLines={long && !open ? LONG_MESSAGE_LINES : undefined}
          style={{ color: theme.colors.foreground, fontSize: CHAT_FONT.size, lineHeight: CHAT_FONT.lineHeight }}>
          {entry.text}
        </Text>
        {long ? (
          <Text accessibilityRole="button" onPress={() => setOpen((value) => !value)}
            style={{ marginTop: space.xs, color: theme.colors.foregroundMuted, fontSize: CHAT_FONT.meta }}>
            {open ? "收起" : "展开全部"}
          </Text>
        ) : null}
      </View>
      {meta || status ? (
        <Text numberOfLines={1} style={{ marginTop: space.xs, color: theme.colors.foregroundMuted, fontSize: 12 }}>
          {meta}
          {status ? <Text style={{ color: toneColor(status.tone, theme) }}>{`${meta ? " · " : ""}${status.label}`}</Text> : null}
        </Text>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------- Router

function ReplyMessage({ text, at, theme }: { text: string; at: string; theme: Theme }) {
  return (
    <View style={{ paddingVertical: space.sm }}>
      <Markdown>{text}</Markdown>
      <Text style={{ marginTop: space.xs, color: theme.colors.foregroundMuted, fontSize: 12 }}>Router · {relativeTime(at)}</Text>
    </View>
  );
}

// ---------------------------------------------------------------- actions

/** 编排动作行:与 Paseo 的工具调用行同构——图标、标签、次要说明,点开看正文。 */
function EventRow({ entry, ticket, theme, navigation }: { entry: EventEntry; ticket?: Ticket; theme: Theme; navigation: Navigation }) {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const expandable = Boolean(entry.text);
  const tint = entry.tone === "default" ? theme.colors.foregroundMuted : toneColor(entry.tone, theme);
  const workerId = entry.live ? ticket?.workerAgentId : null;
  const preview = entry.markdown && entry.text && !open ? markdownPreview(entry.text).replace(/\s+/g, " ").trim() : "";
  let icon = entry.icon;
  if (expandable && hovered) icon = open ? "ChevronDown" : "ChevronRight";
  return (
    <View>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          marginHorizontal: -space.sm,
          paddingRight: space.xs,
          borderWidth: 1,
          borderColor: open ? theme.colors.border : "transparent",
          borderRadius: radius.lg,
          borderBottomLeftRadius: open ? 0 : radius.lg,
          borderBottomRightRadius: open ? 0 : radius.lg,
          backgroundColor: open || (hovered && expandable) ? theme.colors.surface1 : "transparent",
        }}
      >
        <Pressable
          disabled={!expandable}
          accessibilityRole={expandable ? "button" : undefined}
          accessibilityState={expandable ? { expanded: open } : undefined}
          accessibilityLabel={[entry.label, entry.detail].filter(Boolean).join(" · ")}
          onPress={() => setOpen((value) => !value)}
          onHoverIn={() => setHovered(true)}
          onHoverOut={() => setHovered(false)}
          style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", minHeight: 30, paddingLeft: space.sm - 1, paddingVertical: space.xs }}
        >
          <View style={{ width: 22, height: 22, marginRight: space.xs, alignItems: "center", justifyContent: "center" }}>
            <Icon name={icon} size={14} color={tint} />
          </View>
          <Text numberOfLines={1} style={{ flexShrink: 0, maxWidth: "60%", color: tint, fontSize: 14 }}>{entry.label}</Text>
          <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, marginLeft: space.sm, color: theme.colors.foregroundMuted, fontSize: 14 }}>
            {entry.detail ?? ""}
          </Text>
          {entry.live && ticket ? (
            <View style={{ marginLeft: space.sm }}>
              <StatusBadge theme={theme} label={ticketStatusLabel(ticket.status)} tone={ticketStatusTone(ticket.status)} />
            </View>
          ) : null}
          <Text style={{ marginLeft: space.sm, color: theme.colors.foregroundMuted, fontSize: 12 }}>{relativeTime(entry.at)}</Text>
        </Pressable>
        {/* 打开会话的位置每行都预留,让各行的时间右对齐。 */}
        <View style={{ width: 26, height: 26, marginLeft: space.xs }}>
          {workerId && navigation ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`打开 Worker 会话:${ticket?.title ?? ""}`}
              hitSlop={4}
              onPress={() => navigation.openAgent({ agentId: workerId })}
              style={({ pressed }) => ({
                flex: 1,
                borderRadius: radius.md,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: pressed ? theme.colors.surface2 : "transparent",
              })}
            >
              <Icon name="ArrowUpRight" size={14} color={theme.colors.foregroundMuted} />
            </Pressable>
          ) : null}
        </View>
      </View>
      {open && entry.text ? (
        <View
          style={{
            marginHorizontal: -space.sm,
            padding: space.md,
            borderWidth: 1,
            borderTopWidth: 0,
            borderColor: theme.colors.border,
            borderBottomLeftRadius: radius.lg,
            borderBottomRightRadius: radius.lg,
          }}
        >
          {entry.markdown ? (
            <Markdown>{entry.text}</Markdown>
          ) : (
            <Text selectable style={{ color: theme.colors.foreground, fontSize: 14, lineHeight: 20 }}>{entry.text}</Text>
          )}
        </View>
      ) : null}
      {preview ? (
        <Text numberOfLines={2} style={{ marginLeft: 22 + space.xs, marginBottom: space.xs, color: theme.colors.foregroundMuted, fontSize: CHAT_FONT.meta, lineHeight: 19 }}>
          {preview}
        </Text>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------- working

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** 对应 Paseo 会话底部的运行指示:旋转环 + 当前在做什么 + 用时。 */
function WorkingIndicator({ working, theme }: { working: WorkingState; theme: Theme }) {
  const now = useNow(1000);
  return (
    <View accessibilityRole="progressbar" accessibilityLabel={working.label}
      style={{ flexDirection: "row", alignItems: "center", gap: space.sm + 2, minHeight: 24, marginTop: space.md }}>
      <RunningStatusRing color={agentStatusColors(theme).running} />
      <Text numberOfLines={1} style={{ flexShrink: 1, color: theme.colors.foregroundMuted, fontSize: CHAT_FONT.meta }}>{working.label}</Text>
      {working.since ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: CHAT_FONT.meta, fontVariant: ["tabular-nums"] }}>
          {elapsedTime(working.since, now)}
        </Text>
      ) : null}
    </View>
  );
}
