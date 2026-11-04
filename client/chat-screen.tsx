import { useEffect, useMemo, useState } from "react";
import { KeyboardAvoidingView, Pressable, Text, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { Icon, Loading, Modal, ScrollView, useToast } from "@getpaseo/plugin/client/ui";
import type { SuperagentSnapshot } from "../shared/model";
import { buildChatEntries } from "../shared/chat";
import { directTicket } from "../shared/execution";
import { markdownPreview, relativeTime, threadStatus } from "../shared/labels";
import { superagentDispatchRpc } from "../shared/rpc";
import { ChatComposer, type ComposerHint } from "./chat-composer";
import { CHAT_MAX_WIDTH, ChatMessages, type WorkingState } from "./chat-messages";
import { SIDEBAR_WIDTH, SidebarContent, SidebarTabs, type SidebarTab } from "./chat-sidebar";
import { STATE_QUERY_KEY, useSuperagentState } from "./query";
import { Button, Notice, StatusBadge, fontSize, radius, space, type Theme } from "./ui";

/**
 * 主界面:像在 Paseo 项目里和 agent 对话一样和 Superagent 对话。
 * 左侧是当前对话(一个线程)的消息流与输入框,右侧栏放 Router/Worker、对话列表与运行状态;
 * 窄屏时右侧栏收进弹层。
 */

export interface ChatScreenProps extends PluginScreenProps {
  openSettings(): void;
  /** 旧的历史/状态入口打开时默认显示的侧栏标签。 */
  defaultPanel?: SidebarTab;
}

/** 消息流与侧栏并排所需的最小宽度;更窄时侧栏改为弹层。 */
const DOCK_MIN_WIDTH = 800;
/** 快照里每类记录的上限(与 engine.snapshot 一致),达到时提示只显示了最近的记录。 */
const RECORD_LIMIT = 120;
const HEADER_HEIGHT = 44;

interface PendingMessage {
  text: string;
  threadId: string | null;
  triggerId: string | null;
}

function panelParam(value: string | undefined): SidebarTab | null {
  return value === "tasks" || value === "threads" || value === "status" ? value : null;
}

export function ChatScreen(props: ChatScreenProps) {
  const { theme, layout, host, params, navigation, openSettings } = props;
  const [threadId, setThreadId] = useState<string | null>(params.threadId || null);
  const requestedPanel = panelParam(params.panel) ?? props.defaultPanel ?? null;
  const [tab, setTab] = useState<SidebarTab>(requestedPanel ?? (params.threadId ? "tasks" : "threads"));
  const [width, setWidth] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sheetOpen, setSheetOpen] = useState(Boolean(requestedPanel) && layout.compact);
  const [pending, setPending] = useState<PendingMessage | null>(null);
  const docked = !layout.compact && width >= DOCK_MIN_WIDTH;

  useEffect(() => {
    if (params.threadId) setThreadId(params.threadId);
  }, [params.threadId]);

  const list = useSuperagentState(host.id, { includeClosed: true, omitRecords: true });
  const detail = useSuperagentState(host.id, threadId ? { includeClosed: true, threadId } : { includeClosed: true }, Boolean(threadId));
  const snapshot = list.data;
  const detailData = threadId ? detail.data : undefined;
  const thread = detailData?.threads.find((item) => item.id === threadId) ?? snapshot?.threads.find((item) => item.id === threadId);
  const tickets = useMemo(() => (detailData?.tickets ?? snapshot?.tickets ?? []).filter((ticket) => ticket.threadId === threadId),
    [detailData, snapshot, threadId]);
  const entries = useMemo(
    () => (detailData ? buildChatEntries(detailData.triggers, detailData.decisions, detailData.tickets) : []),
    [detailData],
  );
  const truncated = Boolean(detailData && (detailData.triggers.length >= RECORD_LIMIT || detailData.decisions.length >= RECORD_LIMIT));

  // 刚发出的消息先显示在末尾,快照里出现同一条触发后换成正式记录。
  const pendingText = pending && pending.threadId === threadId && !entries.some((entry) => entry.id === pending.triggerId)
    ? pending.text : null;
  useEffect(() => {
    if (pending?.triggerId && entries.some((entry) => entry.id === pending.triggerId)) setPending(null);
  }, [entries, pending]);

  const working = useMemo((): WorkingState | null => {
    const engine = (detailData ?? snapshot)?.engine;
    if (!thread || !engine) return null;
    const pendingSince = (detailData?.triggers ?? []).filter((trigger) => trigger.status === "pending")
      .map((trigger) => trigger.receivedAt).sort()[0] ?? null;
    if (engine.currentEvalThreadId === thread.id) return { label: "Router 正在评估", since: pendingSince };
    if (thread.pendingTriggers > 0) return { label: "等待 Router 评估", since: pendingSince };
    const active = tickets.filter((ticket) => ticket.status === "launching" || ticket.status === "running");
    if (!active.length) return null;
    const since = active.map((ticket) => ticket.startedAt).filter((value): value is string => Boolean(value)).sort()[0] ?? null;
    return { label: active.length === 1 ? `Worker 执行中 · ${active[0].title}` : `${active.length} 个 Worker 执行中`, since };
  }, [detailData, snapshot, thread, tickets]);

  const dispatch = useRpc(superagentDispatchRpc);
  const queryClient = useQueryClient();
  const toast = useToast();
  const submit = async (text: string): Promise<boolean> => {
    const target = threadId;
    setPending({ text, threadId: target, triggerId: null });
    try {
      const result = await dispatch({ task: text, ...(target ? { threadId: target } : {}) });
      setPending({ text, threadId: result.threadId, triggerId: result.triggerId });
      // 新对话发出后进入它;发送期间已切到别的对话就不打扰。
      if (!target) setThreadId((current) => (current === target ? result.threadId : current));
      void queryClient.invalidateQueries({ queryKey: STATE_QUERY_KEY });
      return true;
    } catch (error) {
      setPending(null);
      toast.error(`发送失败:${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };

  const selectThread = (id: string | null) => {
    setThreadId(id);
    setSheetOpen(false);
  };

  const direct = thread && thread.state !== "closed" ? directTicket(tickets) : null;
  let hint: ComposerHint = { icon: "Route", label: "交给 Router 评估" };
  if (!threadId) hint = { icon: "Sparkles", label: "新对话 · Router 评估后答复或派发 Worker" };
  else if (thread?.state === "closed") hint = { icon: "RotateCcw", label: "对话已关闭,发送后重新打开" };
  else if (direct) hint = { icon: "CornerDownRight", label: `直通 Worker · ${direct.title}` };
  let disabledReason: string | null = null;
  if (!threadId) {
    if (!snapshot) disabledReason = list.isError ? "状态不可用,请先重试" : "正在读取配置";
    else if (!snapshot.configured) disabledReason = "先在设置里填写工作目录";
    else if (snapshot.workingDirIssue) disabledReason = "工作目录不可用,Worker 暂时无法启动";
  }

  const activeQuery = threadId ? detail : list;
  const sidebarProps = {
    tab, onTab: setTab, snapshot, threadId, onSelectThread: selectThread, theme, hostId: host.id, navigation, openSettings,
  };
  const status = thread ? threadStatus(thread, tickets, thread.lastDecision ? [thread.lastDecision] : []) : null;
  const notFound = Boolean(threadId && detailData && !thread);

  return (
    <View style={{ flex: 1, flexDirection: "row", backgroundColor: theme.colors.surface0 }}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
      <KeyboardAvoidingView style={{ flex: 1, minWidth: 0 }} behavior={layout.platform === "ios" ? "padding" : undefined}>
        <View style={{ height: HEADER_HEIGHT, flexDirection: "row", alignItems: "center", gap: space.sm,
          paddingHorizontal: layout.compact ? space.md : space.lg, borderBottomWidth: 1, borderBottomColor: theme.colors.border }}>
          <Icon name={threadId ? "MessageSquare" : "SquarePen"} size={14} color={theme.colors.foregroundMuted} />
          <Text numberOfLines={1} style={{ flexShrink: 1, color: theme.colors.foreground, fontSize: fontSize.base, fontWeight: "500" }}>
            {thread?.title ?? (threadId ? "对话" : "新对话")}
          </Text>
          {status ? <StatusBadge theme={theme} {...status} /> : null}
          <View style={{ flex: 1 }} />
          {threadId ? (
            <Button theme={theme} variant="ghost" size="xs" icon="SquarePen" label={layout.compact ? undefined : "新对话"}
              accessibilityLabel="新对话" onPress={() => selectThread(null)} />
          ) : null}
          {docked ? (
            sidebarOpen ? null : (
              <Button theme={theme} variant="ghost" size="xs" icon="PanelRightOpen" accessibilityLabel="显示侧栏"
                onPress={() => setSidebarOpen(true)} />
            )
          ) : (
            <Button theme={theme} variant="ghost" size="xs" icon="PanelRight" accessibilityLabel="任务、对话与状态"
              onPress={() => setSheetOpen(true)} />
          )}
        </View>

        {activeQuery.isError ? (
          <View style={{ paddingHorizontal: space.lg, paddingTop: space.md, alignItems: "center" }}>
            <View style={{ width: "100%", maxWidth: CHAT_MAX_WIDTH }}>
              <Notice theme={theme} tone={activeQuery.data ? "warning" : "danger"}
                title={activeQuery.data ? "状态刷新失败,当前显示上一次的数据" : "无法读取 Superagent 状态"}
                description={activeQuery.error instanceof Error ? activeQuery.error.message : String(activeQuery.error)}>
                <Button theme={theme} label="重试" size="xs" variant="outline" onPress={() => void activeQuery.refetch()} />
              </Notice>
            </View>
          </View>
        ) : null}

        {threadId && !detailData && !pendingText && !detail.isError ? (
          <View style={{ flex: 1 }}><Loading /></View>
        ) : (
          <ChatMessages
            key={threadId ?? "new"}
            entries={entries}
            tickets={detailData?.tickets ?? []}
            pendingText={pendingText}
            working={working}
            truncated={truncated}
            theme={theme}
            navigation={navigation}
            compact={layout.compact}
            empty={notFound ? (
              <NotFound theme={theme} onNew={() => selectThread(null)} />
            ) : threadId ? null : (
              <Welcome snapshot={snapshot} theme={theme} openSettings={openSettings} onSelectThread={selectThread} />
            )}
          />
        )}

        <ChatComposer
          theme={theme}
          layout={layout}
          placeholder={threadId ? "继续对话…" : "描述要交给 Superagent 的任务…"}
          hint={hint}
          disabledReason={disabledReason}
          onSubmit={submit}
        />
      </KeyboardAvoidingView>

      {docked && sidebarOpen ? (
        <View style={{ width: SIDEBAR_WIDTH, borderLeftWidth: 1, borderLeftColor: theme.colors.border, backgroundColor: theme.colors.surface0 }}>
          <SidebarTabs tab={tab} onTab={setTab} theme={theme} trailing={
            <Button theme={theme} variant="ghost" size="xs" icon="PanelRightClose" accessibilityLabel="收起侧栏"
              onPress={() => setSidebarOpen(false)} />
          } />
          <ScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled">
            <SidebarContent {...sidebarProps} />
          </ScrollView>
        </View>
      ) : null}
      {!docked ? (
        <Modal title="Superagent" open={sheetOpen} onOpenChange={setSheetOpen}>
          <Modal.Content contentContainerStyle={{ padding: 0, gap: 0 }}>
            <SidebarTabs tab={tab} onTab={setTab} theme={theme} />
            <SidebarContent {...sidebarProps} />
          </Modal.Content>
        </Modal>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------- empty states

function Welcome({ snapshot, theme, openSettings, onSelectThread }: {
  snapshot: SuperagentSnapshot | undefined;
  theme: Theme;
  openSettings(): void;
  onSelectThread(threadId: string): void;
}) {
  const recent = (snapshot?.threads ?? []).filter((thread) => thread.state !== "closed").slice(0, 4);
  return (
    <View style={{ flex: 1, justifyContent: "center", gap: space.xl, paddingVertical: space.xl }}>
      <View style={{ alignItems: "center", gap: space.md }}>
        <View style={{ width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center",
          borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1 }}>
          <Icon name="Network" size={20} color={theme.colors.foregroundMuted} />
        </View>
        <Text style={{ color: theme.colors.foreground, fontSize: fontSize.stat, fontWeight: "500", textAlign: "center" }}>
          要交给 Superagent 做什么?
        </Text>
        <Text style={{ maxWidth: 480, color: theme.colors.foregroundMuted, fontSize: fontSize.base, lineHeight: 20, textAlign: "center" }}>
          Router 会评估你的消息,直接答复,或派发 Worker 执行。在任意 agent 会话里输入 /superagent 也能委派。
        </Text>
        {snapshot?.workingDir ? (
          <Text numberOfLines={1} ellipsizeMode="middle"
            style={{ width: "100%", maxWidth: 480, color: theme.colors.foregroundMuted, fontSize: fontSize.sm, textAlign: "center" }}>
            工作目录 · {snapshot.workingDir}
          </Text>
        ) : null}
      </View>
      {snapshot?.configured && snapshot.workingDirIssue ? (
        <Notice theme={theme} tone="danger" title="Worker 无法启动" description={snapshot.workingDirIssue}>
          <Button theme={theme} variant="outline" size="xs" label="打开设置" onPress={openSettings} />
        </Notice>
      ) : snapshot && !snapshot.configured ? (
        <Notice theme={theme} tone="warning" title="先设置工作目录,即可派发任务">
          <Button theme={theme} variant="outline" size="xs" label="打开设置" onPress={openSettings} />
        </Notice>
      ) : null}
      {recent.length ? (
        <View style={{ gap: space.sm }}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.sm, fontWeight: "500" }}>继续最近的对话</Text>
          {recent.map((thread) => (
            <RecentThread key={thread.id} thread={thread} snapshot={snapshot!} theme={theme} onPress={() => onSelectThread(thread.id)} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function RecentThread({ thread, snapshot, theme, onPress }: {
  thread: SuperagentSnapshot["threads"][number];
  snapshot: SuperagentSnapshot;
  theme: Theme;
  onPress(): void;
}) {
  const status = threadStatus(thread, snapshot.tickets.filter((ticket) => ticket.threadId === thread.id),
    thread.lastDecision ? [thread.lastDecision] : []);
  const preview = thread.latestResult ? markdownPreview(thread.latestResult.text).replace(/\s+/g, " ").trim() : thread.summary ?? "";
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${thread.title},${status.label}`} onPress={onPress}
      style={({ pressed }) => ({ gap: space.xs, padding: space.md, borderRadius: radius.lg, borderWidth: 1, borderColor: theme.colors.border,
        backgroundColor: pressed ? theme.colors.surface2 : theme.colors.surface1 })}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, color: theme.colors.foreground, fontSize: fontSize.base }}>{thread.title}</Text>
        <StatusBadge theme={theme} {...status} />
      </View>
      <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.sm }}>
        {relativeTime(thread.updatedAt)}{preview ? ` · ${preview}` : ""}
      </Text>
    </Pressable>
  );
}

function NotFound({ theme, onNew }: { theme: Theme; onNew(): void }) {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: space.md }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.base }}>找不到这段对话,它可能已被清理。</Text>
      <Button theme={theme} variant="outline" size="xs" icon="SquarePen" label="新对话" onPress={onNew} />
    </View>
  );
}
