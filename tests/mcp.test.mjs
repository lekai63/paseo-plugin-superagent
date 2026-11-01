import assert from "node:assert/strict";
import test from "node:test";
import {
  createSessionOpenTransform,
  resolveMcpProviders,
  DISPATCH_MCP_SERVER_NAME,
} from "../server/agent-mcp.ts";
import { startDispatchMcpServer, DISPATCH_TOOL_NAME } from "../server/mcp-server.ts";
import { ROUTER_LABEL, ROUTER_LABEL_VALUE, TICKET_LABEL } from "../server/router.ts";

/** 响应为 SSE(data: 行)或纯 JSON,统一解析出 JSON-RPC 报文数组。 */
async function rpc(res) {
  const text = await res.text();
  const data = text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());
  if (data.length > 0) return data.map((line) => JSON.parse(line));
  return [JSON.parse(text)];
}

async function post(url, payload) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(payload),
  });
}

function sessionRequest(overrides = {}) {
  return {
    agentId: "agent-1",
    workspaceId: null,
    provider: "codex",
    cwd: "/repo",
    reason: "create",
    purpose: "interactive",
    title: null,
    labels: {},
    tools: [],
    env: {},
    mcpServers: {},
    ...overrides,
  };
}

test("dispatch mcp endpoint serves initialize/list/call and routes replies", async (t) => {
  const dispatched = [];
  const endpoint = await startDispatchMcpServer({
    dispatch: async (input) => {
      dispatched.push(input);
      if (input.task === "explode") throw new Error("router offline");
      return {
        threadId: "thr-1",
        triggerId: "trg-1",
        directDelivered: input.task === "direct",
        note: null,
      };
    },
  });
  t.after(() => endpoint.stop());
  const url = endpoint.urlFor("agent-42");

  // 密钥路径错误 → 404;非 POST → 405。
  const wrongPath = new URL(url);
  wrongPath.pathname = "/not-the-secret/mcp";
  assert.equal((await fetch(wrongPath, { method: "POST" })).status, 404);
  assert.equal((await fetch(url, { method: "GET" })).status, 405);

  const init = await post(url, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
  });
  assert.equal(init.status, 200);
  assert.equal((await rpc(init))[0].result.serverInfo.name, "superagent-dispatch");

  const list = await post(url, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  const listed = (await rpc(list))[0].result.tools;
  const tool = listed.find((entry) => entry.name === DISPATCH_TOOL_NAME);
  assert.ok(tool, "superagent_dispatch listed");
  assert.equal(tool.title, "Superagent 委派");
  assert.ok(tool.inputSchema.properties.task);

  const call = await post(url, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: DISPATCH_TOOL_NAME, arguments: { title: "Fix CORS", task: "fix it" } },
  });
  const called = (await rpc(call))[0].result;
  assert.equal(called.isError, undefined);
  assert.match(called.content[0].text, /Queued on thread thr-1/);
  assert.equal(called.structuredContent.threadId, "thr-1");
  assert.equal(dispatched[0].kind, "agent");
  assert.equal(dispatched[0].replyToAgentId, "agent-42");
  assert.equal(dispatched[0].sender, "agent:agent-42");

  const direct = await post(url, {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: DISPATCH_TOOL_NAME, arguments: { title: "Follow-up", task: "direct" } },
  });
  assert.match((await rpc(direct))[0].result.content[0].text, /Delivered directly/);

  const failure = await post(url, {
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: DISPATCH_TOOL_NAME, arguments: { title: "Boom", task: "explode" } },
  });
  const failed = (await rpc(failure))[0].result;
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /superagent dispatch failed: router offline/);
});

test("session_open transform injects the endpoint for allowed providers only", async (t) => {
  const endpoint = await startDispatchMcpServer({
    dispatch: async () => ({ threadId: "t", triggerId: "g", directDelivered: false, note: null }),
  });
  t.after(() => endpoint.stop());

  const transform = createSessionOpenTransform(
    () => endpoint,
    () => true,
    () => resolveMcpProviders(""),
  );

  const transformed = transform(sessionRequest());
  const injected = transformed?.mcpServers[DISPATCH_MCP_SERVER_NAME];
  assert.ok(injected, "server injected");
  assert.equal(injected.type, "http");
  assert.equal(injected.alwaysLoad, true);
  assert.equal(new URL(injected.url).searchParams.get("callerAgentId"), "agent-1");
  assert.deepEqual(transformed.tools, []);

  assert.equal(transform(sessionRequest({ provider: "pi" })), undefined, "pi has no MCP support");
  assert.equal(
    transform(sessionRequest({ labels: { [ROUTER_LABEL]: ROUTER_LABEL_VALUE } })),
    undefined,
    "router agent is not injected",
  );
  assert.equal(
    transform(sessionRequest({ labels: { [TICKET_LABEL]: "tkt-1" } })),
    undefined,
    "worker agent is not injected",
  );
  assert.equal(
    transform(sessionRequest({ mcpServers: { [DISPATCH_MCP_SERVER_NAME]: { type: "http", url: "x" } } })),
    undefined,
    "existing server name is not overwritten",
  );
  assert.equal(createSessionOpenTransform(() => endpoint, () => false, () => [])(sessionRequest()), undefined);
  assert.equal(createSessionOpenTransform(() => null, () => true, () => ["codex"])(sessionRequest()), undefined);
});

test("provider allowlist: defaults vs configured override", () => {
  const defaults = resolveMcpProviders("");
  for (const provider of ["claude", "codex", "opencode", "omp", "copilot"]) {
    assert.ok(defaults.includes(provider), `${provider} in defaults`);
  }
  assert.ok(!defaults.includes("pi"));

  const custom = resolveMcpProviders("claude, my-plugin， opencode ");
  assert.deepEqual(custom, ["claude", "my-plugin", "opencode"]);

  const transform = createSessionOpenTransform(
    () => ({ urlFor: (id) => `http://x/${id}`, stop: async () => {} }),
    () => true,
    () => custom,
  );
  assert.ok(transform(sessionRequest({ provider: "my-plugin" })));
  assert.equal(transform(sessionRequest({ provider: "codex" })), undefined, "codex excluded by override");
});
