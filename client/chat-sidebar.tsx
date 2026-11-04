import { useCallback, useState, type ReactNode } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useRpc, useSettings, type PluginScreenProps } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/ui";
import type { SuperagentSnapshot, Ticket } from "../shared/model";
import { SUBSCRIBED_STATUSES, TERMINAL_TICKET_STATUSES } from "../shared/model";
import { agentStatus, currentTickets, directTicket, elapsedTime, ticketPriority } from "../shared/execution";
import {
  ACTIVE_TICKET_STATUSES,
  clockTime,
  markdownPreview,
  relativeTime,
  threadStatus,
  ticketStatusLabel,
  ticketStatusTone,
  watchdogNoteLabel,
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
import { ImDeliveries } from "./im-deliveries";
import { STATE_QUERY_KEY, useExecutionAgents, type AgentObservation } from "./query";
import { Button, ConfirmButton, ExpandableText, GroupLabel, StatTile, StatusBadge, fontSize, radius, space, toneColor, type Theme } from "./ui";

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
      borderBottomWidth: 1, borderBottomColor: theme.colors.border }}>
      {TABS.map((item) => {
        const active = item.id === tab;
        return (
          <Pressable key={item.id} accessibilityRole="tab" accessibilityState={{ selected: active }} onPress={() => onTab(item.id)}
            style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: space.xs + 2, height: 28, paddingHorizontal: space.sm,
              borderRadius: radius.md, backgroundColor: active ? theme.colors.surface2 : pressed ? theme.colors.surface1 : "transparent" })}>
            <Icon name={item.icon} size={14} color={active ? theme.colors.foreground : theme.colors.foregroundMuted} />
            <Text style={{ color: active ? theme.colors.foreground : theme.colors.foregroundMuted, fontSize: fontSize.sm }}>{item.label}</Text>
          </Pressable>
        );
      })}
      <View style={{ flex: 1 }} />
      {trailing}
    </View>
  );
}

export function SidebarContent(props: ChatSidebarProps) {
  const { tab, snapshot, theme } = props;
  if (!snapshot) {
    return <Text style={{ padding: space.lg, color: theme.colors.foregroundMuted, fontSize: fontSize.sm }}>正在读取状态…</Text>;
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
    ? snapshot.tickets.filter((ticket) => ticket.threadId === thread.id)
    : currentTickets(snapshot.tickets);
  // 只读取进行中 Worker 的会话状态;已结束的任务不必轮询。
  const ids = [snapshot.routerAgentId, ...currentTickets(tickets).map((ticket) => ticket.workerAgentId)]
    .filter((id): id is string => Boolean(id));
  const agents = useExecutionAgents(hostId, ids);
  const observe = (ticket: Ticket) => (ticket.workerAgentId ? agents[ticket.workerAgentId] : undefined);
  const ordered = [...tickets].sort((a, b) => ticketPriority(a, observe(a)?.agent) - ticketPriority(b, observe(b)?.agent)
    || b.createdAt.localeCompare(a.createdAt));
  const direct = thread ? directTicket(tickets) : null;
  return (
    <>
      <RouterCard snapshot={snapshot} observation={snapshot.routerAgentId ? agents[snapshot.routerAgentId] : undefined}
        theme={theme} navigation={navigation} />
      <View style={{ gap: space.sm }}>
        <GroupLabel theme={theme}>{thread ? `本对话的 Worker · ${tickets.length}` : `进行中的 Worker · ${tickets.length}`}</GroupLabel>
        {ordered.length === 0 ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.sm, lineHeight: 18 }}>
            {thread ? "Router 还没有为这段对话派发 Worker。" : "暂无进行中的 Worker。选择一段对话查看它的全部任务。"}
          </Text>
        ) : ordered.map((ticket) => (
          <TicketItem key={ticket.id} ticket={ticket} observation={observe(ticket)} direct={direct?.id === ticket.id}
            threadTitle={thread ? null : snapshot.threads.find((item) => item.id === ticket.threadId)?.title ?? null}
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
  const evaluating = snapshot.threads.find((thread) => thread.id === snapshot.engine.currentEvalThreadId);
  const state: StatusLabel = snapshot.engine.evalInFlight ? { label: "评估中", tone: "warning" }
    : { label: snapshot.routerAgentId ? "待命" : "等待新任务", tone: "muted" };
  const session = snapshot.routerAgentId ? observationStatus(observation) : null;
  const routerAgentId = snapshot.routerAgentId;
  return (
    <SidebarCard theme={theme} active={snapshot.engine.evalInFlight}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <Icon name="Route" size={16} color={theme.colors.foregroundMuted} />
        <Text style={{ flex: 1, color: theme.colors.foreground, fontSize: fontSize.base, fontWeight: "500" }}>Router</Text>
        <StatusBadge theme={theme} {...state} />
      </View>
      {session && session.tone !== "muted" && session.label !== "会话执行中" ? (
        <View style={{ flexDirection: "row" }}><StatusBadge theme={theme} {...session} /></View>
      ) : null}
      <Text numberOfLines={2} style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.sm }}>
        {snapshot.routerProvider || "自动选择模型"}
      </Text>
      {evaluating ? (
        <Text numberOfLines={2} style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.sm }}>正在评估 · {evaluating.title}</Text>
      ) : null}
      {routerAgentId && navigation ? (
        <View style={{ flexDirection: "row" }}>
          <Button theme={theme} size="xs" variant="outline" icon="ArrowUpRight" label="打开 Router 会话"
            onPress={() => navigation.openAgent({ agentId: routerAgentId })} />
        </View>
      ) : null}
    </SidebarCard>
  );
}

