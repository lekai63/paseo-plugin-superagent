import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { PluginHostProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import type { Decision, Ticket, Thread, Trigger, SuperagentSnapshot } from "../shared/model";
import { truncate } from "../shared/model";
import {
  outcomeLabel,
  ticketStatusLabel,
  ticketStatusTone,
  triggerStatusLabel,
} from "../shared/labels";
import {
  superagentCancelTicketRpc,
  superagentCloseThreadRpc,
  superagentDispatchRpc,
  superagentForceEvalRpc,
  superagentRetryTicketRpc,
  superagentUnsubscribeRpc,
} from "../shared/rpc";

interface ThreadCardProps extends PluginHostProps {
  thread: SuperagentSnapshot["threads"][number];
  tickets: Ticket[];
  triggers: Trigger[];
  decisions: Decision[];
  navigation?: {
    openAgent: (input: { agentId: string; serverId?: string }) => void;
  };
}

function toneColor(tone: "success" | "danger" | "warning" | "muted", theme: PluginHostProps["theme"]): string {
  switch (tone) {
    case "success":
      return theme.colors.statusSuccess;
    case "danger":
      return theme.colors.statusDanger;
    case "warning":
      return theme.colors.statusWarning;
    default:
      return theme.colors.foregroundMuted;
  }
}

export function ThreadCard({ thread, tickets, triggers, decisions, theme, layout, navigation }: ThreadCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [followUp, setFollowUp] = useState("");
  const toast = useToast();
  const queryClient = useQueryClient();
  const dispatch = useRpc(superagentDispatchRpc);
  const forceEval = useRpc(superagentForceEvalRpc);
  const cancelTicket = useRpc(superagentCancelTicketRpc);
  const retryTicket = useRpc(superagentRetryTicketRpc);
  const closeThread = useRpc(superagentCloseThreadRpc);
  const unsubscribe = useRpc(superagentUnsubscribeRpc);

  const threadTickets = useMemo(
    () => tickets.filter((t) => t.threadId === thread.id),
    [tickets, thread.id],
  );
  const threadTriggers = useMemo(
    () => triggers.filter((t) => t.threadId === thread.id).slice(0, 8),
    [triggers, thread.id],
  );
  const threadDecisions = useMemo(
    () => decisions.filter((d) => d.threadId === thread.id).slice(0, 6),
    [decisions, thread.id],
  );
  const running = threadTickets.filter((t) => ["launching", "running"].includes(t.status));
  const gap = layout.compact ? 8 : 12;

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["superagent", "state"] });
  }, [queryClient]);

  const sendFollowUp = useCallback(async () => {
    const text = followUp.trim();
    if (!text) return;
    try {
      const result = await dispatch({ task: text, threadId: thread.id });
      setFollowUp("");
      invalidate();
      toast.show(result.directDelivered ? "已直通订阅的 Worker" : "已排队,等待 Router 评估", {
        variant: result.directDelivered ? "success" : "info",
      });
    } catch (error) {
      toast.error(`派发失败:${error instanceof Error ? error.message : String(error)}`);
    }
  }, [dispatch, followUp, invalidate, thread.id, toast]);

  const runAction = useCallback(
    async (label: string, action: () => Promise<{ ok: boolean; error?: string | null }>) => {
      try {
        const result = await action();
        invalidate();
        if (result.ok) {
          toast.show(label, { variant: "success" });
        } else {
          toast.error(result.error ?? "操作失败");
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      }
    },
    [invalidate, toast],
  );

  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: theme.colors.foregroundMuted + "44",
        borderRadius: 10,
        padding: gap,
        gap: 8,
      }}
    >
      <Pressable onPress={() => setExpanded((value) => !value)} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Icon name={expanded ? "ChevronDown" : "ChevronRight"} size={16} color={theme.colors.foregroundMuted} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ color: theme.colors.foreground, fontWeight: "600" }} numberOfLines={1}>
            {thread.title}
          </Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }} numberOfLines={1}>
            {thread.pendingTriggers > 0 ? `待评估 ${thread.pendingTriggers} · ` : ""}
            {running.length > 0 ? `运行中 ${running.length} · ` : ""}
            {new Date(thread.updatedAt).toLocaleString()}
          </Text>
        </View>
        {thread.state === "closed" && (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>已关闭</Text>
        )}
      </Pressable>

      {expanded && (
        <View style={{ gap }}>
          {threadTickets.length > 0 && (
            <View style={{ gap: 6 }}>
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600" }}>TICKETS</Text>
              {threadTickets.map((ticket) => (
                <TicketRow
                  key={ticket.id}
                  ticket={ticket}
                  theme={theme}
                  navigation={navigation}
                  onCancel={() =>
                    runAction("已取消", () => cancelTicket({ ticketId: ticket.id }))
                  }
                  onRetry={() => runAction("已重试", () => retryTicket({ ticketId: ticket.id }))}
                  onUnsubscribe={() =>
                    runAction("已退订", () => unsubscribe({ threadId: thread.id, ticketId: ticket.id }))
                  }
                />
              ))}
            </View>
          )}

          {threadDecisions.length > 0 && (
            <View style={{ gap: 4 }}>
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600" }}>ROUTER 裁决</Text>
              {threadDecisions.map((decision) => (
                <View key={decision.id} style={{ gap: 2 }}>
                  <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>
                    [{outcomeLabel(decision.outcome)}]{" "}
                    {(decision.reply ?? decision.rationale ?? truncate(decision.raw ?? "", 120)) || "-"}
                  </Text>
                </View>
              ))}
            </View>
          )}

          {threadTriggers.length > 0 && (
            <View style={{ gap: 4 }}>
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600" }}>触发事件</Text>
              {threadTriggers.map((trigger) => (
                <Text key={trigger.id} style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
                  [{triggerStatusLabel(trigger.status)} {trigger.kind}] {trigger.sender}: {truncate(trigger.text, 100)}
                </Text>
              ))}
            </View>
          )}

          <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
            <ActionChip label="立即评估" theme={theme} onPress={() => runAction("已触发评估", () => forceEval({ threadId: thread.id }))} />
            <ActionChip
              label="关闭线程"
              theme={theme}
              danger
              onPress={() => runAction("已关闭", () => closeThread({ threadId: thread.id }))}
            />
          </View>

          <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
            <TextInput
              value={followUp}
              onChangeText={setFollowUp}
              placeholder="追加消息(直通订阅的 Worker 或交给 Router)…"
              placeholderTextColor={theme.colors.foregroundMuted}
              multiline
              style={{ flex: 1, minHeight: 36, color: theme.colors.foreground }}
            />
            <ActionChip label="发送" theme={theme} onPress={() => void sendFollowUp()} />
          </View>
        </View>
      )}
    </View>
  );
}

