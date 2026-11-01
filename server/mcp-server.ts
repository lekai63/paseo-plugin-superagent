import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { DispatchInput } from "./engine";

/**
 * superagent_dispatch 的自持 MCP 载体:插件进程内监听 127.0.0.1 的 Streamable HTTP endpoint。
 *
 * 为什么不走 defineAgentTool 的 tools 注入:daemon 把插件 agent tool 挂在 paseo 工具目录上
 * 分发,宿主关闭 "Paseo tools"(mcp.injectIntoAgents / mcp.enabled)时会连带给插件工具
 * 一起摘除。本模块自带 MCP server,经 session_open 的 mcpServers 注入,通道独立于该开关。
 *
 * 形态对齐 daemon 自身的 agent MCP 端点(/mcp/agents):stateless——每个 HTTP 请求新建
 * server+transport,响应关闭即回收,不保留跨请求状态。安全模型:仅绑 127.0.0.1,URL 带
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

/** 引擎的最小结构依赖,便于测试替身。 */
export interface DispatchMcpEngine {
  dispatch(input: DispatchInput): Promise<DispatchOutcome>;
}

export interface SuperagentMcpEndpoint {
  /** 指定 agent 会话的注入 URL(含密钥路径与 callerAgentId query)。 */
  urlFor(agentId: string): string;
  stop(): Promise<void>;
}

export const DISPATCH_TOOL_NAME = "superagent_dispatch";

const DISPATCH_TOOL_DESCRIPTION =
  "Delegate a task to the super-agent orchestrator. A router agent evaluates the request and a " +
  "dedicated worker agent executes it in an isolated workspace. The router's final answer is " +
  "delivered back into this conversation. Use for substantial, self-contained work " +
  "(implementation, investigation, review) that can run independently of this conversation.";

function registerDispatchTool(mcp: McpServer, engine: DispatchMcpEngine, callerAgentId: string | null): void {
  mcp.registerTool(
    DISPATCH_TOOL_NAME,
    {
      title: "Superagent 委派",
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

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text ? JSON.parse(text) : undefined;
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
    if (url.pathname !== path) {
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
    const callerAgentId = url.searchParams.get("callerAgentId");
    const body = await readJsonBody(req);
    const mcp = new McpServer({ name: "superagent-dispatch", version: "1.0.0" });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableDnsRebindingProtection: false,
    });
    transport.onerror = (error) => {
      console.error("[superagent] dispatch mcp transport error", error);
    };
    registerDispatchTool(mcp, engine, callerAgentId);
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  const port = await listen(server, host);
  let stopped = false;
  console.log(`[superagent] dispatch mcp listening on ${host}:${port}`);

  return {
    urlFor(agentId: string) {
      return `http://${host}:${port}${path}?callerAgentId=${encodeURIComponent(agentId)}`;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      await close(server);
    },
  };
}