function TicketItem({ ticket, observation, direct, threadTitle, readOnly, theme, navigation, onOpenThread }: {
  ticket: Ticket;
  observation?: AgentObservation;
  direct: boolean;
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
  const subscribed = ticket.subscribed && SUBSCRIBED_STATUSES.includes(ticket.status);
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
    <SidebarCard theme={theme} active={attention} activeColor={toneColor(session?.tone ?? "danger", theme)}>
      {threadTitle ? (
        <Pressable accessibilityRole="button" accessibilityLabel={`打开对话:${threadTitle}`} disabled={!onOpenThread} onPress={onOpenThread}>
          <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.sm }}>{threadTitle}</Text>
        </Pressable>
      ) : null}
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.sm }}>
        <View style={{ paddingTop: 2 }}><Icon name="Bot" size={15} color={theme.colors.foregroundMuted} /></View>
        <Text numberOfLines={2} style={{ flex: 1, minWidth: 0, color: theme.colors.foreground, fontSize: fontSize.base, lineHeight: 20 }}>{ticket.title}</Text>
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }}>
        <StatusBadge theme={theme} label={ticketStatusLabel(ticket.status)} tone={ticketStatusTone(ticket.status)} />
        {sessionNotice ? <StatusBadge theme={theme} {...sessionNotice} /> : null}
        {direct ? <StatusBadge theme={theme} label="直通" tone="default" /> : null}
      </View>
      <Text numberOfLines={3} style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.sm, lineHeight: 17 }}>{meta}</Text>
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
          <Button theme={theme} size="xs" variant="ghost" label={ticket.status === "waiting" ? "标记完成" : "取消直通"}
            onPress={() => void run(ticket.status === "waiting" ? "已标记完成" : "已取消直通,后续消息交给 Router",
              () => unsubscribe({ threadId: ticket.threadId, ticketId: ticket.id }))} />
        ) : null}
        {terminal && !readOnly ? (
          <Button theme={theme} size="xs" variant="ghost" icon="RotateCcw" label="重试"
            onPress={() => void run("已重新派发", () => retryTicket({ ticketId: ticket.id }))} />
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
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.sm }}>没有进行中的对话</Text>
        )}
      </View>
      {closed.length ? (
        <View style={{ gap: space.xs }}>
          <GroupLabel theme={theme} trailing={
            <Text accessibilityRole="button" onPress={() => setShowClosed((value) => !value)}
              style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.sm }}>{showClosed ? "收起" : "展开"}</Text>
          }>{`已关闭 · ${closed.length}`}</GroupLabel>
          {showClosed ? closed.map(row) : null}
        </View>
      ) : null}
    </>
  );
}

