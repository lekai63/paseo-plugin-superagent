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
 * 所有 MCP 能力的 provider(含 pi 家族)走同一条 mcpServers 注入:pi 侧 MCP 工具
 * 以 pi 默认的 codemode 档暴露(经 codemode 脚本按需调用),server instructions
 * 承载角色说明,遵从 pi 的懒加载设计。
 */

/** 注入的 MCP server 名(定义在 mcp-server;不能叫 `paseo`,daemon 保留名)。 */
export { DISPATCH_MCP_SERVER_NAME } from "./mcp-server";

/**
 * 默认注入的 provider:已知声明 supportsMcpServers 的内置 provider。其余(ACP 系
 * cursor/kimi/kiro/trae、未来的未知 provider)注入会让会话启动直接失败,故跳过;
 * 可用设置 agentToolProviders 覆盖(增删任意 provider id,含 pi)。
 */
const DEFAULT_MCP_PROVIDERS = ["claude", "codex", "opencode", "omp", "copilot"];

/**
 * Worker 角色工具的家族门控:默认名单 ∪ 用户配置 ∪ pi。pi 是受支持的 Worker
 * provider(pi ≥ 1.5 自带 MCP,daemon 探测到后经内置通道注入),不依赖「注入
 * provider」那份名单——它只管普通会话的委派注入(pi 默认不含在内,需显式 opt-in,
 * 避免在老 pi 主机上弄坏用户自己的交互式会话)。
 */
const WORKER_MCP_EXTRA_FAMILIES = ["pi"];

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
      if (mcpCapableProvider(request.provider, [...providers(), ...WORKER_MCP_EXTRA_FAMILIES])) {
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
