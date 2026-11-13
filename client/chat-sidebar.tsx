import { useCallback, useState, type ReactNode } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useRpc, useSettings, type PluginScreenProps } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/ui";
import type { SuperagentSnapshot, Ticket } from "../shared/model";
import { SUBSCRIBED_STATUSES, TERMINAL_TICKET_STATUSES } from "../shared/model";
import { agentStatus, currentTickets, directTickets, elapsedTime, followsOf, subscribesTo, ticketPriority } from "../shared/execution";
import {
  ACTIVE_TICKET_STATUSES,
  clockTime,
  markdownPreview,
  relativeTime,
  threadStatus,
  ticketStatusLabel,
  ticketStatusTone,
  watchdogNoteLabel,
  patrolSummaryLabel,
  type StatusLabel,
} from "../shared/labels";
import {
  superagentCancelTicketRpc,
  superagentCloseThreadRpc,
  superagentForceEvalRpc,
  superagentRetryTicketRpc,
  superagentUnsubscribeRpc,
} from "../shared/rpc";
import { superagentSettings, type SuperagentSettingsValues } from "../shared/settings";
import { ImDeliveries, undeliveredReplies } from "./im-deliveries";
import { TYPE } from "../shared/design";
import { RunningDot } from "./agent-status-icon";
import { STATE_QUERY_KEY, useExecutionAgents, type AgentObservation } from "./query";
import { HAIRLINE, WEB_TRANSITION, chatTokens, radius, space, type Theme } from "./theme-tokens";
import {
  Button,
  ConfirmButton,
  ExpandableText,
  GroupLabel,
  StatTile,
  StatusBadge,
  TextButton,
  cardSurface,
  toneColor,
  toneDotColor,
  type CardState,
} from "./ui";

/**
 * 对话页右侧栏:对话之外的信息都在这里——
 * 「任务」Router 与本对话的 Worker 及其操作,「对话」全部线程,「状态」运行概览与组件配置。
 */

export type SidebarTab = "tasks" | "threads" | "status";
export const SIDEBAR_WIDTH = 320;

const TABS: { id: SidebarTab; label: string; icon: string }[] = [
  { id: "tasks", label: "任务", icon: "Workflow" },
  { id: "threads", label: "对话", icon: "MessagesSquare" },
  { id: "status", label: "状态", icon: "Activity" },
];

type Thread = SuperagentSnapshot["threads"][number];
type Navigation = PluginScreenProps["navigation"];

export interface ChatSidebarProps {
  tab: SidebarTab;
  onTab(tab: SidebarTab): void;
  /** 全部线程(含已关闭)与 Ticket,不含消息正文。 */
  snapshot: SuperagentSnapshot | undefined;
  threadId: string | null;
  onSelectThread(threadId: string | null): void;
  /** 手动关闭对话成功后调用:顺带关掉它的标签。 */
  onThreadClosed(threadId: string): void;
  theme: Theme;
  hostId: string;
  navigation: Navigation;
  openSettings(): void;
  /** 宽屏时在标签栏右侧放收起按钮。 */
  trailing?: ReactNode;
}

export function SidebarTabs({ tab, onTab, theme, trailing }: Pick<ChatSidebarProps, "tab" | "onTab" | "theme" | "trailing">) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs, height: 44, paddingHorizontal: space.sm,
      borderBottomWidth: HAIRLINE, borderBottomColor: theme.colors.border }}>
      {TABS.map((item) => (
        <SidebarTabButton key={item.id} item={item} active={item.id === tab} theme={theme} onPress={() => onTab(item.id)} />
      ))}
      <View style={{ flex: 1 }} />
      {trailing}
    </View>
  );
}

