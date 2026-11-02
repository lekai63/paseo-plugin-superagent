import type { PluginClientContext, PluginScreenProps, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { SuperagentScreen } from "./client/screen";
import { SuperagentSettingsScreen } from "./client/settings-screen";
import { superagentDispatchRpc } from "./shared/rpc";

const SETTINGS_SCREEN_ID = "general";

function SuperagentSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="Network"
      label="Superagent"
      active={currentScreen?.screenId === "main"}
      onPress={() => openScreen({ screenId: "main" })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  const openSettings = () => client.openSettings(SETTINGS_SCREEN_ID);

  // 主界面需要跳到设置页,而 openSettings 只在 client 上下文里有:在这里绑定一次。
  function MainScreen(props: PluginScreenProps) {
    return <SuperagentScreen {...props} openSettings={openSettings} />;
  }

  client.addScreen({
    id: "main",
    title: "Superagent",
    Component: MainScreen,
  });
  client.addSidebarHeaderItem({
    id: "main",
    title: "Superagent",
    Component: SuperagentSidebarItem,
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