function ThreadRow({ thread, tickets, selected, theme, onPress, onClose }: {
  thread: Thread;
  tickets: Ticket[];
  selected: boolean;
  theme: Theme;
  onPress(): void;
  /** 给出时行尾有「关闭对话」(再点一次确认),不必先打开对话再去「任务」里关。 */
  onClose?: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [armed, setArmed] = useState(false);
  const own = tickets.filter((ticket) => ticket.threadId === thread.id);
  const status = threadStatus(thread, own, thread.lastDecision ? [thread.lastDecision] : []);
  const preview = thread.latestResult ? markdownPreview(thread.latestResult.text).replace(/\s+/g, " ").trim() : thread.summary ?? "";
  // 关闭对话会取消它所有未结束的 Ticket(含待命的 Worker),确认文案里说清楚。
  const workers = own.filter((ticket) => !TERMINAL_TICKET_STATUSES.includes(ticket.status)).length;
  // 触屏没有悬停:一直显示;桌面在悬停、选中或已上膛时显示,隐藏时仍占位,避免标题宽度跳动。
  const showClose = Boolean(onClose) && (Platform.OS !== "web" || hovered || selected || armed);
  return (
    <View onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}
      style={{ flexDirection: "row", alignItems: "center", gap: space.xs, paddingRight: onClose ? space.xs : 0, borderRadius: radius.lg,
        backgroundColor: selected ? theme.colors.surface2 : pressed || hovered ? theme.colors.surface1 : "transparent" }}>
      <Pressable accessibilityRole="button" accessibilityState={{ selected }} accessibilityLabel={`${thread.title},${status.label}`}
        onPress={onPress} onPressIn={() => setPressed(true)} onPressOut={() => setPressed(false)}
        style={{ flex: 1, minWidth: 0, gap: 2, paddingLeft: space.sm, paddingRight: onClose ? 0 : space.sm, paddingVertical: space.sm }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: toneColor(status.tone, theme) }} />
          <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, color: theme.colors.foreground, fontSize: fontSize.base }}>{thread.title}</Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.sm }}>{relativeTime(thread.updatedAt)}</Text>
        </View>
        <Text numberOfLines={1} style={{ marginLeft: 6 + space.sm, color: theme.colors.foregroundMuted, fontSize: fontSize.sm }}>
          {status.label}{preview ? ` · ${preview}` : ""}
        </Text>
      </Pressable>
      {onClose ? (
        <View accessibilityElementsHidden={!showClose} importantForAccessibility={showClose ? "auto" : "no-hide-descendants"}
          style={{ flexShrink: 0, opacity: showClose ? 1 : 0, pointerEvents: showClose ? "auto" : "none" }}>
          <ConfirmButton theme={theme} size="xs" variant="ghost" icon="Archive" accessibilityLabel={`关闭对话 ${thread.title}`}
            confirmLabel={workers ? `关闭并取消 ${workers} 个 Worker` : "确认关闭"} disabled={!showClose}
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
];

function StatusTab({ snapshot, theme, hostId, openSettings }: ChatSidebarProps & { snapshot: SuperagentSnapshot }) {
  const settingsState = useSettings(superagentSettings);
  const settings = settingsState.status === "ready" ? settingsState.values : null;
  const { engine } = snapshot;
  const running = snapshot.tickets.filter((ticket) => ACTIVE_TICKET_STATUSES.includes(ticket.status)).length;
  const failed = snapshot.tickets.filter((ticket) => ticket.status === "failed").length;
  const pending = snapshot.threads.reduce((sum, thread) => sum + thread.pendingTriggers, 0);
  const sources = ["App", settings?.agentToolEnabled ? "Agent 委派" : null,
    ...CHANNEL_LABELS.map(([key, label]) => (settings?.[key] ? label : null))].filter(Boolean).join(" · ");
  let watchdog = "引擎未启动,首次派发或任意 agent 事件后自动启动";
  if (engine.primed) {
    watchdog = engine.lastWatchdogAt
      ? `${clockTime(engine.lastWatchdogAt)} 巡检 · ${watchdogNoteLabel(engine.lastWatchdogNote)}`
      : "等待首次巡检(每 15 秒一次)";
  }
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
      </View>
      {snapshot.imDeliveries.length ? (
        <View style={{ gap: space.sm }}>
          <GroupLabel theme={theme}>IM 答复投递</GroupLabel>
          <ImDeliveries deliveries={snapshot.imDeliveries} theme={theme} hostId={hostId} />
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
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.sm }}>{label}</Text>
      <Text selectable style={{ color: tone ? toneColor(tone, theme) : theme.colors.foreground, fontSize: fontSize.sm, lineHeight: 18 }}>{value}</Text>
    </View>
  );
}

function SidebarCard({ theme, active = false, activeColor, children }: {
  theme: Theme;
  active?: boolean;
  activeColor?: string;
  children: ReactNode;
}) {
  return (
    <View style={{ gap: space.sm, padding: space.md, borderRadius: radius.lg, borderWidth: 1,
      borderColor: active ? activeColor ?? theme.colors.statusWarning : theme.colors.border, backgroundColor: theme.colors.surface1 }}>
      {children}
    </View>
  );
}
