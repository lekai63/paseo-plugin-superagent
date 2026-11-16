import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Platform,
  Pressable,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollView as NativeScrollView,
} from "react-native";
import type { PluginHostProps, PluginScreenProps } from "@getpaseo/plugin/client";
import { Icon, Markdown, ScrollView } from "@getpaseo/plugin/client/ui";
import type { Ticket } from "../shared/model";
import { userStatusLabel, type ChatEntry } from "../shared/chat";
import { TYPE, bubbleStep, proseScale, type ProseScale, type TypeStep } from "../shared/design";
import { elapsedTime } from "../shared/execution";
import { fullStamp, markdownPreview, stampTime, ticketStatusLabel, type Tone } from "../shared/labels";
import { extractFileLinks, type FileLink } from "../shared/file-links";
import { RunningDot } from "./agent-status-icon";
import { FileLinkList, FilePreviewModal, useFileKinds, type FileTarget } from "./file-preview";
import type { FileKind } from "../shared/file-preview";
import { useHostAppearance } from "./host-font-scale";
import { ROW, TOUCH, WEB_TRANSITION, chatTokens, radius, space, type Theme } from "./theme-tokens";
import { CopyButton, TextButton, toneColor } from "./ui";
import { useT } from "./i18n";

/**
 * 对话消息流,版式取自 better-paseo 重绘的 agent 会话:
 * - 内容列宽度跟随 Paseo 的「内容宽度」设置(默认 820),正文字号跟随「正文字号」;
 * - 用户消息是右侧气泡(圆角 16、右上 2 的尾角、正文字号 × 1.4 行高),下方一行放用户来源、
 *   状态、时间与复制;
 * - Router 答复是不带气泡的宿主 Markdown,下方是页脚:复制 · Router · 时间;答复里链接到的
 *   文件列在正文与页脚之间,点开在弹层里预览(宿主 Markdown 在插件页面里点文件链接没有反应);
 * - 编排动作是 26/28 高的紧凑行:已结束的行退后一步(次要色),运行中的行用 statusDot 蓝色运行点(与标签栏的运行环同色),
 *   悬停/展开时恢复全对比;展开的正文是一块无边框的浅底。连续的行只隔 4。
 */

type Navigation = PluginScreenProps["navigation"];
type UserEntry = Extract<ChatEntry, { kind: "user" }>;
type EventEntry = Extract<ChatEntry, { kind: "event" }>;

/** 对话页各处共用的尺寸,随宿主外观与布局变化。 */
export interface ChatMetrics {
  /** 内容列最大宽度。 */
  maxWidth: number;
  /** 用户气泡与输入框的字号/行高。 */
  bubble: TypeStep;
  /** 阅读文字刻度(展开的正文、预览)。 */
  prose: ProseScale;
  /** 动作行高度:桌面 26、触屏 28。 */
  rowHeight: number;
  touch: boolean;
  compact: boolean;
}

export function useChatMetrics(theme: Theme, layout: PluginHostProps["layout"]): ChatMetrics {
  const appearance = useHostAppearance(theme);
  const touch = TOUCH || layout.compact;
  return useMemo(() => ({
    maxWidth: appearance.contentMaxWidth,
    bubble: bubbleStep(appearance.contentFontSize),
    prose: proseScale(appearance.contentFontSize),
    rowHeight: touch ? ROW.height.touch : ROW.height.desktop,
    touch,
    compact: layout.compact,
  }), [appearance, touch, layout.compact]);
}

export interface WorkingState {
  label: string;
  /** 计时起点;为空时不显示用时。 */
  since: string | null;
}

/**
 * 条目之间的间距:换一轮(用户发言)拉开 24,用户之后 16;连续的动作行只隔 4,
 * 像 better-paseo 里一串工具调用读成一段安静的日志;答复与动作行之间 12。
 */
