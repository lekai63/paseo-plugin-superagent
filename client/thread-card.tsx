import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import type { Decision, SuperagentSnapshot, Ticket, Trigger } from "../shared/model";
import { SUBSCRIBED_STATUSES } from "../shared/model";
import { directTicket } from "../shared/execution";
import {
  ACTIVE_TICKET_STATUSES,
  outcomeLabel,
  outcomeTone,
  relativeTime,
  threadStatus,
  ticketStatusLabel,
  ticketStatusTone,
  triggerKindLabel,
  triggerSenderLabel,
  triggerStatusLabel,
  type Tone,
} from "../shared/labels";
import {
  superagentCancelTicketRpc,
  superagentCloseThreadRpc,
  superagentDispatchRpc,
  superagentForceEvalRpc,
  superagentRetryTicketRpc,
  superagentUnsubscribeRpc,
} from "../shared/rpc";
import { STATE_QUERY_KEY } from "./query";
import {
  Button,
  Card,
  ConfirmButton,
  Divider,
  ExpandableText,
  GroupLabel,
  StatusBadge,
  fontSize,
  radius,
  space,
  toneColor,
  type Theme,
} from "./ui";

type Navigation = { openAgent: (input: { agentId: string; serverId?: string }) => void } | undefined;
type ActionResult = { ok: boolean; error?: string | null };

interface ThreadCardProps {
  thread: SuperagentSnapshot["threads"][number];
  tickets: Ticket[];
  triggers: Trigger[];
  decisions: Decision[];
  theme: Theme;
  navigation?: Navigation;
  defaultExpanded?: boolean;
  focusTicketId?: string;
}

/** 活动时间线默认只显示最近几条,更早的折叠。 */
const RECENT_ACTIVITY = 6;

export function ThreadCard({
  thread,
  tickets,
  triggers,
  decisions,
  theme,
  navigation,
  defaultExpanded = false,
  focusTicketId,
}: ThreadCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [hovered, setHovered] = useState(false);

  const threadTickets = useMemo(() => tickets.filter((t) => t.threadId === thread.id)
    .sort((a, b) => Number(b.id === focusTicketId) - Number(a.id === focusTicketId)), [tickets, thread.id, focusTicketId]);
  const threadTriggers = useMemo(() => triggers.filter((t) => t.threadId === thread.id), [triggers, thread.id]);
  const threadDecisions = useMemo(() => decisions.filter((d) => d.threadId === thread.id), [decisions, thread.id]);
  const status = threadStatus(thread, threadTickets, threadDecisions);
  const closed = thread.state === "closed";

  const meta = [
    threadTickets.length > 0 ? `${threadTickets.length} 个 Ticket` : null,
    thread.pendingTriggers > 0 ? `${thread.pendingTriggers} 条待评估` : null,
    `更新于 ${relativeTime(thread.updatedAt)}`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Card theme={theme}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`${thread.title},${status.label}`}
        onPress={() => setExpanded((value) => !value)}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: space.md,
          paddingHorizontal: space.lg,
          paddingVertical: space.md + 2,
          backgroundColor: pressed || hovered ? theme.colors.surface2 : "transparent",
        })}
      >
        <View style={{ flex: 1, minWidth: 0, gap: space.xs }}>
          <Text style={{ color: theme.colors.foreground, fontSize: fontSize.base }} numberOfLines={1}>
            {thread.title}
          </Text>
          {thread.summary ? (
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.sm, lineHeight: 18 }} numberOfLines={2}>
              {thread.summary}
            </Text>
          ) : null}
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.sm }} numberOfLines={1}>
            {meta}
          </Text>
        </View>
        <StatusBadge theme={theme} label={status.label} tone={status.tone} />
        <Icon name={expanded ? "ChevronDown" : "ChevronRight"} size={16} color={theme.colors.foregroundMuted} />
      </Pressable>

      {expanded ? (
        <ThreadDetail
          thread={thread}
          closed={closed}
          tickets={threadTickets}
          triggers={threadTriggers}
          decisions={threadDecisions}
          theme={theme}
          navigation={navigation}
        />
      ) : null}
    </Card>
  );
}

