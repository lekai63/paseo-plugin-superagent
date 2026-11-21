import type { PluginClientContext, PluginScreenProps, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { ChatScreen } from "./client/chat-screen";
import type { SidebarTab } from "./client/chat-sidebar";
import {
  SuperagentExecutionSettingsScreen,
  SuperagentGeneralSettingsScreen,
  SuperagentImSettingsScreen,
  SuperagentModelSettingsScreen,
  SuperagentRuleSettingsScreen,
} from "./client/settings-screen";
import { superagentDispatchRpc } from "./shared/rpc";
import { useExecutionAgents, useSuperagentState } from "./client/query";
import { routerStatusMark, sidebarWorkerCounts } from "./shared/sidebar-status";
import { SidebarRouterMark, SidebarWorkerCounts } from "./client/sidebar-worker-counts";
import { messages, useReportLocale } from "./client/i18n";

const SETTINGS_SCREEN_ID = "general";

function SuperagentSidebarItem({ currentScreen, openScreen, host, theme }: PluginSidebarItemProps) {
  // 侧栏行常驻挂载:由它把 app 语言告诉 daemon(daemon 生成的文字随之切换)。
  useReportLocale(host.id);
  const query = useSuperagentState(host.id);
  const snapshot = query.data;
  const workerIds = (snapshot?.tickets ?? [])
    .filter((ticket) => ["launching", "running", "waiting", "completed"].includes(ticket.status)).map((ticket) => ticket.workerAgentId)
    .filter((id): id is string => Boolean(id));
  const agents = useExecutionAgents(host.id, workerIds);
  const counts = snapshot && !query.isError && !workerIds.some((id) => agents[id]?.error)
    ? sidebarWorkerCounts(snapshot.tickets, Object.fromEntries(Object.entries(agents).map(([id, item]) => [id, item.agent]))) : null;
  // 有 Worker 在运行/待命时只显示 Worker 计数;状态不可用(counts 为 null)时两者都不显示。
  const workersQuiet = counts !== null && counts.running === 0 && counts.done === 0;
  const routerMark = routerStatusMark(snapshot);
  return (
    <SidebarRow
      icon="Network"
      label="Superagent"
      trailing={workersQuiet
        ? (routerMark ? <SidebarRouterMark mark={routerMark} theme={theme} /> : null)
        : counts && (counts.running > 0 || counts.done > 0) ? <SidebarWorkerCounts counts={counts} theme={theme} /> : null}
      active={Boolean(currentScreen && ["main", "history", "status"].includes(currentScreen.screenId))}
      onPress={() => openScreen({ screenId: "main" })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  const openSettings = () => client.openSettings(SETTINGS_SCREEN_ID);
  /** 打开对话页:带线程时进入该对话,否则打开侧栏的指定标签(默认对话列表)。 */
  const openChat = (input: { threadId?: string; panel?: SidebarTab } = {}) => client.openScreen({
    screenId: "main",
    params: input.threadId ? { threadId: input.threadId } : { panel: input.panel ?? "threads" },
  });

  // 对话页需要跳到设置页,而 openSettings 只在 client 上下文里有:在这里绑定一次。
  function MainScreen(props: PluginScreenProps) {
    return <ChatScreen {...props} openSettings={openSettings} />;
  }
  // 旧版的「历史消息」「运行状态」页已并入对话页右侧栏;保留路由,打开时直接定位到对应标签。
  function HistoryAlias(props: PluginScreenProps) {
    return <ChatScreen {...props} openSettings={openSettings} defaultPanel="threads" />;
  }
  function StatusAlias(props: PluginScreenProps) {
    return <ChatScreen {...props} openSettings={openSettings} defaultPanel="status" />;
  }

  client.addScreen({ id: "main", title: "Superagent", Component: MainScreen });
  client.addScreen({ id: "history", title: "Superagent", Component: HistoryAlias });
  client.addScreen({ id: "status", title: "Superagent", Component: StatusAlias });
  client.addSidebarHeaderItem({
    id: "main",
    title: "Superagent",
    Component: SuperagentSidebarItem,
  });
  client.addCommandCenterItem({
    id: "open-history",
    title: messages.message("host.commandConversations"),
    icon: "MessagesSquare",
    // 搜索关键词不随语言切换:中英文都收,两种界面语言下都能搜到。
    keywords: ["superagent", "history", "messages", "threads", "conversations", "历史", "消息", "线程", "对话"],
    context: "global",
    onSelect: () => openChat({ panel: "threads" }),
  });
  client.addCommandCenterItem({
    id: "open-status",
    title: messages.message("host.commandStatus"),
    icon: "Activity",
    keywords: ["superagent", "status", "watchdog", "状态", "看门狗"],
    context: "global",
    onSelect: () => openChat({ panel: "status" }),
  });
  // 配置放在 Settings → Plugins → Superagent;注册多个设置页时宿主会按此顺序渲染成标签页。
  const settingsScreens = [
    { id: SETTINGS_SCREEN_ID, title: "settings.tabs.general", icon: "Settings", Component: SuperagentGeneralSettingsScreen },
    { id: "models", title: "settings.tabs.models", icon: "Cpu", Component: SuperagentModelSettingsScreen },
    { id: "rules", title: "settings.tabs.rules", icon: "ListChecks", Component: SuperagentRuleSettingsScreen },
    { id: "execution", title: "settings.tabs.execution", icon: "Timer", Component: SuperagentExecutionSettingsScreen },
    { id: "im", title: "settings.tabs.im", icon: "MessagesSquare", Component: SuperagentImSettingsScreen },
  ] as const;
  for (const screen of settingsScreens) {
    client.addSettingsScreen({
      id: screen.id,
      title: messages.message(screen.title),
      icon: screen.icon,
      Component: screen.Component,
    });
  }
  client.addCommandCenterItem({
    id: "open-settings",
    title: messages.message("host.commandSettings"),
    icon: "Settings",
    keywords: ["superagent", "router", "worker", "settings", "设置"],
    context: "global",
    onSelect({ openSettings: open }) {
      open(SETTINGS_SCREEN_ID);
    },
  });

  // /superagent <task>:在任意 agent 会话里把工作委派给编排层。
  // 输入框清空与错误提示由宿主负责;成功后 Router 的答复会回到本会话。
  client.addSlashCommand({
    name: "superagent",
    description: messages.message("host.slashDescription"),
    argumentHint: "<task>",
    context: "agent",
    async onSubmit({ args, agent, rpc }) {
      const task = args.trim();
      if (!task) return;
      await rpc(superagentDispatchRpc, {
        title: task.split("\n")[0].slice(0, 120),
        task,
        sender: `agent:${agent.id}`,
        replyToAgentId: agent.id,
      });
    },
  });

  return () => {};
}