function gapBefore(previous: ChatEntry | undefined, entry: ChatEntry): number {
  if (!previous) return 0;
  if (entry.kind === "user") return previous.kind === "user" ? space.sm : space.xl;
  if (previous.kind === "user") return space.lg;
  if (previous.kind === "event" && entry.kind === "event") return ROW.stackGap;
  if (previous.kind === "reply" && entry.kind === "reply") return space.lg;
  return space.md;
}

export function ChatMessages({
  hostId,
  entries,
  tickets,
  pendingText,
  working,
  truncated,
  theme,
  navigation,
  metrics,
  empty,
}: {
  /** 文件预览按宿主隔离缓存。 */
  hostId: string;
  entries: ChatEntry[];
  tickets: Ticket[];
  /** 已提交、尚未出现在快照里的消息。 */
  pendingText: string | null;
  working: WorkingState | null;
  truncated: boolean;
  theme: Theme;
  navigation: Navigation;
  metrics: ChatMetrics;
  /** 没有任何消息时代替消息列显示。 */
  empty?: ReactNode;
}) {
  const t = useT();
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

  const [preview, setPreview] = useState<FileTarget | null>(null);
  // 答复与汇报正文里的文件链接:按条目提取一次,类型一次查完。
  const fileLinks = useMemo(() => {
    const byEntry = new Map<string, FileLink[]>();
    for (const entry of entries) {
      if (entry.kind !== "reply" && !(entry.kind === "event" && entry.markdown && entry.text)) continue;
      const links = extractFileLinks(entry.text ?? "");
      if (links.length) byEntry.set(entry.id, links);
    }
    return byEntry;
  }, [entries]);
  const fileKinds = useFileKinds(hostId, fileLinks.values());
  const files = (id: string): FileRefs => ({ links: fileLinks.get(id) ?? NO_LINKS, kinds: fileKinds, onOpen: setPreview });
  const ticketById = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  const hasContent = entries.length > 0 || Boolean(pendingText);
  const last = entries[entries.length - 1];
  return (
    <>
      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={{ flexGrow: 1, paddingHorizontal: metrics.compact ? space.md : space.lg, paddingTop: space.lg, paddingBottom: space.lg }}
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
        <View style={{ flexGrow: 1, width: "100%", maxWidth: metrics.maxWidth, alignSelf: "center", paddingHorizontal: space.sm }}>
          {!hasContent && empty ? empty : null}
          {truncated ? (
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.xs + 2, marginBottom: space.lg }}>
              <Icon name="History" size={12} color={theme.colors.foregroundMuted} />
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: TYPE.caption.size, lineHeight: TYPE.caption.lineHeight }}>
                {t("chat.messages.truncated")}
              </Text>
            </View>
          ) : null}
          {entries.map((entry, index) => (
            <View key={entry.id} style={{ marginTop: gapBefore(entries[index - 1], entry) }}>
              {entry.kind === "user" ? (
                <UserBubble entry={entry} theme={theme} metrics={metrics} />
              ) : entry.kind === "reply" ? (
                <ReplyMessage text={entry.text} at={entry.at} theme={theme} metrics={metrics} files={files(entry.id)} />
              ) : (
                <EventRow entry={entry} ticket={entry.ticketId ? ticketById.get(entry.ticketId) : undefined} theme={theme}
                  navigation={navigation} metrics={metrics} files={files(entry.id)} />
              )}
            </View>
          ))}
          {pendingText ? (
            <View style={{ marginTop: entries.length ? (last?.kind === "user" ? space.sm : space.xl) : 0 }}>
              <UserBubble entry={{ kind: "user", id: "pending", at: "", text: pendingText, source: null, status: "pending", note: null }}
                theme={theme} metrics={metrics} sending />
            </View>
          ) : null}
          {working ? (
            <View style={{ marginTop: !hasContent ? 0 : pendingText || last?.kind === "user" ? space.lg : last?.kind === "event" ? ROW.stackGap : space.md }}>
              <WorkingRow working={working} theme={theme} metrics={metrics} />
            </View>
          ) : null}
        </View>
      </ScrollView>
      <FilePreviewModal target={preview} hostId={hostId} theme={theme} wide={Platform.OS === "web" && !metrics.compact}
        onClose={() => setPreview(null)} />
    </>
  );
}