function SidebarTabButton({ item, active, theme, onPress }: { item: (typeof TABS)[number]; active: boolean; theme: Theme; onPress(): void }) {
  const [hovered, setHovered] = useState(false);
  const tokens = chatTokens(theme);
  const color = active || hovered ? theme.colors.foreground : theme.colors.foregroundMuted;
  return (
    <Pressable accessibilityRole="tab" accessibilityState={{ selected: active }} onPress={onPress}
      onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)}
      style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: space.xs + 2, height: 28, paddingHorizontal: space.sm + 2,
        borderRadius: radius.block, backgroundColor: active || pressed ? tokens.pressed : hovered ? tokens.hover : "transparent", ...WEB_TRANSITION })}>
      <Icon name={item.icon} size={14} color={color} />
      <Text style={{ color, fontSize: TYPE.label.size, lineHeight: TYPE.label.lineHeight, fontWeight: active ? "500" : "400" }}>{item.label}</Text>
    </Pressable>
  );
}

export function SidebarContent(props: ChatSidebarProps) {
  const { tab, snapshot, theme } = props;
  if (!snapshot) {
    return <Text style={{ padding: space.lg, color: theme.colors.foregroundMuted, fontSize: TYPE.label.size, lineHeight: TYPE.label.lineHeight }}>正在读取状态…</Text>;
  }
  return (
    <View style={{ padding: space.md, gap: space.lg }}>
      {tab === "tasks" ? <TasksTab {...props} snapshot={snapshot} /> : null}
      {tab === "threads" ? <ThreadsTab {...props} snapshot={snapshot} /> : null}
      {tab === "status" ? <StatusTab {...props} snapshot={snapshot} /> : null}
    </View>
  );
}

// ---------------------------------------------------------------- tasks

function useAction() {
  const toast = useToast();
  const queryClient = useQueryClient();
  /** 执行操作并提示结果;返回是否成功。 */
  return useCallback(async (successLabel: string, action: () => Promise<{ ok: boolean; error?: string | null }>): Promise<boolean> => {
    try {
      const result = await action();
      void queryClient.invalidateQueries({ queryKey: STATE_QUERY_KEY });
      if (result.ok) toast.show(successLabel, { variant: "success" });
      else toast.error(result.error ?? "操作失败");
      return result.ok;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      return false;
    }
  }, [queryClient, toast]);
}

/** 关闭对话(取消它未结束的 Worker),成功后关掉它的标签。 */
function useCloseThread(onThreadClosed: (threadId: string) => void) {
  const run = useAction();
  const closeThread = useRpc(superagentCloseThreadRpc);
  return (threadId: string) => {
    void run("对话已关闭", () => closeThread({ threadId })).then((ok) => {
      if (ok) onThreadClosed(threadId);
    });
  };
}

function observationStatus(observation?: AgentObservation): StatusLabel | null {
  if (!observation || observation.loading) return null;
  if (observation.error) return { label: "会话状态暂不可用", tone: "warning" };
  return agentStatus(observation.agent);
}

