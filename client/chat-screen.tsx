import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { KeyboardAvoidingView, Pressable, Text, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { Icon, Loading, Modal, ScrollView, useToast } from "@getpaseo/plugin/client/ui";
import type { SuperagentSnapshot } from "../shared/model";
import { buildChatEntries } from "../shared/chat";
import { closeChatTab, entryChatTab, openChatTab } from "../shared/chat-tabs";
import { directTickets, followsOf } from "../shared/execution";
import { TYPE } from "../shared/design";
import { markdownPreview, relativeTime, threadStatus } from "../shared/labels";
import { superagentDispatchRpc } from "../shared/rpc";
import { ChatComposer, type ComposerHint } from "./chat-composer";
import { ChatTabBar } from "./chat-tab-bar";
import { useChatTabs } from "./chat-tabs-store";
import { ChatMessages, useChatMetrics, type WorkingState } from "./chat-messages";
import { SIDEBAR_WIDTH, SidebarContent, SidebarTabs, type SidebarTab } from "./chat-sidebar";
import { STATE_QUERY_KEY, useSuperagentState } from "./query";
import { HAIRLINE, WEB_TRANSITION, chatTokens, radius, space, type Theme } from "./theme-tokens";
import { Button, Notice, StatusBadge, cardSurface } from "./ui";
import { useT } from "./i18n";

/**
 * 主界面:像在 Paseo 项目里和 agent 对话一样和 Superagent 对话。
 * 左侧是当前对话(一个线程)的消息流与输入框,右侧栏放 Router/Worker、对话列表与运行状态;
 * 窄屏时右侧栏收进弹层。同时进行的多段对话以顶部标签切换;不带线程打开页面时
 * 直接回到最后查看的对话,没有打开着的对话才显示新对话。
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
  const t = useT();
  const list = useSuperagentState(host.id, { includeClosed: true, omitRecords: true });
  const { tabs, update: updateTabs } = useChatTabs(host.id, list.data?.chatTabs, Boolean(list.data), list.isError);
  // undefined:标签还没读到,稍后进入最后查看的对话;null:新对话。
  const [selected, setSelected] = useState<string | null | undefined>(() => params.threadId || (tabs ? entryChatTab(tabs) : undefined));
  const threadId = selected ?? null;
  // 关闭对话的 RPC 返回时可能已切到别的对话:关标签时按那时的当前对话决定接下来显示哪段。
  const threadIdRef = useRef(threadId);
  threadIdRef.current = threadId;
  const deciding = selected === undefined;
  const requestedPanel = panelParam(params.panel) ?? props.defaultPanel ?? null;
  const [tab, setTab] = useState<SidebarTab>(requestedPanel ?? (selected ? "tasks" : "threads"));
  const [width, setWidth] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sheetOpen, setSheetOpen] = useState(Boolean(requestedPanel) && layout.compact);
  const [pending, setPending] = useState<PendingMessage | null>(null);
  const docked = !layout.compact && width >= DOCK_MIN_WIDTH;
  const metrics = useChatMetrics(theme, layout);

  // 键盘避让要以窗口为参照:KeyboardAvoidingView 只知道自己在父容器里的位置,而宿主把
  // 插件放在自己的页头之下,不补上这段距离(页头 + 安全区)避让高度就会少算一截。
  const rootRef = useRef<View>(null);
  const [keyboardOffset, setKeyboardOffset] = useState(0);
  const measureOffset = useCallback(() => {
    rootRef.current?.measureInWindow((_x, y) => {
      setKeyboardOffset((current) => (y >= 0 && current !== y ? y : current));
    });
  }, []);
  useEffect(() => {
    measureOffset();
  }, [measureOffset]);

  useEffect(() => {
    if (params.threadId) setSelected(params.threadId);
  }, [params.threadId]);
  useEffect(() => {
    if (selected !== undefined || !tabs) return;
    const entry = entryChatTab(tabs);
    setSelected(entry);
    if (!requestedPanel) setTab(entry ? "tasks" : "threads");
  }, [selected, tabs, requestedPanel]);
  // 当前对话加入标签栏,并记为最后查看:离开页面再回来、或重启 app 后回到这里。
  const tabsReady = tabs !== null;
  useEffect(() => {
    if (tabsReady && selected) updateTabs((current) => openChatTab(current, selected));
  }, [tabsReady, selected, updateTabs]);

  const detail = useSuperagentState(host.id, threadId ? { includeClosed: true, threadId } : { includeClosed: true }, Boolean(threadId));
  const snapshot = list.data;
  const detailData = threadId ? detail.data : undefined;
  const thread = detailData?.threads.find((item) => item.id === threadId) ?? snapshot?.threads.find((item) => item.id === threadId);
  const tickets = useMemo(() => (detailData?.tickets ?? snapshot?.tickets ?? [])
    .filter((ticket) => ticket.threadId === threadId || (threadId !== null && followsOf(ticket).includes(threadId))),
    [detailData, snapshot, threadId]);
  const entries = useMemo(
    () => (detailData ? buildChatEntries(detailData.triggers, detailData.decisions, detailData.tickets, t) : []),
    [detailData, t],
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
    if (engine.currentEvalThreadId === thread.id) return { label: t("chat.working.evaluating"), since: pendingSince };
    if (thread.pendingTriggers > 0) return { label: t("chat.working.awaiting"), since: pendingSince };
    const active = tickets.filter((ticket) => ticket.status === "launching" || ticket.status === "running");
    if (!active.length) return null;
    const since = active.map((ticket) => ticket.startedAt).filter((value): value is string => Boolean(value)).sort()[0] ?? null;
    return { label: active.length === 1 ? t("chat.working.workerRunning", { title: active[0].title }) : t("chat.working.workersRunning", { count: active.length }), since };
  }, [detailData, snapshot, thread, tickets, t]);

  const dispatch = useRpc(superagentDispatchRpc);
  const queryClient = useQueryClient();
  const toast = useToast();
  const submit = async (text: string): Promise<boolean> => {
    const target = threadId;
    setPending({ text, threadId: target, triggerId: null });
    try {
      const result = await dispatch({ task: text, ...(target ? { threadId: target } : {}) });
      setPending({ text, threadId: result.threadId, triggerId: result.triggerId });
      // 新对话发出后成为标签并进入它;发送期间已切到别的对话就只加标签,不打扰。
      if (!target) {
        updateTabs((current) => openChatTab(current, result.threadId, false));
        setSelected((current) => (current === null ? result.threadId : current));
      }
      void queryClient.invalidateQueries({ queryKey: STATE_QUERY_KEY });
      return true;
    } catch (error) {
      setPending(null);
      toast.error(t("chat.sendFailed", { error: error instanceof Error ? error.message : String(error) }));
      return false;
    }
  };

  const selectThread = (id: string | null) => {
    setSelected(id);
    setSheetOpen(false);
  };
  /**
   * 关闭标签(本身不关闭对话;在侧栏手动关闭对话成功后也调用它):关的是当前标签就切到相邻标签,
   * 没有标签时回到新对话。
   */
  const closeTab = (id: string | null) => {
    if (id === null) {
      setSelected(tabs ? entryChatTab(tabs) : null);
      return;
    }
    const active = threadIdRef.current;
    let next: string | null = active;
    updateTabs((current) => {
      const result = closeChatTab(current, id, active);
      next = result.next;
      return result.tabs;
    });
    setSelected(next);
  };

  const directs = thread && thread.state !== "closed" ? directTickets(tickets, thread.id) : [];
  let hint: ComposerHint = { icon: "Route", label: t("chat.hint.router") };
  if (!threadId) hint = { icon: "Sparkles", label: t("chat.hint.newConversation") };
  else if (thread?.state === "closed") hint = { icon: "RotateCcw", label: t("chat.hint.closed") };
  else if (directs.length === 1) hint = { icon: "CornerDownRight", label: t("chat.hint.direct", { title: directs[0].title }) };
  else if (directs.length > 1) hint = { icon: "CornerDownRight", label: t("chat.hint.directMany", { count: directs.length }) };
  let disabledReason: string | null = null;
  if (deciding) disabledReason = t("chat.disabled.loadingConversation");
  else if (!threadId) {
    if (!snapshot) disabledReason = list.isError ? t("chat.disabled.statusUnavailable") : t("chat.disabled.loadingConfig");
    else if (!snapshot.configured) disabledReason = t("chat.disabled.needWorkingDir");
    else if (snapshot.workingDirIssue) disabledReason = t("chat.disabled.workingDirUnavailable");
  }

  const activeQuery = threadId ? detail : list;
  const sidebarProps = {
    tab, onTab: setTab, snapshot, threadId, onSelectThread: selectThread, onThreadClosed: closeTab, theme, hostId: host.id,
    navigation, openSettings,
  };
  const notFound = Boolean(threadId && detailData && !thread);

  return (
    <View
      ref={rootRef}
      style={{ flex: 1, flexDirection: "row", backgroundColor: theme.colors.surface0 }}
      onLayout={(event) => {
        setWidth(event.nativeEvent.layout.width);
        measureOffset();
      }}
    >
      {/* Android 上宿主开了 edge-to-edge(窗口不再随键盘缩放),同样要靠 padding 抬升;web 交给浏览器。 */}
      <KeyboardAvoidingView
        style={{ flex: 1, minWidth: 0 }}
        behavior={layout.platform === "web" ? undefined : "padding"}
        keyboardVerticalOffset={keyboardOffset}
      >
        {deciding ? (
          <View style={{ height: 44, borderBottomWidth: HAIRLINE, borderBottomColor: theme.colors.border }} />
        ) : (
          <ChatTabBar tabIds={tabs?.open ?? []} activeId={threadId} snapshot={snapshot} theme={theme} compact={layout.compact}
            onSelect={selectThread} onClose={closeTab} trailing={docked ? (
              sidebarOpen ? null : (
                <Button theme={theme} variant="ghost" size="xs" icon="PanelRightOpen" accessibilityLabel={t("chat.sidebar.show")}
                  onPress={() => setSidebarOpen(true)} />
              )
            ) : (
              <Button theme={theme} variant="ghost" size="xs" icon="PanelRight" accessibilityLabel={t("chat.sidebar.open")}
                onPress={() => setSheetOpen(true)} />
            )} />
        )}

        {activeQuery.isError ? (
          <View style={{ paddingHorizontal: space.lg, paddingTop: space.md, alignItems: "center" }}>
            <View style={{ width: "100%", maxWidth: metrics.maxWidth }}>
              <Notice theme={theme} tone={activeQuery.data ? "warning" : "danger"}
                title={activeQuery.data ? t("chat.stateRefreshFailed") : t("chat.stateLoadFailed")}
                description={activeQuery.error instanceof Error ? activeQuery.error.message : String(activeQuery.error)}>
                <Button theme={theme} label={t("chat.retry")} size="xs" variant="outline" onPress={() => void activeQuery.refetch()} />
              </Notice>
            </View>
          </View>
        ) : null}

        {deciding || (threadId && !detailData && !pendingText && !detail.isError) ? (
          <View style={{ flex: 1 }}><Loading /></View>
        ) : (
          <ChatMessages
            key={threadId ?? "new"}
            hostId={host.id}
            entries={entries}
            tickets={detailData?.tickets ?? []}
            pendingText={pendingText}
            working={working}
            truncated={truncated}
            theme={theme}
            navigation={navigation}
            metrics={metrics}
            empty={notFound ? (
              <NotFound theme={theme} onClose={() => closeTab(threadId)} />
            ) : threadId ? null : (
              <Welcome snapshot={snapshot} theme={theme} openSettings={openSettings} onSelectThread={selectThread} />
            )}
          />
        )}

        <ChatComposer
          key={`${host.id}:${threadId ?? "new"}`}
          draftKey={`${host.id}:${threadId ?? "new"}`}
          theme={theme}
          layout={layout}
          metrics={metrics}
          placeholder={threadId ? t("chat.composer.placeholderReply") : t("chat.composer.placeholderNew")}
          hint={hint}
          disabledReason={disabledReason}
          onSubmit={submit}
        />
      </KeyboardAvoidingView>

      {docked && sidebarOpen ? (
        <View style={{ width: SIDEBAR_WIDTH, borderLeftWidth: HAIRLINE, borderLeftColor: theme.colors.border, backgroundColor: theme.colors.surface0 }}>
          <SidebarTabs tab={tab} onTab={setTab} theme={theme} trailing={
            <Button theme={theme} variant="ghost" size="xs" icon="PanelRightClose" accessibilityLabel={t("chat.sidebar.hide")}
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
  const t = useT();
  const recent = (snapshot?.threads ?? []).filter((thread) => thread.state !== "closed").slice(0, 4);
  const muted = theme.colors.foregroundMuted;
  return (
    <View style={{ flex: 1, justifyContent: "center", gap: space.xl, paddingVertical: space.xl }}>
      <View style={{ alignItems: "center", gap: space.sm }}>
        <View style={{ width: 40, height: 40, marginBottom: space.xs, borderRadius: radius.overlay, alignItems: "center", justifyContent: "center",
          ...cardSurface(theme) }}>
          <Icon name="Network" size={18} color={muted} />
        </View>
        <Text style={{ color: theme.colors.foreground, fontSize: TYPE.stat.size, lineHeight: 28, fontWeight: "600", textAlign: "center" }}>
          {t("chat.welcome.title")}
        </Text>
        <Text style={{ maxWidth: 480, color: muted, fontSize: TYPE.bodyRead.size, lineHeight: TYPE.bodyRead.lineHeight, textAlign: "center" }}>
          {t("chat.welcome.body")}
        </Text>
        {snapshot?.workingDir ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs + 2, maxWidth: "100%", marginTop: space.xs }}>
            <Icon name="Folder" size={12} color={muted} />
            <Text numberOfLines={1} ellipsizeMode="middle"
              style={{ flexShrink: 1, maxWidth: 440, color: muted, fontSize: TYPE.caption.size, lineHeight: TYPE.caption.lineHeight }}>
              {snapshot.workingDir}
            </Text>
          </View>
        ) : null}
      </View>
      {snapshot?.configured && snapshot.workingDirIssue ? (
        <Notice theme={theme} tone="danger" title={t("chat.welcome.workerCannotStart")} description={snapshot.workingDirIssue}>
          <Button theme={theme} variant="outline" size="xs" label={t("chat.welcome.openSettings")} onPress={openSettings} />
        </Notice>
      ) : snapshot && !snapshot.configured ? (
        <Notice theme={theme} tone="warning" title={t("chat.welcome.setWorkingDir")}>
          <Button theme={theme} variant="outline" size="xs" label={t("chat.welcome.openSettings")} onPress={openSettings} />
        </Notice>
      ) : null}
      {recent.length ? (
        <View style={{ gap: space.sm }}>
          <Text style={{ color: muted, fontSize: TYPE.caption.size, lineHeight: TYPE.caption.lineHeight, fontWeight: "600" }}>{t("chat.welcome.recent")}</Text>
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
  const t = useT();
  const [hovered, setHovered] = useState(false);
  const card = chatTokens(theme).card;
  const status = threadStatus(thread, snapshot.tickets.filter((ticket) => ticket.threadId === thread.id),
    thread.lastDecision ? [thread.lastDecision] : [], t);
  const preview = thread.latestResult ? markdownPreview(thread.latestResult.text).replace(/\s+/g, " ").trim() : thread.summary ?? "";
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${thread.title},${status.label}`} onPress={onPress}
      onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)}
      style={({ pressed }) => ({ gap: space.xs, paddingVertical: space.sm + 2, paddingHorizontal: space.md, ...cardSurface(theme),
        ...(hovered || pressed ? card.shadowHover : null), ...(pressed ? { backgroundColor: card.controlHover } : null), ...WEB_TRANSITION })}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, color: theme.colors.foreground, fontSize: TYPE.body.size, lineHeight: TYPE.body.lineHeight,
          fontWeight: "500" }}>{thread.title}</Text>
        <StatusBadge theme={theme} {...status} />
      </View>
      <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: TYPE.caption.size, lineHeight: TYPE.caption.lineHeight }}>
        {relativeTime(thread.updatedAt, t)}{preview ? ` · ${preview}` : ""}
      </Text>
    </Pressable>
  );
}

function NotFound({ theme, onClose }: { theme: Theme; onClose(): void }) {
  const t = useT();
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: space.md }}>
      <Icon name="MessageSquareOff" size={20} color={theme.colors.foregroundMuted} />
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: TYPE.body.size, lineHeight: TYPE.body.lineHeight }}>
        {t("chat.notFound.message")}
      </Text>
      <Button theme={theme} variant="outline" size="xs" icon="X" label={t("chat.notFound.closeTab")} onPress={onClose} />
    </View>
  );
}
