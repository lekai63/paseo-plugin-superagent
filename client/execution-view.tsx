import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import type { SuperagentSnapshot, Ticket } from "../shared/model";
import { agentStatus, currentTickets, directTicket, elapsedTime, ticketPriority, workspaceThreadIds } from "../shared/execution";
import { markdownPreview, relativeTime, ticketStatusLabel, ticketStatusTone, type StatusLabel } from "../shared/labels";
import { useExecutionAgents, type AgentObservation } from "./query";
import { Button, Card, StatusBadge, fontSize, radius, space, toneColor, type Theme } from "./ui";

interface ExecutionViewProps {
  snapshot: SuperagentSnapshot;
  theme: Theme;
  hostId: string;
  navigation: PluginScreenProps["navigation"];
  compact: boolean;
  workspaceId?: string;
  onDetails(input?: { threadId?: string; ticketId?: string }): void;
}

function observationStatus(observation?: AgentObservation): StatusLabel {
  if (!observation || observation.loading) return { label: "读取会话中", tone: "muted" };
  if (observation.error) return { label: "会话状态暂不可用", tone: "warning" };
  return agentStatus(observation.agent);
}

/** 一个 Router 连接当前 Worker,终态记录和消息通过详情进入历史页。 */
export function ExecutionView({ snapshot, theme, hostId, navigation, compact, workspaceId, onDetails }: ExecutionViewProps) {
  const [showAllThreads, setShowAllThreads] = useState(false);
  const [width, setWidth] = useState(0);
  const [workerAreaWidth, setWorkerAreaWidth] = useState(0);
  const narrow = compact || width < 720;
  const columns = narrow ? 1 : Math.max(1, Math.min(3, Math.floor((workerAreaWidth + space.md) / (220 + space.md))));
  const workerWidth = columns === 1 ? "100%" : Math.floor((workerAreaWidth - (columns - 1) * space.md) / columns);
  const related = workspaceId ? workspaceThreadIds(snapshot, workspaceId) : null;
  const threads = snapshot.threads.filter((thread) => !related || showAllThreads || related.has(thread.id));
  const threadIds = new Set(threads.map((thread) => thread.id));
  const tickets = snapshot.tickets.filter((ticket) => threadIds.has(ticket.threadId));
  const workers = currentTickets(tickets);
  const ids = [snapshot.routerAgentId, ...workers.map((ticket) => ticket.workerAgentId)].filter((id): id is string => Boolean(id));
  const agents = useExecutionAgents(hostId, ids);
  const ordered = [...workers].sort((a, b) => ticketPriority(a, a.workerAgentId ? agents[a.workerAgentId]?.agent : null)
    - ticketPriority(b, b.workerAgentId ? agents[b.workerAgentId]?.agent : null)
    || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const directIds = new Set(threads.map((thread) => directTicket(tickets.filter((ticket) => ticket.threadId === thread.id))?.id));
  const evaluating = snapshot.threads.find((thread) => thread.id === snapshot.engine.currentEvalThreadId);
  const pending = threads.filter((thread) => thread.pendingTriggers > 0);
  const running = workers.filter((ticket) => ticket.status === "running" || ticket.status === "launching").length;
  const waiting = workers.filter((ticket) => ticket.status === "waiting").length;
  const failed = tickets.filter((ticket) => ticket.status === "failed").length;
  const result = (snapshot.recentResults ?? []).find((item) => !workspaceId || showAllThreads || item.workspaceIds.includes(workspaceId));
  const routerStatus = snapshot.routerAgentId ? observationStatus(agents[snapshot.routerAgentId]) : null;
  const routerState: StatusLabel = snapshot.engine.evalInFlight ? { label: "评估中", tone: "warning" }
    : { label: snapshot.routerAgentId ? "待命" : "等待新任务", tone: "muted" };
  return (
    <View onLayout={(event) => setWidth(event.nativeEvent.layout.width)} style={{ gap: space.md }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }}>
        {workspaceId ? <Button theme={theme} size="xs" variant="outline"
          label={showAllThreads ? "全部线程" : "当前工作区"} onPress={() => setShowAllThreads((value) => !value)} /> : null}
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.sm }}>
          {running} 执行中 · {waiting} 待命 · {pending.reduce((sum, thread) => sum + thread.pendingTriggers, 0)} 待评估
        </Text>
        {failed ? <Button theme={theme} variant="ghost" size="xs" icon="CircleAlert" label={`${failed} 个失败任务`} danger onPress={() => onDetails()} /> : null}
        {workspaceId ? <Button theme={theme} variant="ghost" size="xs" icon="History" label="历史消息" onPress={() => onDetails()} /> : null}
      </View>
      <Card theme={theme} style={{ padding: space.lg }}>
        <View style={{ flexDirection: narrow ? "column" : "row", gap: space.md }}>
          <Card theme={theme} style={{ width: narrow ? undefined : 180, alignSelf: narrow ? "stretch" : "center",
            backgroundColor: theme.colors.surface0, padding: space.md, gap: space.sm,
            borderColor: snapshot.engine.evalInFlight ? theme.colors.statusWarning : theme.colors.border }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
              <Icon name="Route" size={18} color={theme.colors.foregroundMuted} />
              <Text style={{ color: theme.colors.foreground, fontSize: fontSize.base, fontWeight: "600" }}>Router</Text>
            </View>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }}>
              <StatusBadge theme={theme} {...routerState} />
              {routerStatus && routerStatus.tone !== "muted" && routerStatus.label !== "会话执行中"
                ? <StatusBadge theme={theme} {...routerStatus} /> : null}
            </View>
            <Text numberOfLines={2} style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.sm }}>{snapshot.routerProvider || "自动选择模型"}</Text>
            {evaluating ? <Text numberOfLines={2} style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.sm }}>正在评估 · {evaluating.title}</Text> : null}
            {snapshot.routerAgentId && navigation ? <Button theme={theme} label="打开会话" icon="ArrowUpRight" size="xs" variant="ghost"
              onPress={() => navigation.openAgent({ agentId: snapshot.routerAgentId! })} /> : null}
          </Card>

          <View style={{ width: narrow ? undefined : 24, height: narrow ? 24 : undefined, alignSelf: "stretch", alignItems: "center", justifyContent: "center" }}>
            <View style={narrow
              ? { position: "absolute", top: 0, bottom: 0, width: 1, backgroundColor: theme.colors.border }
              : { position: "absolute", left: 0, right: 0, height: 1, backgroundColor: theme.colors.border }} />
            <View style={{ backgroundColor: theme.colors.surface1 }}>
              <Icon name={narrow ? "ArrowDown" : "ArrowRight"} size={16} color={theme.colors.foregroundMuted} />
            </View>
          </View>

          <View onLayout={(event) => setWorkerAreaWidth(event.nativeEvent.layout.width)}
            style={{ flex: 1, minWidth: 0, flexDirection: "row", flexWrap: "wrap", gap: space.md, alignContent: "center" }}>
            {ordered.length === 0 ? <View style={{ flex: 1, minWidth: 0, justifyContent: "center", gap: space.sm, padding: space.md }}>
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.base }}>
                {workspaceId && !showAllThreads ? "当前工作区没有活跃 Worker" : pending.length ? "Router 正在处理待评估任务" : "暂无活跃 Worker"}
              </Text>
              <Button theme={theme} variant="ghost" size="xs"
                label={workspaceId && !showAllThreads ? "查看全部线程" : "查看历史消息"}
                onPress={() => workspaceId && !showAllThreads ? setShowAllThreads(true) : onDetails()} />
            </View> : ordered.map((ticket) => <View key={ticket.id} style={{ width: workerWidth }}>
              <WorkerNode ticket={ticket} threadTitle={threads.find((thread) => thread.id === ticket.threadId)?.title ?? ""}
                observation={ticket.workerAgentId ? agents[ticket.workerAgentId] : undefined}
                direct={directIds.has(ticket.id)} theme={theme} navigation={navigation}
                onDetails={() => onDetails({ threadId: ticket.threadId, ticketId: ticket.id })} />
            </View>)}
          </View>
        </View>
        {pending.length > 0 ? <View style={{ marginTop: space.lg, paddingTop: space.md, borderTopWidth: 1, borderTopColor: theme.colors.border, gap: space.xs }}>
          {pending.map((thread) => <View key={thread.id} style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            <Icon name="MessageCircle" size={14} color={theme.colors.foregroundMuted} />
            <Text numberOfLines={1} style={{ flex: 1, color: theme.colors.foregroundMuted, fontSize: fontSize.sm }}>
              {thread.id === snapshot.engine.currentEvalThreadId ? "评估中" : "等待评估"} · {thread.title} · {thread.pendingTriggers} 条
            </Text>
            <Button theme={theme} variant="ghost" size="xs" label="详情" accessibilityLabel={`${thread.title}消息详情`} onPress={() => onDetails({ threadId: thread.id })} />
          </View>)}
        </View> : null}
        {result ? <View style={{ marginTop: space.md, paddingTop: space.md, borderTopWidth: 1, borderTopColor: theme.colors.border, gap: space.xs }}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }}>
            <Icon name="FileCheck" size={16} color={theme.colors.foregroundMuted} />
            <Text style={{ color: theme.colors.foreground, fontSize: fontSize.base, fontWeight: "500" }}>
              {result.kind === "router_reply" ? "Router 最新答复" : "Worker 最新汇报"}
            </Text>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.sm }}>{relativeTime(result.createdAt)}</Text>
            <Button theme={theme} variant="outline" size="xs" label="查看结果" onPress={() => onDetails({
              threadId: result.threadId, ...(result.ticketIds.length === 1 ? { ticketId: result.ticketIds[0] } : {}),
            })} />
          </View>
          <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.sm }}>{result.title}</Text>
          <Text numberOfLines={2} style={{ color: theme.colors.foreground, fontSize: fontSize.base, lineHeight: 20 }}>{markdownPreview(result.text).replace(/\s+/g, " ").trim()}</Text>
        </View> : null}
      </Card>
    </View>
  );
}

