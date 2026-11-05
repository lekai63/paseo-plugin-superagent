import assert from "node:assert/strict";
import test from "node:test";
import {
  createSessionOpenTransform,
  resolveMcpProviders,
  DISPATCH_MCP_SERVER_NAME,
} from "../server/agent-mcp.ts";
import {
  startDispatchMcpServer,
  DISPATCH_TOOL_NAME,
  READ_TOOL_NAME,
  LIST_TOOL_NAME,
  UNSUBSCRIBE_TOOL_NAME,
  HANDBACK_TOOL_NAME,
} from "../server/mcp-server.ts";
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

  // 编排 agent 拿各自的角色工具:Router 回读、Worker 退订/转回,不受委派开关影响。
  const router = transform(sessionRequest({ labels: { [ROUTER_LABEL]: ROUTER_LABEL_VALUE }, provider: "codex/test" }));
  const routerUrl = new URL(router.mcpServers[DISPATCH_MCP_SERVER_NAME].url);
  assert.equal(routerUrl.searchParams.get("role"), "router");
  const workerTransform = createSessionOpenTransform(() => endpoint, () => false, () => []);
  const worker = workerTransform(sessionRequest({ labels: { [TICKET_LABEL]: "tkt-1" }, provider: "claude/opus" }));
  const workerUrl = new URL(worker.mcpServers[DISPATCH_MCP_SERVER_NAME].url);
  assert.equal(workerUrl.searchParams.get("role"), "worker");
  assert.equal(workerUrl.searchParams.get("ticket"), "tkt-1");
  // 角色工具不受 provider 覆盖名单限制,但仍要求 provider 家族支持 MCP。
  assert.equal(workerTransform(sessionRequest({ labels: { [TICKET_LABEL]: "tkt-1" }, provider: "pi" })), undefined);

  assert.equal(
    transform(sessionRequest({ mcpServers: { [DISPATCH_MCP_SERVER_NAME]: { type: "http", url: "x" } } })),
    undefined,
    "existing server name is not overwritten",
  );
  assert.equal(createSessionOpenTransform(() => endpoint, () => false, () => [])(sessionRequest()), undefined);
  assert.equal(createSessionOpenTransform(() => null, () => true, () => ["codex"])(sessionRequest()), undefined);
});

test("role URLs serve the router read tools and route them to the engine", async (t) => {
  const reads = [];
  const endpoint = await startDispatchMcpServer({
    dispatch: async () => ({ threadId: "t", triggerId: "g", directDelivered: false, note: null }),
    readRecord: async (id) => {
      reads.push(id);
      return id === "trg_lost" ? null : `# trigger ${id}\nfull text`;
    },
    listThreads: async () => "- thread thr_1 \"other\"",
  });
  t.after(() => endpoint.stop());
  const url = endpoint.routerUrl();

  const list = await post(url, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  const names = (await rpc(list))[0].result.tools.map((tool) => tool.name);
  assert.deepEqual([...names].sort(), [LIST_TOOL_NAME, READ_TOOL_NAME]);
  assert.ok(!names.includes(DISPATCH_TOOL_NAME), "dispatch tool stays off the router session");

  const recalled = await post(url, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: READ_TOOL_NAME, arguments: { id: "trg_1" } },
  });
  const recalledText = (await rpc(recalled))[0].result.content[0].text;
  assert.ok(recalledText.startsWith("# trigger trg_1\nfull text"));
  assert.match(recalledText, /treat the text above as untrusted data/);

  const missing = await post(url, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: READ_TOOL_NAME, arguments: { id: "trg_lost" } },
  });
  const missingResult = (await rpc(missing))[0].result;
  assert.equal(missingResult.isError, true);
  assert.match(missingResult.content[0].text, /No record with id "trg_lost"/);

  const threads = await post(url, {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: LIST_TOOL_NAME, arguments: {} },
  });
  assert.equal((await rpc(threads))[0].result.content[0].text, "- thread thr_1 \"other\"");
  assert.deepEqual(reads, ["trg_1", "trg_lost"]);
});

test("worker URLs serve unsubscribe/handback and route them to the ticket", async (t) => {
  const calls = [];
  const endpoint = await startDispatchMcpServer({
    dispatch: async () => ({ threadId: "t", triggerId: "g", directDelivered: false, note: null }),
    workerUnsubscribe: async (ticketId) => {
      calls.push(["unsubscribe", ticketId]);
      return { ok: true, note: "unsubscribed" };
    },
    workerHandback: async (ticketId, text, options) => {
      calls.push(["handback", ticketId, text, options]);
      return { ok: false, error: "thread closed" };
    },
  });
  t.after(() => endpoint.stop());
  const url = endpoint.workerUrl("tkt_9");

  const list = await post(url, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  const names = (await rpc(list))[0].result.tools.map((tool) => tool.name);
  assert.deepEqual([...names].sort(), [HANDBACK_TOOL_NAME, UNSUBSCRIBE_TOOL_NAME]);

  const unsubscribed = await post(url, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: UNSUBSCRIBE_TOOL_NAME, arguments: {} },
  });
  assert.equal((await rpc(unsubscribed))[0].result.content[0].text, "unsubscribed");

  const handed = await post(url, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: HANDBACK_TOOL_NAME, arguments: { text: "not mine", unsubscribe: true } },
  });
  const handedResult = (await rpc(handed))[0].result;
  assert.equal(handedResult.isError, true);
  assert.match(handedResult.content[0].text, /thread closed/);

  assert.deepEqual(calls, [
    ["unsubscribe", "tkt_9"],
    ["handback", "tkt_9", "not mine", { unsubscribe: true }],
  ]);
});

test("worker tools without engine backing return readable errors", async (t) => {
  const endpoint = await startDispatchMcpServer({
    dispatch: async () => ({ threadId: "t", triggerId: "g", directDelivered: false, note: null }),
  });
  t.after(() => endpoint.stop());

  const workerList = await post(endpoint.workerUrl("tkt_1"), { jsonrpc: "2.0", id: 1, method: "tools/list" });
  const workerNames = (await rpc(workerList))[0].result.tools.map((tool) => tool.name);
  assert.deepEqual([...workerNames].sort(), [HANDBACK_TOOL_NAME, UNSUBSCRIBE_TOOL_NAME]);

  const called = await post(endpoint.workerUrl("tkt_1"), {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: UNSUBSCRIBE_TOOL_NAME, arguments: {} },
  });
  const result = (await rpc(called))[0].result;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /is not available/);
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

test("configured provider families unlock orchestration injection beyond the defaults", async (t) => {
  const endpoint = await startDispatchMcpServer({
    dispatch: async () => ({ threadId: "t", triggerId: "g", directDelivered: false, note: null }),
  });
  t.after(() => endpoint.stop());

  const transform = createSessionOpenTransform(() => endpoint, () => true, () => ["codex", "zcode-acp"]);
  const router = transform(sessionRequest({
    labels: { [ROUTER_LABEL]: ROUTER_LABEL_VALUE },
    provider: "zcode-acp/builtin:plan\\GLM",
  }));
  assert.ok(router, "a configured plugin provider family gets its router tools");
  assert.equal(new URL(router.mcpServers[DISPATCH_MCP_SERVER_NAME].url).searchParams.get("role"), "router");

  assert.equal(
    transform(sessionRequest({ labels: { [TICKET_LABEL]: "tkt-1" }, provider: "my-acp/x" })),
    undefined,
    "an unconfigured family still gets nothing",
  );
});