function ThreadDetail({
  thread,
  closed,
  tickets,
  triggers,
  decisions,
  theme,
  navigation,
}: {
  thread: ThreadCardProps["thread"];
  closed: boolean;
  tickets: Ticket[];
  triggers: Trigger[];
  decisions: Decision[];
  theme: Theme;
  navigation?: Navigation;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const forceEval = useRpc(superagentForceEvalRpc);
  const cancelTicket = useRpc(superagentCancelTicketRpc);
  const retryTicket = useRpc(superagentRetryTicketRpc);
  const closeThread = useRpc(superagentCloseThreadRpc);
  const unsubscribe = useRpc(superagentUnsubscribeRpc);

  const runAction = useCallback(
    async (successLabel: string, action: () => Promise<ActionResult>) => {
      try {
        const result = await action();
        void queryClient.invalidateQueries({ queryKey: STATE_QUERY_KEY });
        if (result.ok) toast.show(successLabel, { variant: "success" });
        else toast.error(result.error ?? "操作失败");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      }
    },
    [queryClient, toast],
  );

  // 恰好一个可直通的订阅 Worker 时,追加消息直接送达;与引擎共用判断。
  const directTarget = directTicket(tickets);

  return (
    <>
      <Divider theme={theme} />
      <View style={{ padding: space.lg, gap: space.xl }}>
        {tickets.length > 0 ? (
          <View style={{ gap: space.sm }}>
            <GroupLabel theme={theme}>Ticket</GroupLabel>
            <View style={{ borderWidth: 1, borderColor: theme.colors.border, borderRadius: radius.md, overflow: "hidden" }}>
              {tickets.map((ticket, index) => (
                <View key={ticket.id} style={index > 0 ? { borderTopWidth: 1, borderTopColor: theme.colors.border } : undefined}>
                  <TicketRow
                    ticket={ticket}
                    readOnly={closed}
                    theme={theme}
                    navigation={navigation}
                    onCancel={() => runAction("已取消 Ticket", () => cancelTicket({ ticketId: ticket.id }))}
                    onRetry={() => runAction("已重新派发", () => retryTicket({ ticketId: ticket.id }))}
                    onUnsubscribe={() =>
                      runAction(
                        ticket.status === "waiting" ? "已标记完成" : "已取消直通,后续消息交给 Router",
                        () => unsubscribe({ threadId: thread.id, ticketId: ticket.id }),
                      )
                    }
                  />
                </View>
              ))}
            </View>
          </View>
        ) : null}

        <ActivityTimeline triggers={triggers} decisions={decisions} tickets={tickets} theme={theme} />

        {closed ? null : (
          <View style={{ gap: space.md }}>
            <FollowUpInput
              threadId={thread.id}
              theme={theme}
              placeholder={
                directTarget
                  ? `追加消息,将直接发给 Worker(${directTarget.title})`
                  : "追加消息,交给 Router 评估"
              }
            />
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: space.sm }}>
              <Button
                theme={theme}
                variant="outline"
                size="xs"
                icon="RotateCcw"
                label="重新评估"
                onPress={() => runAction("已请求 Router 重新评估", () => forceEval({ threadId: thread.id }))}
              />
              <ConfirmButton
                theme={theme}
                size="xs"
                icon="X"
                label="关闭线程"
                confirmLabel="确认关闭(会取消进行中的 Worker)"
                onConfirm={() => runAction("线程已关闭", () => closeThread({ threadId: thread.id }))}
              />
            </View>
          </View>
        )}
      </View>
    </>
  );
}

// ---------------------------------------------------------------- Tickets

