import { Pressable, Text, View } from "react-native";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { Markdown, SettingsSection } from "@getpaseo/plugin/client/ui";
import { markdownPreview, relativeTime, threadStatus } from "../shared/labels";
import { useSuperagentState } from "./query";
import { ScreenLayout, StateFeedback } from "./screen-layout";
import { ThreadCard } from "./thread-card";
import { Button, Card, GroupLabel, StatusBadge, fontSize, space } from "./ui";

export function HistoryScreen(props: PluginScreenProps & {
  openMain(): void;
  openHistory(input?: { threadId?: string; ticketId?: string }): void;
}) {
  const { theme, params, navigation } = props;
  const query = useSuperagentState(props.host.id, { includeClosed: true, threadId: params.threadId });
  const snapshot = query.data;
  const result = params.threadId ? snapshot?.threads[0]?.latestResult : null;
  const hasOriginalReport = result?.ticketIds.some((id) => snapshot?.tickets.some((ticket) => ticket.id === id && ticket.report));
  return (
    <ScreenLayout {...props}>
      <View style={{ gap: space.lg }}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
          <Button theme={theme} variant="ghost" icon="ArrowLeft" label="返回主界面" onPress={props.openMain} />
          {params.threadId ? <Button theme={theme} variant="outline" icon="History" label="全部历史" onPress={() => props.openHistory()} /> : null}
        </View>
        <StateFeedback query={query} theme={theme} />
        {result ? <Card theme={theme} style={{ padding: space.lg, gap: space.md }}>
          <GroupLabel theme={theme}>{result.kind === "router_reply" ? "Router 答复" : "Worker 汇报"}</GroupLabel>
          {result.kind === "worker_report" && hasOriginalReport
            ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.base }}>Worker 原始汇报已保存，见下方对应任务。Router 尚无新的答复。</Text>
            : <Markdown>{result.text}</Markdown>}
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.sm }}>{relativeTime(result.createdAt)} · 答复与汇报随线程保存</Text>
        </Card> : null}
        {snapshot ? <SettingsSection title={params.threadId ? "线程消息与任务" : `历史消息 · ${snapshot.threads.length} 个线程`}>
          {snapshot.threads.length === 0 ? <Card theme={theme} style={{ padding: space.lg }}>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.base }}>
              {params.threadId ? "没有找到这条线程" : "还没有消息记录，返回主界面派发第一个任务"}
            </Text>
          </Card> : snapshot.threads.map((thread) => {
            if (params.threadId) return <ThreadCard
              key={`${thread.id}:${params.ticketId ?? "thread"}`} thread={thread} tickets={snapshot.tickets}
              triggers={snapshot.triggers} decisions={snapshot.decisions} theme={theme} navigation={navigation}
              defaultExpanded focusTicketId={params.ticketId}
            />;
            const tickets = snapshot.tickets.filter((ticket) => ticket.threadId === thread.id);
            const status = threadStatus(thread, tickets, snapshot.decisions.filter((decision) => decision.threadId === thread.id));
            return <Card key={thread.id} theme={theme}>
              <Pressable accessibilityRole="button" accessibilityLabel={`${thread.title},${status.label}`}
                onPress={() => props.openHistory({ threadId: thread.id })}
                style={({ pressed }) => ({ padding: space.lg, flexDirection: "row", alignItems: "center", gap: space.sm,
                  backgroundColor: pressed ? theme.colors.surface2 : "transparent" })}>
                <View style={{ flex: 1, minWidth: 0, gap: space.xs }}>
                  <Text numberOfLines={2} style={{ color: theme.colors.foreground, fontSize: fontSize.base }}>{thread.title}</Text>
                  <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.sm }}>{tickets.length} 个任务 · {relativeTime(thread.updatedAt)}</Text>
                  {thread.latestResult ? <Text numberOfLines={2} style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.sm, lineHeight: 18 }}>
                    {thread.latestResult.kind === "router_reply" ? "Router 答复" : "Worker 汇报"} · {markdownPreview(thread.latestResult.text).replace(/\s+/g, " ").trim()}
                  </Text> : null}
                </View>
                <StatusBadge theme={theme} {...status} />
              </Pressable>
            </Card>;
          })}
        </SettingsSection> : null}
      </View>
    </ScreenLayout>
  );
}
