import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { Icon, Modal } from "@getpaseo/plugin/client/ui";
import type { SuperagentSnapshot, Ticket } from "../shared/model";
import { agentStatus, directTicket, elapsedTime, isFinishedTicket, ticketPriority, workspaceThreadIds } from "../shared/execution";
import { markdownPreview, relativeTime, threadStatus, ticketStatusLabel, ticketStatusTone, type StatusLabel } from "../shared/labels";
import { useExecutionAgents, type AgentObservation } from "./query";
import { ThreadCard } from "./thread-card";
import { Button, Card, Divider, StatusBadge, fontSize, radius, space, toneColor, type Theme } from "./ui";

interface ExecutionViewProps {
  snapshot: SuperagentSnapshot;
  theme: Theme;
  hostId: string;
  navigation: PluginScreenProps["navigation"];
  compact: boolean;
  /** 右侧面板默认按当前 Worker 的工作区定位线程。主界面不设范围。 */
  workspaceId?: string;
}

function observationStatus(observation?: AgentObservation): StatusLabel {
  if (!observation || observation.loading) return { label: "读取会话中", tone: "muted" };
  if (observation.error) return { label: "会话状态暂不可用", tone: "warning" };
  return agentStatus(observation.agent);
}

export function ExecutionView({ snapshot, theme, hostId, navigation, compact, workspaceId }: ExecutionViewProps) {
  const [showAllThreads, setShowAllThreads] = useState(false);
  const [width, setWidth] = useState(0);
  const narrow = compact || width < 640;
  const [showFinished, setShowFinished] = useState(false);
  const [selected, setSelected] = useState<{ threadId: string; ticketId?: string } | null>(null);
  const related = workspaceId ? workspaceThreadIds(snapshot, workspaceId) : null;
  const threads = snapshot.threads.filter((thread) => !related || showAllThreads || related.has(thread.id));
  const threadIds = new Set(threads.map((thread) => thread.id));
  const tickets = snapshot.tickets.filter((ticket) => threadIds.has(ticket.threadId));
  const visibleTickets = tickets.filter((ticket) => showFinished || !isFinishedTicket(ticket));
  const ids = [snapshot.routerAgentId, ...visibleTickets.map((ticket) => ticket.workerAgentId)].filter((id): id is string => Boolean(id));
  const agents = useExecutionAgents(hostId, ids);
  const routerAgent = snapshot.routerAgentId ? agents[snapshot.routerAgentId] : undefined;
  const routerState: StatusLabel = snapshot.engine.evalInFlight
    ? { label: "正在评估", tone: "warning" }
    : { label: snapshot.routerAgentId ? "待命" : "首次评估时启动", tone: "muted" };
  const selectedThread = snapshot.threads.find((thread) => thread.id === selected?.threadId);
  const finishedCount = tickets.filter(isFinishedTicket).length;
  const orderedThreads = [...threads].sort((a, b) => {
    const rank = (id: string) => {
      if (snapshot.engine.currentEvalThreadId === id) return -1;
      return Math.min(5, ...visibleTickets.filter((ticket) => ticket.threadId === id)
        .map((ticket) => ticketPriority(ticket, ticket.workerAgentId ? agents[ticket.workerAgentId]?.agent : null)));
    };
    return rank(a.id) - rank(b.id) || b.updatedAt.localeCompare(a.updatedAt);
  });

  return (
    <View onLayout={(event) => setWidth(event.nativeEvent.layout.width)} style={{ gap: space.md }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }}>
        {workspaceId ? <Button theme={theme} size="xs" variant="outline"
          label={showAllThreads ? "范围：全部线程" : "范围：当前工作区"}
          onPress={() => setShowAllThreads((value) => !value)} /> : null}
        {finishedCount > 0 ? <Button theme={theme} size="xs" variant="ghost"
          label={showFinished ? "收起已完成／取消" : `显示已完成／取消 · ${finishedCount}`}
          onPress={() => setShowFinished((value) => !value)} /> : null}
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.sm }}>
          {threads.length} 个线程 · {visibleTickets.length} 个可见任务
        </Text>
      </View>

      <Card theme={theme} style={{ padding: space.md, gap: space.sm }}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm, alignItems: "center" }}>
          <Icon name="Route" size={18} color={theme.colors.foregroundMuted} />
          <Text style={{ color: theme.colors.foreground, fontSize: fontSize.base, fontWeight: "600" }}>Router</Text>
          <StatusBadge theme={theme} {...routerState} />
          {snapshot.routerAgentId ? <StatusBadge theme={theme} {...observationStatus(routerAgent)} /> : null}
          {snapshot.routerAgentId && navigation ? <Button theme={theme} label="打开会话" icon="ArrowUpRight" size="xs" variant="ghost"
            onPress={() => navigation.openAgent({ agentId: snapshot.routerAgentId! })} /> : null}
        </View>
        <Text numberOfLines={2} style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.sm }}>
          {snapshot.routerProvider || "自动选择模型"}
          {snapshot.engine.currentEvalThreadId ? ` · 正在评估：${snapshot.threads.find((thread) => thread.id === snapshot.engine.currentEvalThreadId)?.title ?? "线程"}` : " · 按线程派发任务，汇报回流后继续评估"}
        </Text>
      </Card>

      {orderedThreads.length === 0 ? (
        <Card theme={theme} style={{ padding: space.lg, gap: space.sm }}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.base }}>
            {workspaceId && !showAllThreads ? "当前工作区没有关联的 Ticket" : "派发任务后，在这里查看 Router 与 Worker 的执行关系"}
          </Text>
          {workspaceId && !showAllThreads ? <Button theme={theme} label="查看全部线程" size="xs" variant="outline" onPress={() => setShowAllThreads(true)} /> : null}
        </Card>
      ) : orderedThreads.map((thread) => {
        const allTickets = tickets.filter((ticket) => ticket.threadId === thread.id);
        const workers = visibleTickets.filter((ticket) => ticket.threadId === thread.id).sort((a, b) =>
          ticketPriority(a, a.workerAgentId ? agents[a.workerAgentId]?.agent : null)
          - ticketPriority(b, b.workerAgentId ? agents[b.workerAgentId]?.agent : null)
          || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
        const direct = directTicket(allTickets);
        const evaluating = snapshot.engine.currentEvalThreadId === thread.id;
        const status = evaluating ? { label: "Router 评估中", tone: "warning" as const }
          : threadStatus(thread, allTickets, snapshot.decisions.filter((decision) => decision.threadId === thread.id));
        const route = direct ? `追加消息 → ${direct.title}（直通）`
          : "追加消息 → Router 评估";
        return (
          <Card key={thread.id} theme={theme} style={{ borderColor: evaluating ? theme.colors.statusWarning : theme.colors.border }}>
            <View style={{ padding: space.md, gap: space.sm }}>
              <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.sm }}>
                <Text numberOfLines={2} style={{ flex: 1, minWidth: 100, color: theme.colors.foreground, fontSize: fontSize.base, fontWeight: "500" }}>{thread.title}</Text>
                <StatusBadge theme={theme} {...status} />
                <Button theme={theme} label="线程详情" variant="ghost" size="xs" onPress={() => setSelected({ threadId: thread.id })} />
              </View>
              <Text numberOfLines={2} style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.sm }}>{route}</Text>
              {thread.pendingTriggers > 0 ? <Text style={{ color: theme.colors.statusWarning, fontSize: fontSize.sm }}>
                {thread.pendingTriggers} 条消息{evaluating ? "正在评估" : "等待 Router 评估"}
              </Text> : null}
            </View>
            <Divider theme={theme} />
            <View style={{ padding: space.md, flexDirection: narrow ? "column" : "row", gap: space.md }}>
              <View style={{ width: narrow ? undefined : 132, gap: space.sm }}>
                <View style={{ borderWidth: 1, borderRadius: radius.md, borderColor: evaluating ? theme.colors.statusWarning : theme.colors.border,
                  padding: space.sm, flexDirection: "row", alignItems: "center", gap: space.sm, alignSelf: "flex-start" }}>
                  <Icon name="Route" size={16} color={evaluating ? theme.colors.statusWarning : theme.colors.foregroundMuted} />
                  <Text style={{ color: theme.colors.foreground, fontSize: fontSize.base }}>Router</Text>
                  <Icon name={narrow ? "ArrowDown" : "ArrowRight"} size={14} color={theme.colors.foregroundMuted} />
                </View>
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.sm }}>按 Ticket 派发 Worker</Text>
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.sm }}>Worker 汇报 ↩ Router</Text>
              </View>
              <View style={{ flex: 1, minWidth: 0, borderLeftWidth: 1, borderLeftColor: theme.colors.border, paddingLeft: space.md, gap: space.md }}>
                {workers.length === 0 ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.sm }}>
                  {allTickets.length ? "已完成／取消的任务已折叠" : "尚未派发 Worker，Router 也可直接答复"}
                </Text> : workers.map((ticket) => (
                  <View key={ticket.id}>
                    <View style={{ position: "absolute", left: -space.md, top: 28, width: space.md, height: 1, backgroundColor: theme.colors.border }} />
                    <WorkerCard ticket={ticket} observation={ticket.workerAgentId ? agents[ticket.workerAgentId] : undefined}
                    direct={ticket.id === direct?.id} theme={theme} navigation={navigation}
                    onDetails={() => setSelected({ threadId: thread.id, ticketId: ticket.id })} />
                  </View>
                ))}
              </View>
            </View>
          </Card>
        );
      })}

      <Modal title="任务详情与活动" open={Boolean(selectedThread)} onOpenChange={(open) => { if (!open) setSelected(null); }}>
        <Modal.Content>
          {selectedThread ? <ThreadCard key={`${selectedThread.id}:${selected?.ticketId ?? "thread"}`}
            thread={selectedThread} tickets={snapshot.tickets} triggers={snapshot.triggers} decisions={snapshot.decisions}
            theme={theme} navigation={navigation} defaultExpanded focusTicketId={selected?.ticketId} /> : null}
        </Modal.Content>
      </Modal>
    </View>
  );
}