function TicketRow({
  ticket,
  readOnly,
  theme,
  navigation,
  onCancel,
  onRetry,
  onUnsubscribe,
}: {
  ticket: Ticket;
  readOnly: boolean;
  theme: Theme;
  navigation?: Navigation;
  onCancel(): void;
  onRetry(): void;
  onUnsubscribe(): void;
}) {
  const terminal = ["completed", "failed", "canceled"].includes(ticket.status);
  const direct = ticket.subscribed && SUBSCRIBED_STATUSES.includes(ticket.status);
  const active = ACTIVE_TICKET_STATUSES.includes(ticket.status);
  const meta = [
    ticket.profile ? `档位 ${ticket.profile}` : null,
    ticket.provider ?? null,
    ticket.workerAgentId ? `Worker ${ticket.workerAgentId.slice(0, 8)}` : null,
    ticket.branchName ? `分支 ${ticket.branchName}` : null,
    active && ticket.startedAt ? `${relativeTime(ticket.startedAt)}启动` : `更新于 ${relativeTime(ticket.updatedAt)}`,
    ticket.attempts > 1 ? `第 ${ticket.attempts} 次尝试` : null,
    direct ? "后续消息直通此 Worker" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <View style={{ padding: space.md, gap: space.sm }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <StatusBadge theme={theme} label={ticketStatusLabel(ticket.status)} tone={ticketStatusTone(ticket.status)} />
        <Text style={{ flex: 1, minWidth: 0, color: theme.colors.foreground, fontSize: fontSize.base }} numberOfLines={1}>
          {ticket.title}
        </Text>
      </View>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.sm }} numberOfLines={2}>
        {meta}
      </Text>

      {ticket.lastError ? (
        <View style={{ flexDirection: "row", gap: space.sm }}>
          <View style={{ paddingTop: 3 }}>
            <Icon name="CircleAlert" size={14} color={theme.colors.statusDanger} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <ExpandableText theme={theme} text={ticket.lastError} lines={2} color={theme.colors.statusDanger} />
          </View>
        </View>
      ) : null}

      {ticket.report ? (
        <View style={{ gap: space.xs }}>
          <GroupLabel theme={theme}>Worker 原始汇报</GroupLabel>
          <ExpandableText theme={theme} text={ticket.report} lines={4} markdown />
        </View>
      ) : null}

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
        {ticket.workerAgentId && navigation ? (
          <Button
            theme={theme}
            variant="outline"
            size="xs"
            icon="ArrowUpRight"
            label="打开 Worker 会话"
            onPress={() => navigation.openAgent({ agentId: ticket.workerAgentId! })}
          />
        ) : null}
        {direct && !readOnly ? (
          <Button
            theme={theme}
            variant="ghost"
            size="xs"
            label={ticket.status === "waiting" ? "标记完成" : "取消直通"}
            onPress={onUnsubscribe}
          />
        ) : null}
        {terminal && !readOnly ? <Button theme={theme} variant="ghost" size="xs" icon="RotateCcw" label="重试" onPress={onRetry} /> : null}
        {terminal || readOnly ? null : (
          <ConfirmButton theme={theme} size="xs" label="取消" confirmLabel="确认取消 Ticket" onConfirm={onCancel} />
        )}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------- Activity

interface ActivityEntry {
  id: string;
  at: string;
  icon: string;
  iconTone: Tone;
  title: string;
  titleTone: Tone;
  subtitle: string;
  text: string;
  markdown: boolean;
}

function triggerIcon(kind: Trigger["kind"]): string {
  switch (kind) {
    case "manual":
      return "User";
    case "agent":
      return "Bot";
    case "report":
      return "FileCheck";
    case "engine":
      return "Cog";
    default:
      return "MessageCircle";
  }
}

function buildActivity(triggers: Trigger[], decisions: Decision[], tickets: Ticket[]): ActivityEntry[] {
  const entries: ActivityEntry[] = [];
  for (const trigger of triggers) {
    let iconTone: Tone = "muted";
    if (trigger.status === "failed") iconTone = "danger";
    else if (trigger.status === "pending") iconTone = "warning";
    entries.push({
      id: trigger.id,
      at: trigger.receivedAt,
      icon: triggerIcon(trigger.kind),
      iconTone,
      title: triggerKindLabel(trigger.kind),
      titleTone: "default",
      subtitle: [triggerSenderLabel(trigger), triggerStatusLabel(trigger.status), trigger.note]
        .filter(Boolean)
        .join(" · "),
      text: trigger.text,
      markdown: trigger.kind === "report",
    });
  }
  for (const decision of decisions) {
    const tone = outcomeTone(decision.outcome);
    const ticket = decision.ticketId ? tickets.find((t) => t.id === decision.ticketId) : undefined;
    entries.push({
      id: decision.id,
      at: decision.createdAt,
      icon: "Route",
      iconTone: tone === "default" ? "muted" : tone,
      title: `Router ${outcomeLabel(decision.outcome)}`,
      titleTone: tone,
      subtitle: ticket ? `→ ${ticket.title}${decision.outcome === "dispatch" && ticket.profile ? ` · 档位 ${ticket.profile}` : ""}` : "",
      text: decision.reply ?? decision.rationale ?? decision.raw ?? "",
      markdown: Boolean(decision.reply),
    });
  }
  // 时间正序:最新的一条紧挨着下方的追加输入框,读起来像对话。
  return entries.sort((a, b) => a.at.localeCompare(b.at));
}

function ActivityTimeline({
  triggers,
  decisions,
  tickets,
  theme,
}: {
  triggers: Trigger[];
  decisions: Decision[];
  tickets: Ticket[];
  theme: Theme;
}) {
  const [showAll, setShowAll] = useState(false);
  const entries = useMemo(() => buildActivity(triggers, decisions, tickets), [triggers, decisions, tickets]);
  if (entries.length === 0) return null;
  const hidden = showAll ? 0 : Math.max(0, entries.length - RECENT_ACTIVITY);
  const visible = entries.slice(hidden);

  return (
    <View style={{ gap: space.sm }}>
      <GroupLabel
        theme={theme}
        trailing={
          entries.length > RECENT_ACTIVITY ? (
            <Text
              accessibilityRole="button"
              onPress={() => setShowAll((value) => !value)}
              style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.sm }}
            >
              {showAll ? "只看最近" : `显示更早的 ${hidden} 条`}
            </Text>
          ) : null
        }
      >
        活动
      </GroupLabel>
      <View>
        {visible.map((entry, index) => (
          <ActivityRow key={entry.id} entry={entry} last={index === visible.length - 1} theme={theme} />
        ))}
      </View>
    </View>
  );
}