// ---------------------------------------------------------------- user

/** 很长的 IM 消息先折叠,避免一条消息占满屏幕。 */
const LONG_MESSAGE_LINES = 14;
const BUBBLE_MAX_WIDTH = 560;

function UserBubble({ entry, theme, metrics, sending = false }: { entry: UserEntry; theme: Theme; metrics: ChatMetrics; sending?: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const long = entry.text.length > 900 || entry.text.split("\n").length > LONG_MESSAGE_LINES;
  const status = sending ? { label: t("chat.messages.sending"), tone: "muted" as Tone } : userStatusLabel(entry, t);
  const caption = { fontSize: TYPE.caption.size, lineHeight: TYPE.caption.lineHeight };
  return (
    <View style={{ alignSelf: "flex-end", alignItems: "flex-end", maxWidth: metrics.compact ? "86%" : BUBBLE_MAX_WIDTH }}>
      <View
        style={{
          minWidth: 0,
          backgroundColor: theme.colors.surface2,
          borderRadius: radius.bubble,
          borderTopRightRadius: radius.bubbleTail,
          padding: space.lg,
          opacity: sending ? 0.7 : 1,
        }}
      >
        <Text selectable numberOfLines={long && !open ? LONG_MESSAGE_LINES : undefined}
          style={{ color: theme.colors.foreground, fontSize: metrics.bubble.size, lineHeight: metrics.bubble.lineHeight }}>
          {entry.text}
        </Text>
        {long ? (
          <View style={{ marginTop: space.sm }}>
            <TextButton theme={theme} label={open ? t("chat.collapse") : t("chat.expandAll")} onPress={() => setOpen((value) => !value)} />
          </View>
        ) : null}
      </View>
      {/* 从右到左:复制、时间、状态、来源;放不下时换行,不挤压气泡。 */}
      <View style={{ flexDirection: "row-reverse", flexWrap: "wrap", alignItems: "center", minHeight: 24, marginTop: space.xs, columnGap: space.sm }}>
        {sending ? null : <CopyButton theme={theme} text={entry.text} label={t("chat.messages.copyMessage")} touch={metrics.touch} />}
        {entry.at ? (
          <Text accessibilityLabel={fullStamp(entry.at)}
            style={{ ...caption, color: theme.colors.foregroundMuted, fontVariant: ["tabular-nums"] }}>{stampTime(entry.at, t)}</Text>
        ) : null}
        {status ? <Text numberOfLines={1} style={{ ...caption, flexShrink: 1, color: toneColor(status.tone, theme) }}>{status.label}</Text> : null}
        {entry.source ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs, flexShrink: 1 }}>
            <Icon name="AtSign" size={12} color={theme.colors.foregroundMuted} />
            <Text numberOfLines={1} style={{ ...caption, flexShrink: 1, color: theme.colors.foregroundMuted }}>{entry.source}</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------- Router

/**
 * Router 的答复:无气泡的宿主 Markdown,链接到的文件列成一排可预览的药丸,下方一行页脚
 * (better-paseo 的 turn footer):复制 · Router · 时间。
 */
function ReplyMessage({ text, at, theme, metrics, files }: {
  text: string;
  at: string;
  theme: Theme;
  metrics: ChatMetrics;
  files: FileRefs;
}) {
  const t = useT();
  const muted = theme.colors.foregroundMuted;
  const footerText = { fontSize: TYPE.button.size, lineHeight: TYPE.button.lineHeight, color: muted };
  return (
    <View>
      <MarkdownWithFiles text={text} theme={theme} metrics={metrics} files={files} />
      <View style={{ flexDirection: "row", alignItems: "center", minHeight: 24, marginTop: space.sm, gap: space.sm }}>
        <View style={{ marginHorizontal: -space.xs }}>
          <CopyButton theme={theme} text={text} label={t("chat.messages.copyReply")} touch={metrics.touch} />
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
          <Icon name="Route" size={13} color={muted} />
          <Text style={footerText}>Router</Text>
        </View>
        <Text accessibilityLabel={fullStamp(at)} style={{ ...footerText, fontVariant: ["tabular-nums"] }}>{stampTime(at, t)}</Text>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------- rows

/** 行的响亮程度:quiet 已结束(退后一步)、active 进行中、loud 等待处理或出错(不调暗)。 */
type RowTone = "quiet" | "active" | "loud";

function rowColors(theme: Theme, tone: RowTone, lit: boolean) {
  const tokens = chatTokens(theme);
  if (lit || tone === "loud") {
    return { verb: theme.colors.foreground, target: theme.colors.foregroundMuted, meta: theme.colors.foregroundMuted, icon: theme.colors.foregroundMuted };
  }
  return {
    verb: tone === "active" ? tokens.row.targetActive : tokens.row.target,
    target: tone === "active" ? tokens.row.targetActive : tokens.row.target,
    meta: tone === "active" ? theme.colors.foregroundMuted : tokens.row.meta,
    icon: tokens.row.icon,
  };
}

interface ChatRowProps {
  theme: Theme;
  metrics: ChatMetrics;
  icon: string;
  /** 代替图标画在图标槽里(运行点)。 */
  slot?: ReactNode;
  /** 状态色:同时用于图标(出错时还有动词)。 */
  statusColor?: string | null;
  /** 出错:动词也用状态色。 */
  failed?: boolean;
  verb: string;
  target?: string | null;
  /** 行尾元信息;拿到当前(随悬停变化的)行配色。 */
  meta?: (colors: ReturnType<typeof rowColors>) => ReactNode;
  tone: RowTone;
  open?: boolean;
  onToggle?: () => void;
  /** 行尾按钮(打开会话);所有行都留出同样宽度,时间右对齐。 */
  trailing?: ReactNode;
  accessibilityLabel: string;
}

/** 预留给行尾按钮的宽度。 */
const TRAILING_SLOT = 24;

/** better-paseo 的 disclosure 行:外扩 8 再内缩 8,图标槽 16,文字列从 24 开始。 */
function ChatRow({ theme, metrics, icon, slot, statusColor, failed = false, verb, target, meta, tone, open = false, onToggle, trailing,
  accessibilityLabel }: ChatRowProps) {
  const tokens = chatTokens(theme);
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  const expandable = Boolean(onToggle);
  const lit = expandable && (hovered || pressed || open);
  const colors = rowColors(theme, tone, lit);
  const iconColor = statusColor ?? colors.icon;
  // 指针悬停时用箭头代替图标,提示可以展开;展开后保持向下箭头。状态槽(运行点)不让位。
  const glyph = !slot && expandable && !metrics.touch && (hovered || open) ? (open ? "ChevronDown" : "ChevronRight") : icon;
  const slop = metrics.touch ? Math.max(0, (ROW.hit - metrics.rowHeight) / 2) : 0;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        marginHorizontal: -ROW.bleed,
        paddingRight: ROW.paddingX - space.xs,
        borderRadius: radius.block,
        backgroundColor: expandable && pressed ? tokens.pressed : expandable && hovered ? tokens.hover : "transparent",
        ...WEB_TRANSITION,
      }}
    >
      <Pressable
        disabled={!expandable}
        accessibilityRole={expandable ? "button" : undefined}
        accessibilityState={expandable ? { expanded: open } : undefined}
        accessibilityLabel={accessibilityLabel}
        onPress={onToggle}
        onPressIn={() => setPressed(true)}
        onPressOut={() => setPressed(false)}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        hitSlop={slop > 0 ? { top: slop, bottom: slop } : undefined}
        style={{ flex: 1, minWidth: 0, height: metrics.rowHeight, flexDirection: "row", alignItems: "center", gap: ROW.gap, paddingLeft: ROW.paddingX }}
      >
        <View style={{ width: ROW.iconSlot, paddingRight: ROW.iconSlotPad, alignItems: "center", justifyContent: "center" }}>
          {slot ?? <Icon name={glyph} size={ROW.icon} color={glyph === icon ? iconColor : colors.verb} />}
        </View>
        <Text numberOfLines={1} style={{ flexShrink: 0, maxWidth: "55%", color: failed && statusColor ? statusColor : colors.verb,
          fontSize: TYPE.label.size, lineHeight: TYPE.label.lineHeight, fontWeight: "500" }}>{verb}</Text>
        <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, color: colors.target, fontSize: TYPE.label.size, lineHeight: TYPE.label.lineHeight }}>
          {target ?? ""}
        </Text>
        {meta?.(colors)}
      </Pressable>
      <View style={{ width: TRAILING_SLOT, height: TRAILING_SLOT, marginLeft: space.xs }}>{trailing}</View>
    </View>
  );
}