function TasksTab({ snapshot, threadId, onSelectThread, onThreadClosed, theme, hostId, navigation }: ChatSidebarProps & { snapshot: SuperagentSnapshot }) {
  const thread = threadId ? snapshot.threads.find((item) => item.id === threadId) : undefined;
  const tickets = thread
    ? snapshot.tickets.filter((ticket) => ticket.threadId === thread.id || followsOf(ticket).includes(thread.id))
    : currentTickets(snapshot.tickets);
  const routerAgentId = thread ? thread.router?.agentId ?? null : snapshot.routerAgentId;
  const routerSnapshot = thread ? { ...snapshot, routerAgentId, routerProvider: thread.router?.provider ?? snapshot.routerProvider,
    engine: { ...snapshot.engine, evalInFlight: snapshot.engine.evalInFlight && snapshot.engine.currentEvalThreadId === thread.id },
  } : snapshot;
  // 按正在查看的线程观察其 Router,不串到其他线程的最后一次评估。
  const ids = [routerAgentId, ...currentTickets(tickets).map((ticket) => ticket.workerAgentId)]
    .filter((id): id is string => Boolean(id));
  const agents = useExecutionAgents(hostId, ids);
  const observe = (ticket: Ticket) => (ticket.workerAgentId ? agents[ticket.workerAgentId] : undefined);
  const ordered = [...tickets].sort((a, b) => ticketPriority(a, observe(a)?.agent) - ticketPriority(b, observe(b)?.agent)
    || b.createdAt.localeCompare(a.createdAt));
  const directs = thread ? directTickets(tickets, thread.id) : [];
  return (
    <>
      <RouterCard snapshot={routerSnapshot} observation={routerAgentId ? agents[routerAgentId] : undefined}
        theme={theme} navigation={navigation} />
      <View style={{ gap: space.sm }}>
        <GroupLabel theme={theme}>{thread ? `本对话的 Worker · ${tickets.length}` : `进行中的 Worker · ${tickets.length}`}</GroupLabel>
        {ordered.length === 0 ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: TYPE.labelRead.size, lineHeight: TYPE.labelRead.lineHeight }}>
            {thread ? "Router 还没有为这段对话派发 Worker。" : "暂无进行中的 Worker。选择一段对话查看它的全部任务。"}
          </Text>
        ) : ordered.map((ticket) => (
          <TicketItem key={ticket.id} ticket={ticket} observation={observe(ticket)} direct={directs.some((direct) => direct.id === ticket.id)}
            viewThreadId={thread?.id ?? null}
            threadTitle={thread && ticket.threadId === thread.id ? null
              : snapshot.threads.find((item) => item.id === ticket.threadId)?.title ?? (thread ? "其他对话" : null)}
            readOnly={thread?.state === "closed"} theme={theme} navigation={navigation}
            onOpenThread={thread ? undefined : () => onSelectThread(ticket.threadId)} />
        ))}
      </View>
      {thread && thread.state !== "closed" ? <ThreadActions thread={thread} theme={theme} onThreadClosed={onThreadClosed} /> : null}
    </>
  );
}

function RouterCard({ snapshot, observation, theme, navigation }: {
  snapshot: SuperagentSnapshot;
  observation?: AgentObservation;
  theme: Theme;
  navigation: Navigation;
}) {
  const evaluating = snapshot.engine.evalInFlight ? snapshot.threads.find((thread) => thread.id === snapshot.engine.currentEvalThreadId) : undefined;
  const state: StatusLabel = snapshot.engine.evalInFlight ? { label: "评估中", tone: "warning" }
    : { label: snapshot.routerAgentId ? "待命" : "等待新任务", tone: "muted" };
  const session = snapshot.routerAgentId ? observationStatus(observation) : null;
  const routerAgentId = snapshot.routerAgentId;
  return (
    <SidebarCard theme={theme}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <View style={{ width: 16, alignItems: "center" }}>
          {snapshot.engine.evalInFlight ? <RunningDot color={chatTokens(theme).status.running} accessibilityLabel="Router 评估中" />
            : <Icon name="Route" size={15} color={theme.colors.foregroundMuted} />}
        </View>
        <Text style={{ flex: 1, color: theme.colors.foreground, fontSize: TYPE.body.size, lineHeight: TYPE.body.lineHeight, fontWeight: "600" }}>Router</Text>
        <StatusBadge theme={theme} {...state} />
      </View>
      {session && session.tone !== "muted" && session.label !== "会话执行中" ? (
        <View style={{ flexDirection: "row" }}><StatusBadge theme={theme} {...session} /></View>
      ) : null}
      <CardMeta theme={theme} lines={2}>{snapshot.routerProvider || "自动选择模型"}</CardMeta>
      {evaluating ? <CardMeta theme={theme} lines={2}>{`正在评估 · ${evaluating.title}`}</CardMeta> : null}
      {routerAgentId && navigation ? (
        <View style={{ flexDirection: "row" }}>
          <Button theme={theme} size="xs" variant="outline" icon="ArrowUpRight" label="打开 Router 会话"
            onPress={() => navigation.openAgent({ agentId: routerAgentId })} />
        </View>
      ) : null}
    </SidebarCard>
  );
}

