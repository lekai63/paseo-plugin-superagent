/**
 * paseo-plugin-superagent 的 pi 适配扩展(需 pi ≥ 1.5.0)。
 *
 * 安装:cp pi-extension/superagent.js ~/.pi/agent/extensions/
 *
 * 为什么需要它:pi 家族不走 Paseo 的 mcpServers 注入——Paseo→pi 的配置转换不透传
 * exposure,pi 的 MCP 工具会以默认 codemode 暴露(模型不能直接调用);pi 也不把工具
 * 调用送进 Paseo 权限流,插件「只裁决」的权限钩子对 pi 不生效。插件因此在
 * session_open 时改经 env 下发角色 MCP URL(SUPERAGENT_PI_MCP_URL / SUPERAGENT_PI_ROLE,
 * 每次 session open 都带最新 URL,跟随插件重载后的端口与密钥轮换),由本扩展:
 *
 *   1. 以 exposure "direct" 注册 superagent MCP server(工具直接声明给模型):
 *      Router/看门狗 → superagent_list / read / search;Worker → unsubscribe /
 *      handback;普通 agent → superagent_dispatch;
 *   2. Router/看门狗会话裁剪工具:before_agent_start 里按 pi.getActiveTools() 的
 *      实时活跃集过滤出回读工具并以 setActiveTools 写回(不能改事件里的
 *      selectedTools 快照——MCP 服务器在首提示前才连接,快照里还没有回读工具,
 *      清空快照会把它们一并清掉);同时清空 skills 与 contextFiles(决策角色
 *      不需要项目上下文)。连接尚未完成时活跃集可能暂时为空:direct 工具注册时
 *      会自动激活,无需补偿;
 *   3. tool_call 兜底拦截:任何非回读工具的调用(含 codemode 等嵌套调用)一律
 *      { block: true },模型会收到拒绝原因。
 *
 * 安全:没有 SUPERAGENT_PI_MCP_URL 时扩展完全休眠,不影响你自己的交互式 pi 与
 * 其他 pi 会话。扩展未安装时插件照常降级运行(pi Router 仅凭提示词裁决),只是没有
 * 回读工具与硬约束;daemon 日志会在首个 pi 编排会话时提示安装。
 */

const MCP_URL_ENV = "SUPERAGENT_PI_MCP_URL";
const ROLE_ENV = "SUPERAGENT_PI_ROLE";
const SERVER_NAME = "superagent";

/** Router/看门狗仅可调用的工具(pi 的 MCP 工具名形如 mcp__<server>__<tool>)。 */
const RECALL_TOOLS = /^mcp__superagent__superagent_(?:list|read|search)$/;

const ROLE_DESCRIPTIONS = {
  router: "Superagent orchestration recall (read-only): superagent_list / superagent_read / superagent_search",
  watchdog: "Superagent orchestration recall (read-only): superagent_list / superagent_read / superagent_search",
  worker: "Superagent session control: superagent_unsubscribe / superagent_handback",
  dispatch: "superagent_dispatch: delegate a task to the Superagent orchestrator",
};

export default function superagentPiAdapter(pi) {
  const url = process.env[MCP_URL_ENV]?.trim();
  if (!url) return; // 插件没有开门(普通交互式 pi):整体休眠。

  const role = process.env[ROLE_ENV]?.trim() || "dispatch";

  try {
    pi.registerMcpServer(SERVER_NAME, {
      url,
      exposure: "direct",
      description: ROLE_DESCRIPTIONS[role] ?? ROLE_DESCRIPTIONS.dispatch,
    });
  } catch (error) {
    // 老 pi 没有 registerMcpServer 等扩展 API:角色工具不可用,但下面的工具裁剪
    // 与拦截仍然生效(与插件「回读工具不可用则仅凭提示词裁决」的降级一致)。
    console.error("[superagent-pi] registerMcpServer failed (need pi >= 1.5.0):", error);
  }

  if (role !== "router" && role !== "watchdog") return;

  pi.on("before_agent_start", async (event) => {
    // 按实时活跃集裁剪后写回:setActiveTools 忽略未知名,尚未连接的回读工具
    // 留给注册时的自动激活(direct 工具注册即激活),不会因此丢失。
    const active = typeof pi.getActiveTools === "function" ? pi.getActiveTools() : [];
    const keep = active.filter((name) => typeof name === "string" && RECALL_TOOLS.test(name));
    if (typeof pi.setActiveTools === "function") pi.setActiveTools(keep);

    // 决策角色不需要项目上下文与技能提示词(数组原地清空)。
    const options = event?.systemPromptOptions;
    if (Array.isArray(options?.skills)) options.skills.length = 0;
    if (Array.isArray(options?.contextFiles)) options.contextFiles.length = 0;
  });

  pi.on("tool_call", async (event) => {
    if (typeof event?.toolName === "string" && RECALL_TOOLS.test(event.toolName)) return;
    return {
      block: true,
      reason:
        `The Superagent ${role} is decision-only: apart from the superagent recall tools it runs no ` +
        "tools. Answer with the JSON verdict; dispatch a Worker for anything that needs tools.",
    };
  });
}