function ActivityRow({ entry, last, theme }: { entry: ActivityEntry; last: boolean; theme: Theme }) {
  return (
    <View style={{ flexDirection: "row", gap: space.md }}>
      {/* 左侧图标 + 竖线串起时间线 */}
      <View style={{ width: 16, alignItems: "center" }}>
        <View style={{ paddingTop: 1 }}>
          <Icon name={entry.icon} size={14} color={toneColor(entry.iconTone, theme)} />
        </View>
        {last ? null : <View style={{ flex: 1, width: 1, marginTop: space.xs, backgroundColor: theme.colors.border }} />}
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2, paddingBottom: last ? 0 : space.lg }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <Text style={{ color: toneColor(entry.titleTone, theme), fontSize: fontSize.sm, fontWeight: "500" }} numberOfLines={1}>
            {entry.title}
          </Text>
          <Text style={{ flex: 1, minWidth: 0, color: theme.colors.foregroundMuted, fontSize: fontSize.sm }} numberOfLines={1}>
            {entry.subtitle}
          </Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.sm }}>{relativeTime(entry.at)}</Text>
        </View>
        {entry.text.trim() ? (
          <ExpandableText theme={theme} text={entry.text} lines={2} markdown={entry.markdown} />
        ) : null}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------- Follow-up

function FollowUpInput({ threadId, theme, placeholder }: { threadId: string; theme: Theme; placeholder: string }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const dispatch = useRpc(superagentDispatchRpc);
  const queryClient = useQueryClient();
  const toast = useToast();

  const send = useCallback(async () => {
    const task = text.trim();
    if (!task || sending) return;
    setSending(true);
    try {
      const result = await dispatch({ task, threadId });
      setText("");
      void queryClient.invalidateQueries({ queryKey: STATE_QUERY_KEY });
      toast.show(result.directDelivered ? "已直接发给 Worker" : "已排队,等待 Router 评估", {
        variant: result.directDelivered ? "success" : "info",
      });
    } catch (error) {
      toast.error(`发送失败:${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSending(false);
    }
  }, [dispatch, queryClient, sending, text, threadId, toast]);

  // 输入框与发送按钮装在同一个边框里,读作一个整体的"回复框"。
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "flex-end",
        gap: space.sm,
        padding: space.xs,
        paddingLeft: space.md,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: radius.lg,
        backgroundColor: theme.colors.surface0,
      }}
    >
      <TextInput
        value={text}
        onChangeText={setText}
        placeholder={placeholder}
        placeholderTextColor={theme.colors.foregroundMuted}
        accessibilityLabel="追加消息"
        editable={!sending}
        multiline
        style={{
          flex: 1,
          minHeight: 32,
          maxHeight: 160,
          paddingVertical: space.xs + 2,
          color: theme.colors.foreground,
          fontSize: fontSize.base,
          lineHeight: 20,
        }}
      />
      <Button
        theme={theme}
        variant={text.trim() ? "secondary" : "ghost"}
        icon="SendHorizontal"
        accessibilityLabel="发送"
        disabled={!text.trim() || sending}
        onPress={() => void send()}
      />
    </View>
  );
}
