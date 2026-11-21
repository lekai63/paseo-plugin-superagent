import type { PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import type { SuperagentMcpEndpoint } from "./mcp-server";
import { DISPATCH_MCP_SERVER_NAME } from "./mcp-server";
import { isOrchestrationAgent } from "./workers";
import { ROUTER_LABEL, ROUTER_LABEL_VALUE, TICKET_LABEL } from "./router";
import { WATCHDOG_AGENT_LABEL_VALUE } from "../shared/model";

/**
 * session_open 转换:把插件自持的 MCP server 注入 agent 会话。
 * 替代早期 defineAgentTool 的 tools 注入——那条通道会被宿主的 "Paseo tools" 开关
 * (mcp.injectIntoAgents)连带给关掉,这条不会。
 *
 * 普通 agent 拿 superagent_dispatch，Worker 拿退订和转回。推理回读由插件直接执行。
 */

/** 注入的 MCP server 名(定义在 mcp-server;不能叫 `paseo`,daemon 保留名)。 */
export { DISPATCH_MCP_SERVER_NAME } from "./mcp-server";

/**
 * 默认注入的 provider:已知声明 supportsMcpServers 的内置 provider。其余(ACP 系
 * cursor/kimi/kiro/trae、未来的未知 provider)注入会让会话启动直接失败,故跳过;
 * 可用设置 agentToolProviders 覆盖(增删任意 provider id)。pi 家族不在此列:
 * 它不经 mcpServers 注入,走 env + pi 扩展通道(见 PI_MCP_URL_ENV)。
 */
const DEFAULT_MCP_PROVIDERS = ["claude", "codex", "opencode", "omp", "copilot"];

/** pi 系会话经 env 下发的角色 MCP URL 与角色名,由 pi-extension/superagent.js 读取。 */
export const PI_MCP_URL_ENV = "SUPERAGENT_PI_MCP_URL";
export const PI_ROLE_ENV = "SUPERAGENT_PI_ROLE";

function isPiProvider(provider: string): boolean {
  return provider.split("/")[0] === "pi";
}

export function resolveMcpProviders(configured: string): string[] {
  const list = configured
    .split(/[,，\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return list.length > 0 ? list : DEFAULT_MCP_PROVIDERS;
}

/**
 * Worker 的 provider 门控:provider 可能带 model 限定
 * (如 codex/test),按 family 匹配。默认五家之外,用户在「注入 provider」里显式
 * 配置过的 family 也放行(如本机 zcode-acp——插件型 provider 在 daemon 侧统一声明
 * supportsMcpServers,注入不支持的 provider 才会导致会话启动失败)。
 */
export function mcpCapableProvider(provider: string, extraFamilies: readonly string[] = []): boolean {
  const family = provider.split("/")[0];
  return DEFAULT_MCP_PROVIDERS.includes(family) || extraFamilies.includes(family);
}

/**
 * pi 系会话不做 mcpServers 注入:Paseo→pi 的配置转换不透传 exposure,pi 的 MCP 工具
 * 会以默认 codemode 暴露。改经 env 把角色 URL 交给随插件发行的 pi 扩展注册。
 */
function piEnvRequest(
  request: PluginSessionOpenRequest,
  url: string,
  role: "worker" | null,
): PluginSessionOpenRequest {
  return {
    ...request,
    env: {
      ...request.env,
      [PI_MCP_URL_ENV]: url,
      ...(role ? { [PI_ROLE_ENV]: role } : {}),
    },
  };
}

/** pi 编排会话的扩展安装提示(检测不到扩展是否装了,每个插件进程只提示一次)。 */
let piExtensionHintShown = false;
function hintPiExtension(): void {
  if (piExtensionHintShown) return;
  piExtensionHintShown = true;
  console.warn(
    "[superagent] install the bundled pi extension to expose Superagent tools " +
      "(pi-extension/superagent.js -> ~/.pi/agent/extensions/, see README)",
  );
}

/** session_open 转换:编排 agent 注入各自角色工具;普通 agent 按设置注入委派工具。 */
export function createSessionOpenTransform(
  resolveEndpoint: () => SuperagentMcpEndpoint | null,
  enabled: () => boolean,
  providers: () => string[],
): (request: PluginSessionOpenRequest) => PluginSessionOpenRequest | undefined {
  return (request) => {
    const endpoint = resolveEndpoint();
    if (!endpoint) return undefined;
    if (request.mcpServers[DISPATCH_MCP_SERVER_NAME]) return undefined;
    const role = request.labels[ROUTER_LABEL];
    if (role === ROUTER_LABEL_VALUE || role === WATCHDOG_AGENT_LABEL_VALUE) return undefined;
    const ticketId = request.labels[TICKET_LABEL];
    if (ticketId) {
      const url = endpoint.workerUrl(ticketId);
      if (isPiProvider(request.provider)) {
        hintPiExtension();
        return piEnvRequest(request, url, "worker");
      }
      if (mcpCapableProvider(request.provider, providers())) {
        return {
          ...request,
          mcpServers: {
            ...request.mcpServers,
            [DISPATCH_MCP_SERVER_NAME]: { type: "http" as const, url, alwaysLoad: true },
          },
        };
      }
      return undefined;
    }
    if (!enabled()) return undefined;
    if (isOrchestrationAgent(request.labels)) return undefined;
    if (isPiProvider(request.provider)) {
      // 普通委派注入:pi 家族同样经 env(需在「注入 provider」里显式加 pi)。
      if (!providers().some((entry) => isPiProvider(entry))) return undefined;
      return piEnvRequest(request, endpoint.urlFor(request.agentId), null);
    }
    if (!providers().includes(request.provider)) return undefined;
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

/** 编排自身的 MCP 工具名(各 provider 的工具名形态不同:mcp__superagent__superagent_read 等)。 */
function isOrchestrationTool(name: string): boolean {
  return /(?:^|[^a-z0-9])superagent_(?:unsubscribe|handback)$/i.test(name);
}

export type OrchestrationPermission =
  | { behavior: "allow" }
  | { behavior: "deny"; message: string };

/**
 * 编排 agent 的权限策略(agent.permission.before):
 *   旧版 Router/看门狗挂起时拒绝新增工具权限，等待归档。
 *   Worker 的会话控制工具(退订/转回)放行,其余由引擎通知 Router 决策/转告人。
 * 返回 null 表示不干预。
 */
export function orchestrationPermission(
  role: "router" | "watchdog" | "worker" | null,
  request: { name: string; kind: string },
): OrchestrationPermission | null {
  if (!role) return null;
  const own = request.kind === "tool" && isOrchestrationTool(request.name);
  if (role === "worker") return own ? { behavior: "allow" } : null;
  return {
    behavior: "deny",
    message: role === "router"
      ? "The Router is decision-only: do not run tools. Answer with the JSON verdict; dispatch a Worker for anything that needs tools."
      : "The watchdog evaluates tickets through the inference API.",
  };
}