function TicketItem({ ticket, observation, direct, viewThreadId = null, threadTitle, readOnly, theme, navigation, onOpenThread }: {
  ticket: Ticket;
  observation?: AgentObservation;
  direct: boolean;
  /** 正在查看的对话;票据只是跟随它(多对多订阅)时,退订作用于这段对话。 */
  viewThreadId?: string | null;
  threadTitle: string | null;
  readOnly: boolean;
  theme: Theme;
  navigation: Navigation;
  onOpenThread?: () => void;
}) {
  const run = useAction();
  const cancelTicket = useRpc(superagentCancelTicketRpc);
  const retryTicket = useRpc(superagentRetryTicketRpc);
  const unsubscribe = useRpc(superagentUnsubscribeRpc);
  const terminal = TERMINAL_TICKET_STATUSES.includes(ticket.status);
  const scopeThreadId = viewThreadId ?? ticket.threadId;
  const following = scopeThreadId !== ticket.threadId;
  const subscribed = subscribesTo(ticket, scopeThreadId) && SUBSCRIBED_STATUSES.includes(ticket.status);
  const active = ACTIVE_TICKET_STATUSES.includes(ticket.status);
  const session = ticket.workerAgentId ? observationStatus(observation) : null;
  // 普通的执行中/空闲不重复占徽标,权限等待与异常仍独立可见。
  const sessionNotice = session && !["会话执行中", "会话空闲", "会话初始化"].includes(session.label) ? session : null;
  const attention = ticketPriority(ticket, observation?.error ? null : observation?.agent) === 0;
  const meta = [
    ticket.profile || "默认 Worker",
    ticket.provider,
    ticket.branchName ? `分支 ${ticket.branchName}` : null,
    active && ticket.startedAt ? `已运行 ${elapsedTime(ticket.startedAt)}` : relativeTime(ticket.updatedAt),
    ticket.attempts > 1 ? `第 ${ticket.attempts} 次尝试` : null,
  ].filter(Boolean).join(" · ");
  const workerId = ticket.workerAgentId;
  return (
    <SidebarCard theme={theme} state={ticket.status === "failed" || (attention && (session?.tone ?? "danger") === "danger") ? "failed"
      : attention ? "attention" : "rest"}>
      {threadTitle ? (
        <Pressable accessibilityRole="button" accessibilityLabel={`打开对话:${threadTitle}`} disabled={!onOpenThread} onPress={onOpenThread}
          style={{ flexDirection: "row", alignItems: "center", gap: space.xs + 2 }}>
          <Icon name="MessagesSquare" size={12} color={theme.colors.foregroundMuted} />
          <Text numberOfLines={1} style={{ flexShrink: 1, color: theme.colors.foregroundMuted, fontSize: TYPE.caption.size,
            lineHeight: TYPE.caption.lineHeight }}>{threadTitle}</Text>
        </Pressable>
      ) : null}
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.sm }}>
        <View style={{ width: 16, height: TYPE.body.lineHeight, alignItems: "center", justifyContent: "center" }}>
          {active ? <RunningDot color={chatTokens(theme).status.running} accessibilityLabel={ticketStatusLabel(ticket.status)} />
            : <Icon name="Bot" size={15} color={theme.colors.foregroundMuted} />}
        </View>
        <Text numberOfLines={2} style={{ flex: 1, minWidth: 0, color: theme.colors.foreground, fontSize: TYPE.body.size, lineHeight: TYPE.body.lineHeight,
          fontWeight: "500" }}>{ticket.title}</Text>
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }}>
        <StatusBadge theme={theme} label={ticketStatusLabel(ticket.status)} tone={ticketStatusTone(ticket.status)} />
        {sessionNotice ? <StatusBadge theme={theme} {...sessionNotice} /> : null}
        {direct ? <StatusBadge theme={theme} label="直通" tone="default" /> : null}
        {following ? <StatusBadge theme={theme} label="跟随本对话" tone="default" /> : null}
        {!following && followsOf(ticket).length ? <StatusBadge theme={theme} label={`另跟随 ${followsOf(ticket).length} 段对话`} tone="muted" /> : null}
        {ticket.speculative ? <StatusBadge theme={theme} label="投机执行" tone="warning" /> : null}
      </View>
      <CardMeta theme={theme} lines={3}>{meta}</CardMeta>
      {ticket.lastError ? (
        <ExpandableText theme={theme} text={ticket.lastError} lines={2} color={theme.colors.statusDanger} />
      ) : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }}>
        {workerId && navigation ? (
          <Button theme={theme} size="xs" variant="outline" icon="ArrowUpRight" label="打开会话"
            onPress={() => navigation.openAgent({ agentId: workerId })} />
        ) : null}
        {onOpenThread ? <Button theme={theme} size="xs" variant="ghost" icon="MessagesSquare" label="对话" onPress={onOpenThread} /> : null}
        {subscribed && !readOnly ? (
          <Button theme={theme} size="xs" variant="ghost"
            label={following ? "取消跟随" : ticket.status === "waiting" && followsOf(ticket).length === 0 ? "标记完成" : "取消直通"}
            onPress={() => void run(following ? "已取消跟随,本对话的后续消息交给 Router"
              : ticket.status === "waiting" && followsOf(ticket).length === 0 ? "已标记完成" : "已取消直通,后续消息交给 Router",
            () => unsubscribe({ threadId: scopeThreadId, ticketId: ticket.id }))} />
        ) : null}
        {terminal && !readOnly ? (
          <Button theme={theme} size="xs" variant="ghost" icon="RotateCcw" label="重试"
            onPress={() => void run("已重新派发", () => retryTicket({ ticketId: ticket.id }))} />
        ) : null}
        {terminal && !readOnly && workerId ? (
          <ConfirmButton theme={theme} size="xs" icon="Trash2" label="清理" confirmLabel="确认清理(归档会话与工作区)"
            onConfirm={() => void run("已清理遗留会话", () => cancelTicket({ ticketId: ticket.id }))} />
        ) : null}
        {terminal || readOnly ? null : (
          <ConfirmButton theme={theme} size="xs" label="取消" confirmLabel="确认取消"
            onConfirm={() => void run("已取消 Ticket", () => cancelTicket({ ticketId: ticket.id }))} />
        )}
      </View>
    </SidebarCard>
  );
}

