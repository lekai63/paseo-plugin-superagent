import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { z } from "zod";
import type { DispatchInput } from "./engine";
import { t } from "./i18n";

/**
 * 插件自持的编排 MCP 载体:进程内监听 127.0.0.1 的 Streamable HTTP endpoint。
 *
 * 为什么不走 defineAgentTool 的 tools 注入:daemon 把插件 agent tool 挂在 paseo 工具目录上
 * 分发,宿主关闭 "Paseo tools"(mcp.injectIntoAgents / mcp.enabled)时会连带给插件工具
 * 一起摘除。本模块自带 MCP server,经 session_open 的 mcpServers 注入,通道独立于该开关。
 *
 * 同一 endpoint 按调用方角色下发不同工具集(URL query 区分):
 *   普通 agent      superagent_dispatch(委派入口)
 *   Worker          superagent_unsubscribe / superagent_handback(退订与转回)
 * 工具集之外还按角色下发 server instructions:pi 家族经 Paseo 注入后 MCP 工具落
 * codemode 档(不声明给模型),pi 在系统提示的 mcp_servers 区段以 instructions
 * 首行描述该 server——它是 codemode 脚本世界里唯一的发现入口,故承载角色的
 * 完整调用说明(何时用、怎么调)。其他 provider 不受影响。
 *
 * SDK v2 的 createMcpHandler 同时服务 2026-07-28 与 legacy stateless 协议,每个请求
 * 创建独立的 MCP server,由 SDK 回收。安全模型:仅绑 127.0.0.1,URL 带
 * 进程生命周期内随机的路径段作为共享密钥;callerAgentId 经 query 传入,用于答复回投。
 *
 * 已知限制:插件重载后端口与密钥都会变化,已打开的 agent 会话里缓存的旧 URL 在下次
 * session_open 刷新前调用会失败(agent 侧表现为工具连接错误)。
 */

const MAX_BODY_BYTES = 1_000_000;

export type DispatchOutcome = {
  threadId: string;
  triggerId: string;
  directDelivered: boolean;
  note: string | null;
};

/** Worker 工具的统一出参:note 面向调用方模型,error 面向工具错误通道。 */
export type ToolOutcome = { ok: true; note: string } | { ok: false; error: string };

/** 引擎的最小结构依赖,便于测试替身;编排工具缺省时相应工具调用返回可读错误。 */
export interface DispatchMcpEngine {
  dispatch(input: DispatchInput): Promise<DispatchOutcome>;
  /** Worker 退订:停止线程后续事件直通该 Worker(按票据定位,与 URL 一致);给出 threadId 只退该线程。 */
  workerUnsubscribe?(ticketId: string, threadId?: string): Promise<ToolOutcome>;
  /** Worker 转回:把不该由它处理的消息作为待评估触发交回 Router。 */
  workerHandback?(ticketId: string, text: string, options?: { unsubscribe?: boolean }): Promise<ToolOutcome>;
}

export interface SuperagentMcpEndpoint {
  /** 普通 agent 会话的注入 URL(含密钥路径与 callerAgentId query)。 */
  urlFor(agentId: string): string;
  /** Worker 会话的注入 URL(角色工具按票据定位)。 */
  workerUrl(ticketId: string): string;
  stop(): Promise<void>;
}

/** 注入的 MCP server 名。不能叫 `paseo`(daemon 保留名),也应避开常见自定义名。 */
export const DISPATCH_MCP_SERVER_NAME = "superagent";

export const DISPATCH_TOOL_NAME = "superagent_dispatch";
export const UNSUBSCRIBE_TOOL_NAME = "superagent_unsubscribe";
export const HANDBACK_TOOL_NAME = "superagent_handback";

const DISPATCH_TOOL_DESCRIPTION =
  "Delegate a task to the super-agent orchestrator. A router agent evaluates the request and a " +
  "dedicated worker agent executes it in an isolated workspace. The router's final answer is " +
  "delivered back into this conversation. Use for substantial, self-contained work " +
  "(implementation, investigation, review) that can run independently of this conversation.";

