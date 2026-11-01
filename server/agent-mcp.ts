import type { PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import type { SuperagentMcpEndpoint } from "./mcp-server";
import { isOrchestrationAgent } from "./workers";

/**
 * session_open 转换:把插件自持的 superagent_dispatch MCP server 注入普通 agent 会话。
 * 替代早期 defineAgentTool 的 tools 注入——那条通道会被宿主的 "Paseo tools" 开关
 * (mcp.injectIntoAgents)连带给关掉,这条不会。
 */

/** 注入的 MCP server 名。不能叫 `paseo`(daemon 保留名),也应避开常见自定义名。 */
export const DISPATCH_MCP_SERVER_NAME = "superagent";

/**
 * 默认注入的 provider:已知声明 supportsMcpServers 的内置 provider。其余(pi 及 ACP 系
 * cursor/kimi/kiro/trae、未来的未知 provider)注入会让会话启动直接失败,故跳过;
 * 可用设置 agentToolProviders 覆盖(增删任意 provider id)。
 */
const DEFAULT_MCP_PROVIDERS = ["claude", "codex", "opencode", "omp", "copilot"];

export function resolveMcpProviders(configured: string): string[] {
  const list = configured
    .split(/[,，\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return list.length > 0 ? list : DEFAULT_MCP_PROVIDERS;
}

/** session_open 转换:按设置注入 MCP server;编排自身的 agent 与不支持的 provider 不注入。 */
export function createSessionOpenTransform(
  resolveEndpoint: () => SuperagentMcpEndpoint | null,
  enabled: () => boolean,
  providers: () => string[],
): (request: PluginSessionOpenRequest) => PluginSessionOpenRequest | undefined {
  return (request) => {
    if (!enabled()) return undefined;
    const endpoint = resolveEndpoint();
    if (!endpoint) return undefined;
    if (isOrchestrationAgent(request.labels)) return undefined;
    if (!providers().includes(request.provider)) return undefined;
    if (request.mcpServers[DISPATCH_MCP_SERVER_NAME]) return undefined;
    return {
      ...request,
      mcpServers: {
        ...request.mcpServers,
        [DISPATCH_MCP_SERVER_NAME]: {
          type: "http" as const,
          url: endpoint.urlFor(request.agentId),
          // 避免 Claude 的 tool search 延迟加载把单工具藏起来。
          alwaysLoad: true,
        },
      },
    };
  };
}
