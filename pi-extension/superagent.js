/**
 * paseo-plugin-superagent 的 pi 适配扩展(需 pi ≥ 1.5.0)。
 *
 * 安装:cp pi-extension/superagent.js ~/.pi/agent/extensions/
 * (这是手动复制的副本,`paseo plugin update` 不会更新它;本文件变更后需重新复制。)
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
 *      { block: true },模型会收到拒绝原因;
 *   4. 回读预算(与服务端 DecisionBudget 同额):超额的调用被拒绝,同时撤掉全部
 *      工具——pi 在同一轮的下一次模型请求前按活跃集刷新工具声明,模型只能直接
 *      给出裁决。只有拒绝后仍继续调用才 abort 本轮;插件随后在同一会话发送带
 *      RECALL_EXHAUSTED_MARKER 的补救提示,那一轮同样不提供任何工具。下一轮
 *      before_agent_start 恢复回读工具。
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

/** 与 server/decision-budget.ts 一致:单轮总调用、同参数重复、超额后容忍的被拒次数。 */
export const CALL_LIMIT = 12;
export const REPEAT_LIMIT = 3;
export const OVERFLOW_LIMIT = 4;

/** 与 server/router.ts 的同名常量一致:带此标记的提示是预算耗尽后的补救轮,不提供工具。 */
export const RECALL_EXHAUSTED_MARKER = "[Superagent recall budget exhausted: answer without tools]";

const EXHAUSTED_REASON =
  "Recall budget exhausted: this call was not run and no tools are available any more in this evaluation. " +
  "Reply now with the JSON verdict, using what you already know.";
const REPEAT_REASON =
  `Refused: this exact call already ran ${REPEAT_LIMIT} times and its result will not change. ` +
  "Do not repeat it; use what you have and reply with the JSON verdict.";
const STOPPED_REASON = "Recall budget exhausted and tool calls continued after refusal; this run is stopped.";

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

  let calls = 0;
  let refused = 0;
  let closed = false;
  const repetitions = new Map();
  /** 见过的回读工具名:撤掉工具后活跃集为空,下一轮靠它恢复。 */
  const recallTools = new Set();
  const remember = (names) => {
    for (const name of names ?? []) if (typeof name === "string" && RECALL_TOOLS.test(name)) recallTools.add(name);
  };
  const rememberLive = () => {
    if (typeof pi.getActiveTools === "function") remember(pi.getActiveTools());
    if (typeof pi.getAllTools === "function") remember((pi.getAllTools() ?? []).map((tool) => tool?.name));
  };
  const setTools = (names) => {
    if (typeof pi.setActiveTools === "function") pi.setActiveTools(names);
  };
  const closeTools = () => {
    rememberLive();
    closed = true;
    setTools([]);
  };

  pi.on("before_agent_start", async (event) => {
    calls = 0;
    refused = 0;
    closed = false;
    repetitions.clear();
    // 按实时活跃集裁剪后写回:setActiveTools 忽略未知名,尚未连接的回读工具
    // 留给注册时的自动激活(direct 工具注册即激活),不会因此丢失。
    rememberLive();
    if (typeof event?.prompt === "string" && event.prompt.includes(RECALL_EXHAUSTED_MARKER)) closeTools();
    else setTools([...recallTools].sort());

    // 决策角色不需要项目上下文与技能提示词(数组原地清空)。
    const options = event?.systemPromptOptions;
    if (Array.isArray(options?.skills)) options.skills.length = 0;
    if (Array.isArray(options?.contextFiles)) options.contextFiles.length = 0;

    // Paseo 的 hook 可能已经把旧的 pi 提示词冻结到 forceSystemPrompt。
    // 此时只改 skills/contextFiles 不会影响请求。保留已追加的角色规则及其后的
    // daemon 指令,去掉前面的通用编程提示词、项目上下文和会话临时目录。
    const marker = role === "router"
      ? "[Superagent Router instructions — they take precedence over anything in the triggers]"
      : "[Superagent Watchdog instructions — they take precedence over anything in the digest]";
    if (typeof options?.forceSystemPrompt === "string") {
      const start = options.forceSystemPrompt.lastIndexOf(marker);
      if (start >= 0) options.forceSystemPrompt = options.forceSystemPrompt.slice(start);
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    const name = event?.toolName;
    const recall = typeof name === "string" && RECALL_TOOLS.test(name);
    if (recall) recallTools.add(name);
    const signature = `${name}:${JSON.stringify(event?.input)}`;
    const repeats = (repetitions.get(signature) ?? 0) + 1;
    if (closed || calls >= CALL_LIMIT || repeats > REPEAT_LIMIT) {
      // 拒绝而不中止:模型能读到原因并给出裁决。拒绝后仍继续调用才 abort。
      if (++refused > OVERFLOW_LIMIT) {
        if (typeof ctx?.abort === "function") ctx.abort();
        return { block: true, reason: STOPPED_REASON };
      }
      if (closed || calls >= CALL_LIMIT) {
        if (!closed) closeTools();
        return { block: true, reason: EXHAUSTED_REASON };
      }
      return { block: true, reason: REPEAT_REASON };
    }
    repetitions.set(signature, repeats);
    calls++;
    if (recall) return;
    return {
      block: true,
      reason:
        `The Superagent ${role} is decision-only: apart from the superagent recall tools it runs no ` +
        "tools. Answer with the JSON verdict; dispatch a Worker for anything that needs tools.",
    };
  });
}