/**
 * 按角色的 server instructions(pi 的 codemode 档以首行作为 mcp_servers 列表描述,
 * 故首行必须是自含的一句总览;正文给出调用时机与方式,随 tools/list 一并下发)。
 */
const DISPATCH_INSTRUCTIONS = [
  "Delegate substantial, self-contained work (implementation, investigation, review) to the super-agent orchestrator:",
  "the router evaluates the request and a dedicated worker executes it in an isolated workspace;",
  "the router's final answer is delivered back into this conversation.",
  "Call the tool superagent_dispatch with {title, task}; task must be complete and self-contained.",
].join(" ");

const WORKER_INSTRUCTIONS = [
  "Session control for the super-agent orchestration layer (your ticket):",
  "superagent_unsubscribe — stop routing future follow-up messages directly to you; the Router evaluates them instead.",
  "Call it when later messages are no longer yours to answer (for example a one-shot task once its report is delivered);",
  "pass {threadId} to leave only one followed conversation.",
  "superagent_handback — return a message you received to the Router because it belongs elsewhere",
  "(off-topic for your ticket, another worker's domain, or needs a human-facing reply);",
  "call it with {text, unsubscribe} quoting or summarizing the message, then continue with your own ticket.",
].join(" ");

function registerDispatchTool(mcp: McpServer, engine: DispatchMcpEngine, callerAgentId: string | null): void {
  mcp.registerTool(
    DISPATCH_TOOL_NAME,
    {
      title: t("server.mcp.dispatchTitle"),
      description: DISPATCH_TOOL_DESCRIPTION,
      inputSchema: z.object({
        title: z.string().min(1).max(120).describe("Short task title"),
        task: z.string().min(1).max(16000).describe("Complete, self-contained task description"),
      }),
    },
    async ({ title, task }) => {
      try {
        const result = await engine.dispatch({
          title,
          task,
          kind: "agent",
          sender: callerAgentId ? `agent:${callerAgentId}` : "agent",
          replyToAgentId: callerAgentId ?? undefined,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: result.directDelivered
                ? `Delivered directly to the subscribed worker on thread ${result.threadId}.`
                : `Queued on thread ${result.threadId}; the router will evaluate it shortly.`,
            },
          ],
          structuredContent: result,
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `superagent dispatch failed: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  );
}

/** 统一的错误文本内容(工具调用异常时不抛出,交 isError 通道)。 */
function toolError(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

type ToolText = { type: "text"; text: string };
type ToolResult = { isError?: boolean; content: ToolText[] };

/** Worker 的会话控制工具:退订直通与消息转回。 */
function registerWorkerTools(mcp: McpServer, engine: DispatchMcpEngine, ticketId: string): void {
  mcp.registerTool(
    UNSUBSCRIBE_TOOL_NAME,
    {
      title: t("server.mcp.unsubscribeTitle"),
      description:
        "Stop delivering future follow-up messages directly into your session; the Router evaluates them " +
        "again instead. Call this once further messages are no longer yours to answer (for example a " +
        "one-shot task whose report has been delivered). Without `threadId` you leave every conversation " +
        "you follow; with it (the thr_… id from a \"[thread …]\" prefix) only that one. Your current turn " +
        "is not affected.",
      inputSchema: z.object({
        threadId: z.string().min(3).max(80).optional().describe("Leave only this followed thread (thr_…)"),
      }),
    },
    async ({ threadId }) => {
      if (!engine.workerUnsubscribe) return toolError(`${UNSUBSCRIBE_TOOL_NAME} is not available`);
      try {
        const outcome = await engine.workerUnsubscribe(ticketId, threadId);
        return outcome.ok
          ? { content: [{ type: "text" as const, text: outcome.note }] }
          : toolError(outcome.error);
      } catch (error) {
        return toolError(`${UNSUBSCRIBE_TOOL_NAME} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );
  mcp.registerTool(
    HANDBACK_TOOL_NAME,
    {
      title: t("server.mcp.handbackTitle"),
      description:
        "Return a message you received to the Router because it should not be handled by you: it is " +
        "off-topic for your ticket, belongs to a different worker, or needs a human-facing reply. Quote or " +
        "summarize the message in `text` (add a routing hint if you have one); the Router re-routes it. " +
        "Set `unsubscribe` to also stop future direct deliveries to your session.",
      inputSchema: z.object({
        text: z.string().min(1).max(8000).describe("The returned message (quote or summarize), plus any routing hint"),
        unsubscribe: z.boolean().optional().describe("Also stop future direct deliveries to this session"),
      }),
    },
    async ({ text, unsubscribe }) => {
      if (!engine.workerHandback) return toolError(`${HANDBACK_TOOL_NAME} is not available`);
      try {
        const outcome = await engine.workerHandback(ticketId, text, { unsubscribe });
        return outcome.ok
          ? { content: [{ type: "text" as const, text: outcome.note }] }
          : toolError(outcome.error);
      } catch (error) {
        return toolError(`${HANDBACK_TOOL_NAME} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );
}

/** 按 URL 角色选择工具集与 instructions:role=worker&ticket=…,缺省为普通委派。 */
function registerToolsFor(
  mcp: McpServer,
  engine: DispatchMcpEngine,
  caller: { agentId: string | null; role: "worker" | null; ticketId: string | null },
): void {
  if (caller.role === "worker" && caller.ticketId) {
    registerWorkerTools(mcp, engine, caller.ticketId);
    return;
  }
  registerDispatchTool(mcp, engine, caller.agentId);
}

function listen(server: Server, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      server.off("error", reject);
      const address = server.address();
      if (address == null || typeof address === "string") {
        reject(new Error("unexpected listener address"));
        return;
      }
      resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    // keep-alive 空闲连接会阻止 close 回调,强制断开。
    server.closeAllConnections();
  });
}

export async function startDispatchMcpServer(
  engine: DispatchMcpEngine,
  options: { host?: string } = {},
): Promise<SuperagentMcpEndpoint> {
  const host = options.host ?? "127.0.0.1";
  const secret = randomBytes(24).toString("hex");
  const path = `/${secret}/mcp`;
  const onerror = (error: Error) => console.error("[superagent] dispatch mcp transport error", error);
  const handler = createMcpHandler(({ requestInfo }) => {
    if (!requestInfo) throw new Error("MCP HTTP request context is missing");
    const url = new URL(requestInfo.url);
    const roleParam = url.searchParams.get("role");
    const role: "worker" | null = roleParam === "worker" ? roleParam : null;
    const caller: { agentId: string | null; role: "worker" | null; ticketId: string | null } = {
      agentId: url.searchParams.get("callerAgentId"),
      role,
      ticketId: role === "worker" ? url.searchParams.get("ticket") : null,
    };
    const mcp = new McpServer(
      { name: "superagent-dispatch", version: "1.0.0" },
      { instructions: caller.role === "worker" ? WORKER_INSTRUCTIONS : DISPATCH_INSTRUCTIONS },
    );
    registerToolsFor(mcp, engine, caller);
    return mcp;
  }, { legacy: "stateless", maxRequestBodySize: MAX_BODY_BYTES, onerror });
  const serveMcp = toNodeHandler(handler, { maxRequestBodySize: MAX_BODY_BYTES, onerror });
  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((error) => {
      console.error("[superagent] dispatch mcp request failed", error);
      if (!res.headersSent) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32700, message: "Parse error" },
            id: null,
          }),
        );
      } else {
        res.end();
      }
    });
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${host}`);
    if (url.pathname !== path || (url.searchParams.has("role") && url.searchParams.get("role") !== "worker")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    // Stateless:GET(SSE 流)与 DELETE(会话终止)没有会话语义;MCP client 容忍 405。
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed" },
          id: null,
        }),
      );
      return;
    }
    await serveMcp(req, res);
  }

  const port = await listen(server, host);
  let stopped = false;
  console.log(`[superagent] dispatch mcp listening on ${host}:${port}`);

  return {
    urlFor(agentId: string) {
      return `http://${host}:${port}${path}?callerAgentId=${encodeURIComponent(agentId)}`;
    },
    workerUrl(ticketId: string) {
      return `http://${host}:${port}${path}?role=worker&ticket=${encodeURIComponent(ticketId)}`;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      try {
        await handler.close();
      } finally {
        await close(server);
      }
    },
  };
}