function ThreadActions({ thread, theme, onThreadClosed }: { thread: Thread; theme: Theme; onThreadClosed(threadId: string): void }) {
  const run = useAction();
  const forceEval = useRpc(superagentForceEvalRpc);
  const closeThread = useCloseThread(onThreadClosed);
  return (
    <View style={{ gap: space.sm }}>
      <GroupLabel theme={theme}>对话操作</GroupLabel>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
        <Button theme={theme} size="xs" variant="outline" icon="RotateCcw" label="重新评估"
          onPress={() => void run("已请求 Router 重新评估", () => forceEval({ threadId: thread.id }))} />
        <ConfirmButton theme={theme} size="xs" icon="X" label="关闭对话" confirmLabel="确认关闭(取消进行中的 Worker)"
          onConfirm={() => closeThread(thread.id)} />
      </View>
    </View>
  );
}

// ---------------------------------------------------------------- threads

function ThreadsTab({ snapshot, threadId, onSelectThread, onThreadClosed, theme }: ChatSidebarProps & { snapshot: SuperagentSnapshot }) {
  const open = snapshot.threads.filter((thread) => thread.state !== "closed");
  const closed = snapshot.threads.filter((thread) => thread.state === "closed");
  // 正在看已关闭的对话时默认展开,让选中项可见;之后展开/收起只由按钮决定。
  const [showClosed, setShowClosed] = useState(() => closed.some((thread) => thread.id === threadId));
  const closeThread = useCloseThread(onThreadClosed);
  const row = (thread: Thread) => (
    <ThreadRow key={thread.id} thread={thread} tickets={snapshot.tickets} selected={thread.id === threadId}
      theme={theme} onPress={() => onSelectThread(thread.id)}
      onClose={thread.state === "closed" ? undefined : () => closeThread(thread.id)} />
  );
  return (
    <>
      <Button theme={theme} variant="secondary" icon="SquarePen" label="新对话" onPress={() => onSelectThread(null)} />
      <View style={{ gap: space.xs }}>
        <GroupLabel theme={theme}>{`进行中 · ${open.length}`}</GroupLabel>
        {open.length ? open.map(row) : (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: TYPE.label.size, lineHeight: TYPE.label.lineHeight }}>没有进行中的对话</Text>
        )}
      </View>
      {closed.length ? (
        <View style={{ gap: space.xs }}>
          <GroupLabel theme={theme} trailing={
            <TextButton theme={theme} label={showClosed ? "收起" : "展开"} onPress={() => setShowClosed((value) => !value)} />
          }>{`已关闭 · ${closed.length}`}</GroupLabel>
          {showClosed ? closed.map(row) : null}
        </View>
      ) : null}
    </>
  );
}

