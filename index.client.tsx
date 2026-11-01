import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { SuperagentScreen } from "./client/screen";
import { superagentDispatchRpc } from "./shared/rpc";

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
  client.addScreen({
    id: "main",
    title: "Superagent",
    Component: SuperagentScreen,
  });
  client.addSidebarHeaderItem({
    id: "main",
    title: "Superagent",
    Component: SuperagentSidebarItem,
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