/** 行尾的小号元信息:12/16、等宽数字。 */
function RowMeta({ children, color, label }: { children: string; color: string; label?: string }) {
  return (
    <Text numberOfLines={1} accessibilityLabel={label}
      style={{ flexShrink: 0, color, fontSize: TYPE.meta.size, lineHeight: TYPE.meta.lineHeight, fontVariant: ["tabular-nums"] }}>
      {children}
    </Text>
  );
}

const ACTIVE_STATUSES: readonly Ticket["status"][] = ["launching", "running"];

/** 编排动作行:派发、汇报、转向等;点开看正文。派发行跟随 Ticket 的实时状态,可打开 Worker 会话。 */
function EventRow({ entry, ticket, theme, navigation, metrics, files }: {
  entry: EventEntry;
  ticket?: Ticket;
  theme: Theme;
  navigation: Navigation;
  metrics: ChatMetrics;
  files: FileRefs;
}) {
  const t = useT();
  const tokens = chatTokens(theme);
  const [open, setOpen] = useState(false);
  const [openHovered, setOpenHovered] = useState(false);
  const expandable = Boolean(entry.text);
  const live = entry.live && ticket ? ticket : null;
  const running = Boolean(live && ACTIVE_STATUSES.includes(live.status));
  const failed = entry.tone === "danger" || live?.status === "failed";
  const statusColor = failed ? theme.colors.statusDanger : entry.tone === "warning" ? theme.colors.statusWarning : null;
  const tone: RowTone = failed ? "loud" : running ? "active" : "quiet";
  const workerId = live?.workerAgentId ?? null;
  const preview = entry.markdown && entry.text && !open ? markdownPreview(entry.text).replace(/\s+/g, " ").trim() : "";
  const statusLabel = live ? `${live.status === "completed" ? "✓ " : ""}${ticketStatusLabel(live.status, t)}` : null;
  const statusTint = (colors: ReturnType<typeof rowColors>) => {
    if (live?.status === "failed") return theme.colors.statusDanger;
    return running ? tokens.row.targetActive : colors.meta;
  };

  return (
    <View>
      <ChatRow
        theme={theme}
        metrics={metrics}
        icon={entry.icon}
        slot={running ? <RunningDot color={tokens.status.running} accessibilityLabel={statusLabel ?? undefined} /> : undefined}
        statusColor={statusColor}
        failed={failed}
        verb={entry.label}
        target={entry.detail}
        tone={tone}
        open={open}
        onToggle={expandable ? () => setOpen((value) => !value) : undefined}
        accessibilityLabel={[entry.label, entry.detail, statusLabel, fullStamp(entry.at)].filter(Boolean).join(" · ")}
        meta={(colors) => (
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flexShrink: 0 }}>
            {statusLabel ? <RowMeta color={statusTint(colors)}>{statusLabel}</RowMeta> : null}
            <RowMeta color={colors.meta} label={fullStamp(entry.at)}>{stampTime(entry.at, t)}</RowMeta>
          </View>
        )}
        trailing={workerId && navigation ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("chat.messages.openWorkerSession", { title: ticket?.title ?? "" })}
            hitSlop={metrics.touch ? 10 : 4}
            onPress={() => navigation.openAgent({ agentId: workerId })}
            onHoverIn={() => setOpenHovered(true)}
            onHoverOut={() => setOpenHovered(false)}
            style={({ pressed }) => ({
              flex: 1,
              borderRadius: radius.chip,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: pressed ? tokens.pressed : openHovered ? tokens.hover : "transparent",
              ...WEB_TRANSITION,
            })}
          >
            <Icon name="ArrowUpRight" size={14} color={openHovered ? theme.colors.foreground : theme.colors.foregroundMuted} />
          </Pressable>
        ) : null}
      />
      {open && entry.text ? (
        <View style={{ marginTop: 2, marginBottom: space.xs + 2, paddingVertical: space.sm, paddingHorizontal: space.md, borderRadius: radius.block,
          backgroundColor: tokens.row.body }}>
          {entry.markdown ? (
            <MarkdownWithFiles text={entry.text} theme={theme} metrics={metrics} files={files} />
          ) : (
            <Text selectable style={{ color: tokens.row.bodyText, fontSize: metrics.prose.secondary.size, lineHeight: metrics.prose.secondary.lineHeight }}>
              {entry.text}
            </Text>
          )}
        </View>
      ) : null}
      {preview ? (
        <Pressable accessibilityRole="button" accessibilityLabel={t("chat.messages.expand", { label: entry.label })} onPress={() => setOpen(true)}
          style={{ marginLeft: ROW.textColumn, marginTop: 2, marginBottom: space.xs, marginRight: TRAILING_SLOT + space.xs }}>
          <Text numberOfLines={2} style={{ color: theme.colors.foregroundMuted, fontSize: TYPE.labelRead.size, lineHeight: TYPE.labelRead.lineHeight }}>
            {preview}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** 条目正文里链接到的文件、它们的类型与打开预览的回调。 */
interface FileRefs {
  links: readonly FileLink[];
  kinds: Readonly<Record<string, FileKind>> | undefined;
  onOpen(target: FileTarget): void;
}

const NO_LINKS: readonly FileLink[] = [];

/** 宿主 Markdown 正文,下方列出其中链接到的文件(Router 答复与展开的汇报共用)。 */
function MarkdownWithFiles({ text, theme, metrics, files }: {
  text: string;
  theme: Theme;
  metrics: ChatMetrics;
  files: FileRefs;
}) {
  return (
    <View>
      <Markdown>{text}</Markdown>
      {files.links.length ? (
        <View style={{ marginTop: space.md - 2 }}>
          <FileLinkList links={files.links} kinds={files.kinds} theme={theme} touch={metrics.touch} onOpen={files.onOpen} />
        </View>
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

/** 底部的运行指示,与动作行同一几何:蓝色运行点 + 正在做什么 + 用时。 */
function WorkingRow({ working, theme, metrics }: { working: WorkingState; theme: Theme; metrics: ChatMetrics }) {
  const t = useT();
  const now = useNow(1000);
  const tokens = chatTokens(theme);
  return (
    <View accessibilityLabel={working.label}
      style={{ flexDirection: "row", alignItems: "center", gap: ROW.gap, height: metrics.rowHeight }}>
      <View style={{ width: ROW.iconSlot, paddingRight: ROW.iconSlotPad, alignItems: "center", justifyContent: "center" }}>
        <RunningDot color={tokens.status.running} accessibilityLabel={working.label} />
      </View>
      <Text numberOfLines={1} style={{ flexShrink: 1, color: tokens.row.targetActive, fontSize: TYPE.label.size, lineHeight: TYPE.label.lineHeight,
        fontWeight: "500" }}>{working.label}</Text>
      {working.since ? (
        <Text numberOfLines={1} style={{ flexShrink: 0, color: theme.colors.foregroundMuted, fontSize: TYPE.meta.size, lineHeight: TYPE.meta.lineHeight,
          fontVariant: ["tabular-nums"] }}>
          {elapsedTime(working.since, t, now)}
        </Text>
      ) : null}
    </View>
  );
}
