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
  UNSUBSCRIBE_TOOL_NAME,
  HANDBACK_TOOL_NAME,
} from "../server/mcp-server.ts";
import { ROUTER_LABEL, ROUTER_LABEL_VALUE, TICKET_LABEL } from "../server/router.ts";
import { WATCHDOG_AGENT_LABEL_VALUE } from "../shared/model.ts";

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

async function post(url, payload, headers = {}) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(payload),
  });
}

function modernPost(url, payload) {
  return post(url, {
    ...payload,
    params: {
      ...payload.params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "superagent-test", version: "1.0.0" },
        "io.modelcontextprotocol/clientCapabilities": {},
        ...payload.params?._meta,
      },
    },
  }, {
    "MCP-Protocol-Version": "2026-07-28",
    "Mcp-Method": payload.method,
    ...(payload.params?.name ? { "Mcp-Name": payload.params.name } : {}),
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
  const initResult = (await rpc(init))[0].result;
  assert.equal(initResult.serverInfo.name, "superagent-dispatch");
  // instructions 按 URL 角色下发(pi 的 codemode 档以它作 mcp_servers 描述)。
  const instructions = initResult.instructions ?? "";
  assert.match(instructions, /superagent_dispatch/);
  assert.doesNotMatch(instructions, /superagent_unsubscribe/, "dispatch sessions never see worker instructions");
  const workerInit = await post(endpoint.workerUrl("tkt-1"), {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
  });
  const workerInstructions = ((await rpc(workerInit))[0].result.instructions) ?? "";
  assert.match(workerInstructions, /superagent_unsubscribe/);
  assert.match(workerInstructions, /superagent_handback/);

  const list = await post(url, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  const listed = (await rpc(list))[0].result.tools;
  const tool = listed.find((entry) => entry.name === DISPATCH_TOOL_NAME);
  assert.ok(tool, "superagent_dispatch listed");
  assert.equal(tool.title, "Superagent Dispatch");
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

test("2026-07-28 discovery, tool listing and dispatch work without initialize", async t => {
  const calls = [];
  const endpoint = await startDispatchMcpServer({ dispatch: async input => {
    calls.push(input);
    if (input.task === "fail") throw new Error("engine unavailable");
    return { threadId: "thr-modern", triggerId: "trg-modern", directDelivered: false, note: null };
  } });
  t.after(() => endpoint.stop());
  const url = endpoint.urlFor("modern-caller");
  const discover = await modernPost(url, { jsonrpc: "2.0", id: 1, method: "server/discover" });
  assert.equal(discover.status, 200);
  const discovered = (await rpc(discover))[0].result;
  assert.ok(discovered.supportedVersions.includes("2026-07-28"));
  assert.equal(discovered._meta["io.modelcontextprotocol/serverInfo"].name, "superagent-dispatch");
  const list = await modernPost(url, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.equal(list.status, 200);
  assert.deepEqual((await rpc(list))[0].result.tools.map(tool => tool.name), [DISPATCH_TOOL_NAME]);
  const call = await modernPost(url, { jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: DISPATCH_TOOL_NAME, arguments: { title: "Modern task", task: "do it" } } });
  assert.equal(call.status, 200);
  assert.equal((await rpc(call))[0].result.structuredContent.threadId, "thr-modern");
  assert.equal(calls[0].replyToAgentId, "modern-caller");
  const failure = await modernPost(url, { jsonrpc: "2.0", id: 4, method: "tools/call",
    params: { name: DISPATCH_TOOL_NAME, arguments: { title: "Fail", task: "fail" } } });
  const result = (await rpc(failure))[0].result;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /engine unavailable/);
});

test("modern Worker tools preserve role and ticket isolation", async t => {
  const calls = [];
  const endpoint = await startDispatchMcpServer({
    dispatch: async () => assert.fail("Worker tools must not dispatch"),
    workerUnsubscribe: async (ticket, thread) => { calls.push(["unsubscribe", ticket, thread]); return { ok: true, note: "left thread" }; },
    workerHandback: async (ticket, text) => { calls.push(["handback", ticket, text]); return { ok: false, error: "cannot hand back" }; },
  });
  t.after(() => endpoint.stop());
  const list = await modernPost(endpoint.workerUrl("tkt-modern"), { jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(list.status, 200);
  assert.deepEqual((await rpc(list))[0].result.tools.map(tool => tool.name).sort(), [HANDBACK_TOOL_NAME, UNSUBSCRIBE_TOOL_NAME]);
  const retired = new URL(endpoint.urlFor("legacy-router"));
  retired.searchParams.set("role", "router");
  assert.equal((await modernPost(retired, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status, 404);
  const unsubscribe = await modernPost(endpoint.workerUrl("tkt-modern"), { jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: UNSUBSCRIBE_TOOL_NAME, arguments: { threadId: "thr-followed" } } });
  assert.equal((await rpc(unsubscribe))[0].result.content[0].text, "left thread");
  const handback = await modernPost(endpoint.workerUrl("tkt-other"), { jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: HANDBACK_TOOL_NAME, arguments: { text: "not mine" } } });
  assert.equal((await rpc(handback))[0].result.isError, true);
  assert.deepEqual(calls, [["unsubscribe", "tkt-modern", "thr-followed"], ["handback", "tkt-other", "not mine"]]);
});

test("concurrent modern and legacy calls with reused RPC IDs keep callers separate", async t => {
  const callers = [];
  const endpoint = await startDispatchMcpServer({ dispatch: async input => {
    callers.push(input.replyToAgentId);
    return { threadId: input.replyToAgentId, triggerId: "g", directDelivered: false, note: null };
  } });
  t.after(() => endpoint.stop());
  const replies = await Promise.all(Array.from({ length: 8 }, async (_, index) => {
    const caller = `agent-${index}`;
    const request = { jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: DISPATCH_TOOL_NAME, arguments: { title: caller, task: "work" } } };
    const response = index % 2 ? await modernPost(endpoint.urlFor(caller), request)
      : await post(endpoint.urlFor(caller), request, { "MCP-Protocol-Version": "2025-11-25" });
    assert.equal(response.status, 200);
    return (await rpc(response))[0].result.structuredContent.threadId;
  }));
  assert.deepEqual(replies, Array.from({ length: 8 }, (_, index) => `agent-${index}`));
  assert.equal(new Set(callers).size, 8);
});

test("modern requests reject mismatched envelopes and unknown versions before executing tools", async t => {
  let calls = 0;
  const endpoint = await startDispatchMcpServer({ dispatch: async () => { calls++; return {}; } });
  t.after(() => endpoint.stop());
  const url = endpoint.urlFor("caller");
  const missingEnvelope = await post(url, { jsonrpc: "2.0", id: 1, method: "tools/list" }, {
    "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/list",
  });
  assert.equal(missingEnvelope.status, 400);
  assert.equal((await rpc(missingEnvelope))[0].error.code, -32602);
  const mismatch = await modernPost(url, { jsonrpc: "2.0", id: 2, method: "tools/list",
    params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2099-01-01" } } });
  assert.equal(mismatch.status, 400);
  assert.equal((await rpc(mismatch))[0].error.code, -32020);
  const unknown = await post(url, { jsonrpc: "2.0", id: 3, method: "tools/list", params: { _meta: {
    "io.modelcontextprotocol/protocolVersion": "2099-01-01", "io.modelcontextprotocol/clientCapabilities": {},
  } } }, { "MCP-Protocol-Version": "2099-01-01", "Mcp-Method": "tools/list" });
  assert.equal(unknown.status, 400);
  assert.equal((await rpc(unknown))[0].error.code, -32022);
  assert.equal(calls, 0);
});

test("v2 preserves the secret path, method guards, parse errors and one-megabyte body limit", async t => {
  let calls = 0;
  const endpoint = await startDispatchMcpServer({ dispatch: async () => { calls++; return {}; } });
  t.after(() => endpoint.stop());
  const url = endpoint.urlFor("caller");
  const wrong = new URL(url);
  wrong.pathname = "/wrong/mcp";
  assert.equal((await modernPost(wrong, { jsonrpc: "2.0", id: 1, method: "server/discover" })).status, 404);
  assert.equal((await fetch(url, { method: "DELETE" })).status, 405);
  const invalid = await fetch(url, { method: "POST", headers: {
    "content-type": "application/json", accept: "application/json, text/event-stream",
  }, body: "{" });
  assert.equal(invalid.status, 400);
  assert.equal((await rpc(invalid))[0].error.code, -32700);
  const oversized = await post(url, { jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: DISPATCH_TOOL_NAME, arguments: { title: "large", task: "x".repeat(1_000_001) } } });
  assert.equal(oversized.status, 413);
  assert.equal(calls, 0);
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

  assert.equal(transform(sessionRequest({ provider: "pi" })), undefined, "pi dispatch needs explicit opt-in (not in default providers)");

  assert.equal(transform(sessionRequest({ labels: { [ROUTER_LABEL]: ROUTER_LABEL_VALUE }, provider: "codex/test" })), undefined);
  const workerTransform = createSessionOpenTransform(() => endpoint, () => false, () => []);
  const worker = workerTransform(sessionRequest({ labels: { [TICKET_LABEL]: "tkt-1" }, provider: "claude/opus" }));
  const workerUrl = new URL(worker.mcpServers[DISPATCH_MCP_SERVER_NAME].url);
  assert.equal(workerUrl.searchParams.get("role"), "worker");
  assert.equal(workerUrl.searchParams.get("ticket"), "tkt-1");
  // 角色工具不受 provider 覆盖名单限制,但仍要求 provider 家族支持 MCP。
  // pi 家族同走标准 mcpServers 注入(工具以 pi 的 codemode 档暴露),不再有 env 例外通道。
  const piWorker = workerTransform(sessionRequest({ labels: { [TICKET_LABEL]: "tkt-1" }, provider: "pi/glm" }));
  assert.equal(
    piWorker.mcpServers[DISPATCH_MCP_SERVER_NAME].url,
    endpoint.workerUrl("tkt-1"),
    "pi workers get the standard mcpServers injection",
  );

  assert.equal(
    transform(sessionRequest({ mcpServers: { [DISPATCH_MCP_SERVER_NAME]: { type: "http", url: "x" } } })),
    undefined,
    "existing server name is not overwritten",
  );
  assert.equal(createSessionOpenTransform(() => endpoint, () => false, () => [])(sessionRequest()), undefined);
  assert.equal(createSessionOpenTransform(() => null, () => true, () => ["codex"])(sessionRequest()), undefined);
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
  const worker = transform(sessionRequest({
    labels: { [TICKET_LABEL]: "tkt-1" },
    provider: "zcode-acp/builtin:plan\\GLM",
  }));
  assert.ok(worker, "a configured plugin provider family gets its Worker tools");
  assert.equal(new URL(worker.mcpServers[DISPATCH_MCP_SERVER_NAME].url).searchParams.get("role"), "worker");

  assert.equal(
    transform(sessionRequest({ labels: { [TICKET_LABEL]: "tkt-1" }, provider: "my-acp/x" })),
    undefined,
    "an unconfigured family still gets nothing",
  );
});

test("pi orchestration and dispatch sessions use the standard mcpServers injection", async (t) => {
  const endpoint = await startDispatchMcpServer({
    dispatch: async () => ({ threadId: "t", triggerId: "g", directDelivered: false, note: null }),
  });
  t.after(() => endpoint.stop());

  const transform = createSessionOpenTransform(() => endpoint, () => false, () => resolveMcpProviders(""));
  for (const role of [ROUTER_LABEL_VALUE, WATCHDOG_AGENT_LABEL_VALUE]) {
    assert.equal(transform(sessionRequest({ labels: { [ROUTER_LABEL]: role }, provider: "pi" })), undefined);
  }

  const worker = transform(sessionRequest({ labels: { [TICKET_LABEL]: "tkt-9" }, provider: "pi" }));
  assert.equal(
    worker.mcpServers[DISPATCH_MCP_SERVER_NAME].url,
    endpoint.workerUrl("tkt-9"),
    "pi workers get their tools through the same mcpServers entry as every provider",
  );

  // 普通委派注入:默认名单不含 pi;显式加入后同样走标准 mcpServers 注入。
  assert.equal(transform(sessionRequest({ provider: "pi" })), undefined, "pi dispatch stays off by default");
  const optedIn = createSessionOpenTransform(() => endpoint, () => true, () => resolveMcpProviders("pi,claude"));
  const dispatch = optedIn(sessionRequest({ provider: "pi", env: { HOME: "/home/x" } }));
  assert.equal(
    dispatch.mcpServers[DISPATCH_MCP_SERVER_NAME].url,
    endpoint.urlFor("agent-1"),
    "opted-in pi dispatch sessions get the standard injection",
  );
  assert.equal(dispatch.env.HOME, "/home/x");
});