/** 对话行首行高度,以及悬停时覆盖在时间处的按钮高度(Button xs)。 */
const THREAD_LINE_HEIGHT = 20;
const THREAD_ACTION_SIZE = 28;
/** 行首状态点的槽宽:第二行与标题对齐。 */
const THREAD_MARK = 8;

function ThreadRow({ thread, tickets, selected, theme, onPress, onClose }: {
  thread: Thread;
  tickets: Ticket[];
  selected: boolean;
  theme: Theme;
  onPress(): void;
  /** 给出时可在时间处关闭对话(再点一次确认),不必先打开对话再去「任务」里关。 */
  onClose?: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [armed, setArmed] = useState(false);
  const [armedWidth, setArmedWidth] = useState(0);
  const own = tickets.filter((ticket) => ticket.threadId === thread.id);
  const status = threadStatus(thread, own, thread.lastDecision ? [thread.lastDecision] : []);
  const preview = thread.latestResult ? markdownPreview(thread.latestResult.text).replace(/\s+/g, " ").trim() : thread.summary ?? "";
  // 关闭对话会取消它所有未结束的 Ticket(含待命的 Worker),确认文案里说清楚。
  const workers = own.filter((ticket) => !TERMINAL_TICKET_STATUSES.includes(ticket.status)).length;
  // 桌面悬停时,时间处换成归档按钮;触屏没有悬停,改为在选中的对话上显示。上膛期间一直显示。
  const showAction = Boolean(onClose) && (armed || (Platform.OS === "web" ? hovered : selected));
  // 按钮是行按钮的兄弟节点(web 不能嵌套按钮),绝对定位盖在时间上;时间只隐藏不移除,
  // 宽度不变,标题不跳。确认文案更宽时按实测宽度给时间处留位,标题随之让开。
  const actionWidth = armed ? armedWidth : THREAD_ACTION_SIZE;
  const tokens = chatTokens(theme);
  const busy = thread.state !== "closed"
    && (thread.pendingTriggers > 0 || own.some((ticket) => ACTIVE_TICKET_STATUSES.includes(ticket.status)));
  const closed = thread.state === "closed";
  return (
    <View onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}
      style={{ borderRadius: radius.block, ...WEB_TRANSITION,
        backgroundColor: selected || pressed ? tokens.pressed : hovered ? tokens.hover : "transparent" }}>
      <Pressable accessibilityRole="button" accessibilityState={{ selected }} accessibilityLabel={`${thread.title},${status.label}`}
        onPress={onPress} onPressIn={() => setPressed(true)} onPressOut={() => setPressed(false)}
        style={{ gap: 2, paddingHorizontal: space.sm, paddingVertical: space.sm }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <View style={{ width: THREAD_MARK, alignItems: "center" }}>
            {busy ? <RunningDot color={chatTokens(theme).status.running} accessibilityLabel={status.label} />
              : <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: toneDotColor(status.tone, theme) }} />}
          </View>
          <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, color: closed ? theme.colors.foregroundMuted : theme.colors.foreground,
            fontSize: TYPE.body.size, lineHeight: THREAD_LINE_HEIGHT, fontWeight: selected ? "500" : "400" }}>{thread.title}</Text>
          <View style={{ minWidth: showAction ? actionWidth : 0, alignItems: "flex-end" }}>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: TYPE.caption.size, lineHeight: TYPE.caption.lineHeight,
              fontVariant: ["tabular-nums"], opacity: showAction ? 0 : 1 }}>
              {relativeTime(thread.updatedAt)}
            </Text>
          </View>
        </View>
        <Text numberOfLines={1} style={{ marginLeft: THREAD_MARK + space.sm, color: theme.colors.foregroundMuted, fontSize: TYPE.caption.size,
          lineHeight: TYPE.caption.lineHeight }}>
          <Text style={{ color: status.tone === "danger" || status.tone === "warning" ? toneColor(status.tone, theme) : theme.colors.foregroundMuted }}>
            {status.label}
          </Text>
          {preview ? ` · ${preview}` : ""}
        </Text>
      </Pressable>
      {onClose && showAction ? (
        <View onLayout={armed ? (event) => setArmedWidth(event.nativeEvent.layout.width) : undefined}
          style={{ position: "absolute", right: space.sm, top: space.sm + (THREAD_LINE_HEIGHT - THREAD_ACTION_SIZE) / 2 }}>
          <ConfirmButton theme={theme} size="xs" variant="ghost" icon="Archive" accessibilityLabel={`关闭对话 ${thread.title}`}
            confirmLabel={workers ? `关闭并取消 ${workers} 个 Worker` : "确认关闭"}
            onArmedChange={setArmed} onConfirm={onClose} />
        </View>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------- status

const CHANNEL_LABELS: [keyof SuperagentSettingsValues, string][] = [
  ["feishuEnabled", "飞书"],
  ["qqEnabled", "QQ"],
  ["dingtalkEnabled", "钉钉"],
  ["wecomEnabled", "企业微信"],
  ["weixinEnabled", "微信"],
];

function StatusTab({ snapshot, theme, hostId, navigation, openSettings }: ChatSidebarProps & { snapshot: SuperagentSnapshot }) {
  const settingsState = useSettings(superagentSettings);
  const settings = settingsState.status === "ready" ? settingsState.values : null;
  const { engine } = snapshot;
  const running = snapshot.tickets.filter((ticket) => ACTIVE_TICKET_STATUSES.includes(ticket.status)).length;
  const failed = snapshot.tickets.filter((ticket) => ticket.status === "failed").length;
  const pending = snapshot.threads.reduce((sum, thread) => sum + thread.pendingTriggers, 0);
  const undelivered = undeliveredReplies(snapshot.imDeliveries);
  const sources = ["App", settings?.agentToolEnabled ? "Agent 委派" : null,
    ...CHANNEL_LABELS.map(([key, label]) => (settings?.[key] ? label : null))].filter(Boolean).join(" · ");
  let watchdog = "引擎未启动,首次派发或任意 agent 事件后自动启动";
  if (engine.primed) {
    watchdog = engine.lastWatchdogAt
      ? `${clockTime(engine.lastWatchdogAt)} 巡检 · ${watchdogNoteLabel(engine.lastWatchdogNote)}`
      : "等待首次巡检(每 15 秒一次)";
  }
  const patrol = engine.patrol;
  let patrolText: string | null = null;
  if (patrol?.enabled) {
    if (patrol.running) patrolText = "巡检中…";
    else if (patrol.lastRunAt) {
      patrolText = `${clockTime(patrol.lastRunAt)} · ${patrol.lastError ? `出错:${patrol.lastError}` : patrolSummaryLabel(patrol.lastSummary)}`;
    } else patrolText = `等待首次巡检(每 ${settings?.watchdogIntervalMin ?? 30} 分钟)`;
  }
  const patrolAgentId = patrol?.agentId ?? null;
  return (
    <>
      <View style={{ gap: space.sm }}>
        <View style={{ flexDirection: "row", gap: space.sm }}>
          <StatTile theme={theme} label="对话" value={snapshot.threads.filter((thread) => thread.state !== "closed").length} />
          <StatTile theme={theme} label="运行中" value={running} tone={running > 0 ? "warning" : "default"} />
        </View>
        <View style={{ flexDirection: "row", gap: space.sm }}>
          <StatTile theme={theme} label="待评估" value={pending} tone={engine.evalInFlight ? "warning" : "default"}
            caption={engine.evalInFlight ? "评估中" : null} />
          <StatTile theme={theme} label="失败" value={failed} tone={failed > 0 ? "danger" : "default"} />
        </View>
      </View>
      <View style={{ gap: space.md }}>
        <GroupLabel theme={theme}>组件</GroupLabel>
        <InfoRow theme={theme} label="Router" value={snapshot.routerProvider || "自动选择"} />
        <InfoRow theme={theme} label={snapshot.workerProfiles.length ? "默认 Worker" : "Worker"}
          value={`${snapshot.workerProvider || "自动选择"} · ${settings?.workerIsolation === "shared" ? "共享目录" : "独立 worktree"}`} />
        {snapshot.workerProfiles.length ? (
          <InfoRow theme={theme} label="Worker 档位"
            value={snapshot.workerProfiles.map((profile) => `${profile.name} → ${profile.provider}`).join("\n")} />
        ) : null}
        <InfoRow theme={theme} label="工作目录" value={snapshot.workingDir || "未配置"}
          tone={snapshot.workingDirIssue || !snapshot.workingDir ? "warning" : undefined} />
        {snapshot.workingDirIssue ? <InfoRow theme={theme} label="目录问题" value={snapshot.workingDirIssue} tone="danger" /> : null}
        <InfoRow theme={theme} label="触发来源" value={sources} />
        <InfoRow theme={theme} label="看门狗" value={watchdog} />
        {patrolText ? (
          <InfoRow theme={theme} label="LLM 巡检" value={patrolText} tone={patrol?.lastError ? "warning" : undefined} />
        ) : null}
        {patrolAgentId && navigation ? (
          <View style={{ flexDirection: "row" }}>
            <Button theme={theme} variant="outline" size="xs" icon="ShieldCheck" label="打开巡检会话(可直接问诊)"
              onPress={() => navigation.openAgent({ agentId: patrolAgentId })} />
          </View>
        ) : null}
      </View>
      {undelivered.length ? (
        <View style={{ gap: space.sm }}>
          <GroupLabel theme={theme}>{`未送达的 IM 回复(${undelivered.length})`}</GroupLabel>
          <ImDeliveries deliveries={undelivered} theme={theme} hostId={hostId} />
        </View>
      ) : null}
      <View style={{ flexDirection: "row" }}>
        <Button theme={theme} variant="outline" size="xs" icon="Settings" label="打开设置" onPress={openSettings} />
      </View>
    </>
  );
}

function InfoRow({ theme, label, value, tone }: { theme: Theme; label: string; value: string; tone?: "warning" | "danger" }) {
  return (
    <View style={{ gap: 2 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: TYPE.caption.size, lineHeight: TYPE.caption.lineHeight }}>{label}</Text>
      <Text selectable style={{ color: tone ? toneColor(tone, theme) : theme.colors.foreground, fontSize: TYPE.labelRead.size,
        lineHeight: TYPE.labelRead.lineHeight }}>{value}</Text>
    </View>
  );
}

/** 卡片里的次要说明:12/18(会换行的小字多给行距)、次要色。 */
function CardMeta({ theme, lines, children }: { theme: Theme; lines: number; children: string }) {
  return (
    <Text numberOfLines={lines} style={{ color: theme.colors.foregroundMuted, fontSize: TYPE.captionRead.size, lineHeight: TYPE.captionRead.lineHeight }}>
      {children}
    </Text>
  );
}

/** 侧栏卡片(better-paseo 任务卡):抬起的表面、细线描边、轻阴影;失败与待处理换底色与描边。 */
function SidebarCard({ theme, state = "rest", children }: { theme: Theme; state?: CardState; children: ReactNode }) {
  return (
    <View style={{ gap: space.sm, paddingTop: space.sm + 2, paddingBottom: space.md, paddingHorizontal: space.md, ...cardSurface(theme, state) }}>
      {children}
    </View>
  );
}