function WorkerNode({ ticket, threadTitle, observation, direct, theme, navigation, onDetails }: {
  ticket: Ticket;
  threadTitle: string;
  observation?: AgentObservation;
  direct: boolean;
  theme: Theme;
  navigation: PluginScreenProps["navigation"];
  onDetails(): void;
}) {
  const session = observationStatus(observation);
  const attention = ticketPriority(ticket, observation?.error ? null : observation?.agent) === 0;
  const active = ticket.status === "running" || ticket.status === "launching";
  const canOpen = Boolean(ticket.workerAgentId && navigation);
  // 普通的 running/idle 不重复占一枚徽标,权限与异常仍独立可见。
  const sessionNotice = ticket.workerAgentId && !["会话执行中", "会话空闲", "会话初始化"].includes(session.label);
  return (
    <View style={{ borderWidth: 1, borderRadius: radius.md, borderColor: attention ? toneColor(session.tone, theme) : theme.colors.border, overflow: "hidden", backgroundColor: theme.colors.surface0 }}>
      <Pressable disabled={!canOpen} accessibilityRole={canOpen ? "button" : undefined}
        accessibilityLabel={`${ticket.title}，${ticketStatusLabel(ticket.status)}${canOpen ? "，打开 Worker 会话" : ""}`}
        onPress={() => { if (ticket.workerAgentId) navigation?.openAgent({ agentId: ticket.workerAgentId }); }}
        style={({ pressed }) => ({ padding: space.md, gap: space.xs + 2, backgroundColor: pressed ? theme.colors.surface2 : "transparent" })}>
        <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.sm }}>{threadTitle}</Text>
        <View style={{ flexDirection: "row", gap: space.sm, alignItems: "center" }}>
          <Icon name="Bot" size={15} color={theme.colors.foregroundMuted} />
          <Text numberOfLines={2} style={{ flex: 1, minWidth: 0, color: theme.colors.foreground, fontSize: fontSize.base, fontWeight: "500" }}>{ticket.title}</Text>
          {canOpen ? <Icon name="ArrowUpRight" size={12} color={theme.colors.foregroundMuted} /> : null}
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }}>
          <StatusBadge theme={theme} label={ticketStatusLabel(ticket.status)} tone={ticketStatusTone(ticket.status)} />
          {sessionNotice ? <StatusBadge theme={theme} {...session} /> : null}
          {direct ? <StatusBadge theme={theme} label="直通" tone="default" /> : null}
        </View>
        <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.sm }}>{ticket.profile || "默认 Worker"} · {ticket.provider || "启动时选择模型"}</Text>
      </Pressable>
      <View style={{ paddingHorizontal: space.sm, paddingBottom: space.xs, flexDirection: "row", alignItems: "center", gap: space.xs }}>
        <Text numberOfLines={1} style={{ flex: 1, paddingLeft: space.xs, color: theme.colors.foregroundMuted, fontSize: fontSize.sm }}>
          {active && ticket.startedAt ? `启动至今 ${elapsedTime(ticket.startedAt)}` : ""}
        </Text>
        <Button theme={theme} label="详情" accessibilityLabel={`${ticket.title}详情`} size="xs" variant="ghost" onPress={onDetails} />
      </View>
    </View>
  );
}
