import type { PluginClientContext, PluginScreenProps, PluginSidebarItemProps, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { ChatScreen } from "./client/chat-screen";
import type { SidebarTab } from "./client/chat-sidebar";
import { SuperagentSettingsScreen } from "./client/settings-screen";
import { ExecutionPanel } from "./client/execution-panel";
import { superagentDispatchRpc } from "./shared/rpc";
import { useExecutionAgents, useSuperagentState } from "./client/query";
import { sidebarWorkerCounts } from "./shared/sidebar-status";
import { SidebarWorkerCounts } from "./client/sidebar-worker-counts";

const SETTINGS_SCREEN_ID = "general";

function SuperagentSidebarItem({ currentScreen, openScreen, host, theme }: PluginSidebarItemProps) {
  const query = useSuperagentState(host.id);
  const snapshot = query.data;
  const workerIds = (snapshot?.tickets ?? [])
    .filter((ticket) => ["launching", "running", "waiting", "completed"].includes(ticket.status)).map((ticket) => ticket.workerAgentId)
    .filter((id): id is string => Boolean(id));
  const agents = useExecutionAgents(host.id, workerIds);
  const counts = snapshot && !query.isError && !workerIds.some((id) => agents[id]?.error)
    ? sidebarWorkerCounts(snapshot.tickets, Object.fromEntries(Object.entries(agents).map(([id, item]) => [id, item.agent]))) : null;
  return (
    <SidebarRow
      icon="Network"
      label="Superagent"
      trailing={counts && (counts.running > 0 || counts.done > 0) ? <SidebarWorkerCounts counts={counts} theme={theme} /> : null}
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
  client.addWorkspacePanel({
    id: "execution",
    title: "Superagent 执行视图",
    icon: "Network",
    locations: ["workspace", "explorer"],
    Component: (props: PluginWorkspacePanelProps) => <ExecutionPanel {...props} openChat={openChat} />,
  });
  client.addCommandCenterItem({
    id: "open-execution",
    title: "Superagent 执行视图",
    icon: "Network",
    keywords: ["superagent", "router", "worker", "执行", "监控"],
    context: "workspace",
    onSelect({ openPanel }) { openPanel("execution"); },
  });
  client.addSidebarHeaderItem({
    id: "main",
    title: "Superagent",
    Component: SuperagentSidebarItem,
  });
  client.addCommandCenterItem({
    id: "open-history",
    title: "Superagent 对话记录",
    icon: "MessagesSquare",
    keywords: ["superagent", "历史", "消息", "线程", "对话"],
    context: "global",
    onSelect: () => openChat({ panel: "threads" }),
  });
  client.addCommandCenterItem({
    id: "open-status",
    title: "Superagent 运行状态",
    icon: "Activity",
    keywords: ["superagent", "状态", "watchdog"],
    context: "global",
    onSelect: () => openChat({ panel: "status" }),
  });
  // 配置放在 Settings → Plugins → Superagent,对话页只保留对话、操作与监控。
  client.addSettingsScreen({
    id: SETTINGS_SCREEN_ID,
    title: "Superagent",
    icon: "Network",
    Component: SuperagentSettingsScreen,
  });
  client.addCommandCenterItem({
    id: "open-settings",
    title: "Superagent 设置",
    icon: "Settings",
    keywords: ["superagent", "router", "worker", "设置"],
    context: "global",
    onSelect({ openSettings: open }) {
      open(SETTINGS_SCREEN_ID);
    },
  });

  // /superagent <task>:在任意 agent 会话里把工作委派给编排层。
  // 输入框清空与错误提示由宿主负责;成功后 Router 的答复会回到本会话。
  client.addSlashCommand({
    name: "superagent",
    description: "把任务委派给 Superagent 编排(Router 评估 → Worker 执行,结果回到本会话)",
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
