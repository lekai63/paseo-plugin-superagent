import type { PluginClientContext, PluginScreenProps, PluginSidebarItemProps, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { SuperagentScreen } from "./client/screen";
import { SuperagentSettingsScreen } from "./client/settings-screen";
import { ExecutionPanel } from "./client/execution-panel";
import { HistoryScreen } from "./client/history-screen";
import { StatusScreen } from "./client/status-screen";
import { superagentDispatchRpc } from "./shared/rpc";
import { useExecutionAgents, useSuperagentState } from "./client/query";
import { routerSidebarStatus, sidebarWorkerCounts } from "./shared/sidebar-status";
import { AgentStatusIcon } from "./client/agent-status-icon";
import { SidebarWorkerCounts } from "./client/sidebar-worker-counts";

const SETTINGS_SCREEN_ID = "general";

function SuperagentSidebarItem({ currentScreen, openScreen, host, theme }: PluginSidebarItemProps) {
  const query = useSuperagentState(host.id);
  const snapshot = query.data;
  const workerIds = (snapshot?.tickets ?? [])
    .filter((ticket) => ["launching", "running", "waiting", "completed"].includes(ticket.status)).map((ticket) => ticket.workerAgentId)
    .filter((id): id is string => Boolean(id));
  const ids = [snapshot?.routerAgentId, ...workerIds]
    .filter((id): id is string => Boolean(id));
  const agents = useExecutionAgents(host.id, ids);
  const router = snapshot?.routerAgentId ? agents[snapshot.routerAgentId] : undefined;
  const status = routerSidebarStatus(snapshot, router?.agent, query.isError || router?.error);
  const counts = snapshot && !query.isError && !workerIds.some((id) => agents[id]?.error)
    ? sidebarWorkerCounts(snapshot.tickets, Object.fromEntries(Object.entries(agents).map(([id, item]) => [id, item.agent]))) : null;
  const StatusIcon = useMemo(() => () => <AgentStatusIcon status={status} theme={theme} />, [status, theme]);
  return (
    <SidebarRow
      icon={StatusIcon}
      label="Superagent"
      trailing={<SidebarWorkerCounts counts={counts} theme={theme} />}
      active={Boolean(currentScreen && ["main", "history", "status"].includes(currentScreen.screenId))}
      onPress={() => openScreen({ screenId: "main" })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  const openSettings = () => client.openSettings(SETTINGS_SCREEN_ID);
  const openMain = () => client.openScreen({ screenId: "main" });
  const openStatus = () => client.openScreen({ screenId: "status" });
  const openHistory = (input: { threadId?: string; ticketId?: string } = {}) => client.openScreen({
    screenId: "history",
    params: { ...(input.threadId ? { threadId: input.threadId } : {}), ...(input.ticketId ? { ticketId: input.ticketId } : {}) },
  });

  // 主界面需要跳到设置页,而 openSettings 只在 client 上下文里有:在这里绑定一次。
  function MainScreen(props: PluginScreenProps) {
    return <SuperagentScreen {...props} openSettings={openSettings} openHistory={openHistory} openStatus={openStatus} />;
  }

  client.addScreen({
    id: "main",
    title: "Superagent",
    Component: MainScreen,
  });
  client.addScreen({
    id: "history",
    title: "Superagent 历史消息",
    Component: (props) => <HistoryScreen {...props} openMain={openMain} openHistory={openHistory} />,
  });
  client.addScreen({
    id: "status",
    title: "Superagent 运行状态",
    Component: (props) => <StatusScreen {...props} openMain={openMain} openSettings={openSettings} />,
  });
  client.addWorkspacePanel({
    id: "execution",
    title: "Superagent 执行视图",
    icon: "Network",
    locations: ["workspace", "explorer"],
    Component: (props: PluginWorkspacePanelProps) => <ExecutionPanel {...props} openHistory={openHistory} />,
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
    title: "Superagent 历史消息",
    icon: "History",
    keywords: ["superagent", "历史", "消息", "线程"],
    context: "global",
    onSelect: () => openHistory(),
  });
  client.addCommandCenterItem({
    id: "open-status",
    title: "Superagent 运行状态",
    icon: "Activity",
    keywords: ["superagent", "状态", "watchdog"],
    context: "global",
    onSelect: openStatus,
  });
  // 配置放在 Settings → Plugins → Superagent,主界面只保留操作与监控。
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