function WorkerCard({ ticket, observation, direct, theme, navigation, onDetails }: {
  ticket: Ticket;
  observation?: AgentObservation;
  direct: boolean;
  theme: Theme;
  navigation: PluginScreenProps["navigation"];
  onDetails(): void;
}) {
  const session = observationStatus(observation);
  const priority = ticketPriority(ticket, observation?.error ? null : observation?.agent);
  const active = ticket.status === "running" || ticket.status === "launching";
  const meta = [ticket.profile ? `档位 ${ticket.profile}` : "默认 Worker", ticket.provider,
    observation?.agent?.model && !ticket.provider?.endsWith(`/${observation.agent.model}`) ? observation.agent.model : null,
    active && ticket.startedAt ? `本次启动至今 ${elapsedTime(ticket.startedAt)}` : `更新于 ${relativeTime(ticket.updatedAt)}`,
    ticket.attempts > 1 ? `第 ${ticket.attempts} 次尝试` : null].filter(Boolean).join(" · ");
  const canOpen = Boolean(ticket.workerAgentId && navigation);
  return (
    <View style={{ borderWidth: 1, borderRadius: radius.md, borderColor: priority === 0
      ? toneColor(ticket.status === "failed" ? "danger" : session.tone, theme) : theme.colors.border, overflow: "hidden" }}>
      <Pressable disabled={!canOpen} accessibilityRole={canOpen ? "button" : undefined}
        accessibilityLabel={`${ticket.title}，${ticketStatusLabel(ticket.status)}${canOpen ? "，打开 Worker 会话" : ""}`}
        onPress={() => { if (ticket.workerAgentId) navigation?.openAgent({ agentId: ticket.workerAgentId }); }}
        style={({ pressed }) => ({ padding: space.md, gap: space.sm, backgroundColor: pressed ? theme.colors.surface2 : theme.colors.surface0 })}>
        <View style={{ flexDirection: "row", gap: space.sm, alignItems: "center" }}>
          <Icon name="Bot" size={16} color={theme.colors.foregroundMuted} />
          <Text numberOfLines={2} style={{ flex: 1, color: theme.colors.foreground, fontSize: fontSize.base, fontWeight: "500" }}>{ticket.title}</Text>
          {canOpen ? <Icon name="ArrowUpRight" size={14} color={theme.colors.foregroundMuted} /> : null}
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }}>
          <StatusBadge theme={theme} label={`Ticket · ${ticketStatusLabel(ticket.status)}`} tone={ticketStatusTone(ticket.status)} />
          {ticket.workerAgentId ? <StatusBadge theme={theme} {...session} /> : null}
          {direct ? <StatusBadge theme={theme} label="消息直通" tone="default" /> : null}
        </View>
        <Text numberOfLines={3} style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.sm }}>{meta}</Text>
        {ticket.branchName ? <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.sm }}>分支 · {ticket.branchName}</Text> : null}
        {ticket.lastError || observation?.agent?.lastError ? <Text numberOfLines={2} style={{ color: theme.colors.statusDanger, fontSize: fontSize.sm }}>
          {ticket.lastError || observation?.agent?.lastError}
        </Text> : null}
        {ticket.report ? <Text numberOfLines={2} style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.sm }}>最近汇报 · {markdownPreview(ticket.report)}</Text> : null}
      </Pressable>
      <View style={{ paddingHorizontal: space.sm, paddingVertical: space.xs, alignItems: "flex-start" }}>
        <Button theme={theme} label="详情与操作" size="xs" variant="ghost" onPress={onDetails} />
      </View>
    </View>
  );
}
