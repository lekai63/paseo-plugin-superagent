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
 * 注入按调用方分三档:普通 agent 拿 superagent_dispatch(受设置开关控制);编排自身的
 * Router 拿回读工具、Worker 拿退订/转回工具(编排内部机制,不受设置开关控制)。
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
 * 编排 agent(Router/Worker)的 provider 门控:provider 可能带 model 限定
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
 * 会以默认 codemode 暴露(模型不能直接调用)。改经 env 把角色 URL 交给随插件发行的
 * pi 扩展注册(direct exposure),Router/看门狗并由扩展裁剪工具(只裁决)。扩展未
 * 安装时 env 无副作用:会话照常,只是没有角色工具与硬约束。
 */
function piEnvRequest(
  request: PluginSessionOpenRequest,
  url: string,
  role: "router" | "watchdog" | "worker" | null,
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
    "[superagent] pi orchestration session: install the bundled pi extension for role tools and " +
      "decision-only enforcement (pi-extension/superagent.js -> ~/.pi/agent/extensions/, see README)",
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
    const role: "router" | "watchdog" | "worker" | null =
      request.labels[ROUTER_LABEL] === ROUTER_LABEL_VALUE
        ? "router"
        : request.labels[ROUTER_LABEL] === WATCHDOG_AGENT_LABEL_VALUE
          ? "watchdog"
          : request.labels[TICKET_LABEL]
            ? "worker"
            : null;
    // Router/Worker 的角色工具是编排自身机制:不受 agentToolEnabled 影响,但同样
    // 只注入声明支持 MCP servers 的 provider 家族(默认名单 ∪ 用户配置,否则会话启动失败);
    // pi 家族改走 env + pi 扩展(扩展负责 direct exposure 注册与只裁决裁剪)。
    if (role) {
      const url = role === "worker" ? endpoint.workerUrl(request.labels[TICKET_LABEL]) : endpoint.routerUrl(request.agentId);
      if (isPiProvider(request.provider)) {
        hintPiExtension();
        return piEnvRequest(request, url, role);
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
  return /(?:^|[^a-z0-9])superagent_(?:read|list|search|unsubscribe|handback)$/i.test(name) || /^superagent_[a-z]+$/i.test(name);
}

export type OrchestrationPermission =
  | { behavior: "allow" }
  | { behavior: "deny"; message: string };

/**
 * 编排 agent 的权限策略(agent.permission.before):
 *   Router/看门狗只裁决不执行(§2.1 "甚至可以不配备 Bash")——自身的只读回读工具放行,
 *   其余工具、计划与模式切换一律拒绝,避免 Router 停在权限等待里堵住评估队列;
 *   Worker 的会话控制工具(退订/转回)放行,其余由引擎通知 Router 决策/转告人。
 * 返回 null 表示不干预。
 */
export function orchestrationPermission(
  role: "router" | "watchdog" | "worker" | null,
  request: { name: string; kind: string },
): OrchestrationPermission | null {
  if (!role) return null;
  const own = request.kind === "tool" && isOrchestrationTool(request.name);
  if (own) return { behavior: "allow" };
  if (role === "worker") return null;
  return {
    behavior: "deny",
    message: role === "router"
      ? "The Router is decision-only: do not run tools. Answer with the JSON verdict; dispatch a Worker for anything that needs tools."
      : "The Watchdog acts only through its JSON actions; apart from the superagent recall tools it does not run tools.",
  };
}