interface TicketRowProps {
  ticket: Ticket;
  theme: PluginHostProps["theme"];
  navigation?: { openAgent: (input: { agentId: string; serverId?: string }) => void };
  onCancel(): void;
  onRetry(): void;
  onUnsubscribe(): void;
}

function TicketRow({ ticket, theme, navigation, onCancel, onRetry, onUnsubscribe }: TicketRowProps) {
  const tone = ticketStatusTone(ticket.status);
  const terminal = ["completed", "failed", "canceled"].includes(ticket.status);
  return (
    <View style={{ borderWidth: 1, borderColor: theme.colors.foregroundMuted + "33", borderRadius: 8, padding: 8, gap: 4 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={{ color: toneColor(tone, theme), fontSize: 12, fontWeight: "600" }}>
          {ticketStatusLabel(ticket.status)}
        </Text>
        <Text style={{ color: theme.colors.foreground, flex: 1 }} numberOfLines={1}>
          {ticket.title}
        </Text>
        {ticket.attempts > 1 && (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>×{ticket.attempts}</Text>
        )}
      </View>
      {ticket.workerAgentId && (
        <Pressable
          onPress={() => navigation?.openAgent({ agentId: ticket.workerAgentId! })}
          disabled={!navigation}
        >
          <Text style={{ color: navigation ? theme.colors.statusWarning : theme.colors.foregroundMuted, fontSize: 12 }}>
            Worker: {ticket.workerAgentId.slice(0, 16)}…{navigation ? "(打开)" : ""}
          </Text>
        </Pressable>
      )}
      {ticket.report && (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
          汇报:{truncate(ticket.report, 160)}
        </Text>
      )}
      {ticket.lastError && (
        <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>
          错误:{truncate(ticket.lastError, 160)}
        </Text>
      )}
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
        {!terminal && <ActionChip label="取消" theme={theme} danger onPress={onCancel} />}
        {terminal && <ActionChip label="重试" theme={theme} onPress={onRetry} />}
        {ticket.subscribed && !terminal && <ActionChip label="退订直通" theme={theme} onPress={onUnsubscribe} />}
      </View>
    </View>
  );
}

export function ActionChip({
  label,
  theme,
  onPress,
  danger,
}: {
  label: string;
  theme: PluginHostProps["theme"];
  onPress(): void;
  danger?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => ({
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: (danger ? theme.colors.statusDanger : theme.colors.foregroundMuted) + (pressed ? "" : "66"),
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Text style={{ color: danger ? theme.colors.statusDanger : theme.colors.foreground, fontSize: 12 }}>
        {label}
      </Text>
    </Pressable>
  );
}
