/**
 * paseo-plugin-superagent 的 pi 适配扩展(需 pi ≥ 1.5.0)。
 *
 * 安装:cp pi-extension/superagent.js ~/.pi/agent/extensions/
 * (这是手动复制的副本,`paseo plugin update` 不会更新它;本文件变更后需重新复制。)
 *
 * 为什么需要它:pi 家族不走 Paseo 的 mcpServers 注入——Paseo→pi 的配置转换不透传
 * exposure,pi 的 MCP 工具会以默认 codemode 暴露(模型不能直接调用)。插件因此在
 * session_open 时改经 env 下发 MCP URL(SUPERAGENT_PI_MCP_URL / SUPERAGENT_PI_ROLE,
 * 每次 session open 都带最新 URL,跟随插件重载后的端口与密钥轮换),由本扩展以
 * exposure "direct" 注册 superagent MCP server(工具直接声明给模型):
 *   Worker → superagent_unsubscribe / superagent_handback;
 *   普通 agent → superagent_dispatch。
 * Router 与看门狗已改为直接推理,不再创建 pi 会话,也不经过本扩展。
 *
 * 安全:没有 SUPERAGENT_PI_MCP_URL 时扩展完全休眠,不影响你自己的交互式 pi 与
 * 其他 pi 会话。扩展未安装时插件照常降级运行(Worker 与委派仅缺 Superagent 工具),
 * daemon 日志会在首个 pi 编排会话时提示安装。
 */

const MCP_URL_ENV = "SUPERAGENT_PI_MCP_URL";
const ROLE_ENV = "SUPERAGENT_PI_ROLE";
const SERVER_NAME = "superagent";

const ROLE_DESCRIPTIONS = {
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
    // 老 pi 没有 registerMcpServer 等扩展 API:角色工具不可用,Worker 与委派照常
    // 运行,只是没有 Superagent 工具(与插件侧「工具不可用则退回原生流程」一致)。
    console.error("[superagent-pi] registerMcpServer failed (need pi >= 1.5.0):", error);
  }
}
