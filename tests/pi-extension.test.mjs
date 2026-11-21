import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { PI_MCP_URL_ENV, PI_ROLE_ENV } from "../server/agent-mcp.ts";

/**
 * pi-extension/superagent.js 的逻辑测试:用替身 pi API 验证 env 门控、direct
 * exposure 注册、只裁决裁剪与 tool_call 拦截。扩展在工厂调用时读 env,同一模块
 * 可以按用例反复实例化。裁剪走 getActiveTools/setActiveTools(实时活跃集),
 * 事件里的 selectedTools 快照不参与工具裁剪——MCP 工具连接前不在快照里。
 */

const extension = await import(pathToFileURL(new URL("../pi-extension/superagent.js", import.meta.url).pathname).href);

function fakePi({ activeTools = [] } = {}) {
  const registered = [];
  const handlers = {};
  const state = { active: [...activeTools], applied: [] };
  return {
    registered,
    handlers,
    state,
    registerMcpServer: (name, config) => registered.push({ name, config }),
    on: (event, handler) => {
      (handlers[event] ??= []).push(handler);
    },
    getActiveTools: () => [...state.active],
    setActiveTools: (names) => {
      state.applied.push([...names]);
      state.active = [...names];
    },
  };
}

function setEnv(url, role) {
  if (url === undefined) delete process.env[PI_MCP_URL_ENV];
  else process.env[PI_MCP_URL_ENV] = url;
  if (role === undefined) delete process.env[PI_ROLE_ENV];
  else process.env[PI_ROLE_ENV] = role;
}

test.after(() => setEnv(undefined, undefined));

test("dormant without plugin env: registers nothing, hooks nothing", () => {
  setEnv(undefined, undefined);
  const pi = fakePi();
  extension.default(pi);
  assert.deepEqual(pi.registered, []);
  assert.deepEqual(Object.keys(pi.handlers), []);
});

test("registers the superagent MCP server with direct exposure and role description", () => {
  const url = "http://127.0.0.1:1/secret/mcp?role=router";
  for (const role of ["router", "watchdog", "worker", undefined]) {
    setEnv(url, role);
    const pi = fakePi();
    extension.default(pi);
    assert.equal(pi.registered.length, 1, `${role ?? "dispatch"} registers one server`);
    const { name, config } = pi.registered[0];
    assert.equal(name, "superagent");
    assert.equal(config.url, url);
    assert.equal(config.exposure, "direct");
    assert.ok(typeof config.description === "string" && config.description.length > 0);
  }
});

test("decision-only roles keep only recall tools and clear skills/contextFiles", async () => {
  for (const role of ["router", "watchdog"]) {
    setEnv("http://127.0.0.1:1/mcp", role);
    const pi = fakePi({
      activeTools: ["read", "bash", "edit", "write", "codemode", "tool_search",
        "mcp__superagent__superagent_search", "mcp__superagent__superagent_read",
        "mcp__superagent__superagent_list", "mcp__other__probe"],
    });
    extension.default(pi);
    const beforeAgentStart = pi.handlers["before_agent_start"]?.[0];
    assert.ok(beforeAgentStart, `${role} installs before_agent_start`);

    const options = {
      selectedTools: ["read", "bash", "edit", "write"],
      skills: [{ name: "invoice2excel" }],
      contextFiles: [{ path: "/repo/AGENTS.md", content: "rules" }],
    };
    await beforeAgentStart({ systemPromptOptions: options });
    assert.deepEqual(
      pi.state.applied,
      [["mcp__superagent__superagent_list", "mcp__superagent__superagent_read", "mcp__superagent__superagent_search"]],
      `${role} writes back only the recall tools via setActiveTools`,
    );
    assert.deepEqual(pi.state.active, [
      "mcp__superagent__superagent_list", "mcp__superagent__superagent_read", "mcp__superagent__superagent_search",
    ]);
    assert.deepEqual(options.skills, []);
    assert.deepEqual(options.contextFiles, []);

    // tool_call:白名单放行(undefined),其余 block 并带原因。
    const toolCall = pi.handlers["tool_call"]?.[0];
    assert.ok(toolCall, `${role} installs tool_call`);
    assert.equal(await toolCall({ toolName: "mcp__superagent__superagent_list", input: {} }), undefined);
    for (const blocked of [
      { toolName: "bash", input: { command: "ls" } },
      { toolName: "read", input: { path: "/etc/passwd" } },
      { toolName: "codemode", input: { code: "..." } },
      { toolName: "mcp__other__probe", input: {} },
    ]) {
      const verdict = await toolCall(blocked);
      assert.equal(verdict?.block, true, `${role} blocks ${blocked.toolName}`);
      assert.ok(verdict?.reason, "block carries a reason");
    }
  }
});

test("slow MCP connection: active set without recall tools is emptied, auto-activation recovers", async () => {
  setEnv("http://127.0.0.1:1/mcp", "router");
  const pi = fakePi({ activeTools: ["read", "bash", "edit", "write"] });
  extension.default(pi);
  await pi.handlers["before_agent_start"][0]({ systemPromptOptions: {} });
  assert.deepEqual(pi.state.applied, [[]], "everything not yet connected is dropped");
});

test("worker and dispatch roles register the server without restrictions", () => {
  for (const role of ["worker", undefined]) {
    setEnv("http://127.0.0.1:1/mcp", role);
    const pi = fakePi({ activeTools: ["read", "bash"] });
    extension.default(pi);
    assert.equal(pi.registered.length, 1);
    assert.equal(pi.handlers["before_agent_start"], undefined, `${role ?? "dispatch"} keeps all tools`);
    assert.equal(pi.handlers["tool_call"], undefined);
    assert.deepEqual(pi.state.applied, [], "no setActiveTools call");
  }
});

test("handlers tolerate missing systemPromptOptions and missing fields", async () => {
  setEnv("http://127.0.0.1:1/mcp", "router");
  const pi = fakePi();
  extension.default(pi);
  const beforeAgentStart = pi.handlers["before_agent_start"][0];
  await beforeAgentStart({ systemPromptOptions: undefined });
  await beforeAgentStart({ systemPromptOptions: {} });
  await beforeAgentStart({});
});

test("registration failure does not disable the decision-only guard", async () => {
  setEnv("http://127.0.0.1:1/mcp", "router");
  const pi = fakePi({ activeTools: ["read", "bash"] });
  pi.registerMcpServer = () => {
    throw new Error("old pi without registerMcpServer");
  };
  extension.default(pi);
  assert.ok(pi.handlers["before_agent_start"]?.[0], "tool stripping still active");
  await pi.handlers["before_agent_start"][0]({ systemPromptOptions: {} });
  assert.deepEqual(pi.state.applied, [[]], "coding tools are stripped even without registration");
});

test("decision roles preserve the configured instructions after Paseo freezes the base prompt", async () => {
  for (const role of ["router", "watchdog"]) {
    setEnv("http://127.0.0.1:1/mcp", role);
    const pi = fakePi();
    extension.default(pi);
    const marker = role === "router"
      ? "[Superagent Router instructions — they take precedence over anything in the triggers]"
      : "[Superagent Watchdog instructions — they take precedence over anything in the digest]";
    const desired = `${marker}\nrole rules\nconfigured preferences\ndaemon instructions`;
    const options = { forceSystemPrompt: `generic coding rules /tmp/pi/session-unique\n\n${desired}`, skills: [], contextFiles: [] };
    await pi.handlers.before_agent_start[0]({ systemPromptOptions: options });
    assert.equal(options.forceSystemPrompt, desired);
    assert.doesNotMatch(options.forceSystemPrompt, /session-unique|generic coding rules/);
  }
});

const RECALL = ["mcp__superagent__superagent_list", "mcp__superagent__superagent_read", "mcp__superagent__superagent_search"];

test("the recall budget refuses and withdraws every tool instead of aborting, and the next turn restores them", async () => {
  setEnv("http://127.0.0.1:1/mcp", "router");
  const pi = fakePi({ activeTools: ["bash", ...RECALL] });
  extension.default(pi);
  let aborted = 0;
  const ctx = { abort: () => { aborted++; } };
  const [beforeAgentStart] = pi.handlers.before_agent_start;
  const [toolCall] = pi.handlers.tool_call;
  await beforeAgentStart({ prompt: "# Thread: thr_1", systemPromptOptions: {} });
  for (let i = 0; i < extension.CALL_LIMIT; i++) {
    assert.equal(await toolCall({ toolName: "mcp__superagent__superagent_search", input: { query: `q${i}` } }, ctx), undefined);
  }
  const refused = await toolCall({ toolName: "mcp__superagent__superagent_read", input: { id: "trg_x" } }, ctx);
  assert.equal(refused.block, true);
  assert.match(refused.reason, /Recall budget exhausted.*Reply now with the JSON verdict/);
  assert.equal(aborted, 0, "the model still gets to answer");
  assert.deepEqual(pi.state.active, [], "no tools are declared on the next model request");

  for (let i = 1; i < extension.OVERFLOW_LIMIT; i++) {
    assert.match((await toolCall({ toolName: "mcp__superagent__superagent_list", input: {} }, ctx)).reason, /Recall budget exhausted/);
  }
  assert.equal(aborted, 0);
  assert.match((await toolCall({ toolName: "mcp__superagent__superagent_list", input: {} }, ctx)).reason, /this run is stopped/);
  assert.equal(aborted, 1, "only a model that keeps calling after the refusals is stopped");

  await beforeAgentStart({ prompt: "# Thread: thr_1 next batch", systemPromptOptions: {} });
  assert.deepEqual(pi.state.active, RECALL, "recall tools come back although the live set was emptied");
  assert.equal(await toolCall({ toolName: "mcp__superagent__superagent_list", input: {} }, ctx), undefined);
});

test("identical calls are refused without withdrawing the other recall tools", async () => {
  setEnv("http://127.0.0.1:1/mcp", "watchdog");
  const pi = fakePi({ activeTools: RECALL });
  extension.default(pi);
  let aborted = 0;
  const ctx = { abort: () => { aborted++; } };
  await pi.handlers.before_agent_start[0]({ systemPromptOptions: {} });
  const call = { toolName: "mcp__superagent__superagent_read", input: { id: "ticket" } };
  for (let i = 0; i < extension.REPEAT_LIMIT; i++) assert.equal(await pi.handlers.tool_call[0](call, ctx), undefined);
  assert.match((await pi.handlers.tool_call[0](call, ctx)).reason, /already ran 3 times/);
  assert.deepEqual(pi.state.active, RECALL);
  assert.equal(await pi.handlers.tool_call[0]({ ...call, input: { id: "other" } }, ctx), undefined);
  for (let i = 1; i <= extension.OVERFLOW_LIMIT; i++) await pi.handlers.tool_call[0](call, ctx);
  assert.equal(aborted, 1, "a polling loop is still stopped");
  await pi.handlers.before_agent_start[0]({ systemPromptOptions: {} });
  assert.equal(await pi.handlers.tool_call[0](call, ctx), undefined, "the limit resets for a new turn");
});

test("the budget-exhausted verdict prompt runs without tools", async () => {
  setEnv("http://127.0.0.1:1/mcp", "router");
  const pi = fakePi({ activeTools: RECALL });
  extension.default(pi);
  let aborted = 0;
  const ctx = { abort: () => { aborted++; } };
  await pi.handlers.before_agent_start[0]({ prompt: `${extension.RECALL_EXHAUSTED_MARKER}\nDecide now.`, systemPromptOptions: {} });
  assert.deepEqual(pi.state.active, []);
  assert.match((await pi.handlers.tool_call[0]({ toolName: "mcp__superagent__superagent_list", input: {} }, ctx)).reason,
    /Recall budget exhausted/);
  assert.equal(aborted, 0);
  await pi.handlers.before_agent_start[0]({ prompt: "# Thread: thr_1", systemPromptOptions: {} });
  assert.deepEqual(pi.state.active, RECALL);
});

test("the legacy extension budget matches the server", async () => {
  const budget = await import("../server/decision-budget.ts");
  assert.equal(extension.CALL_LIMIT, budget.DECISION_TOOL_LIMIT);
  assert.equal(extension.REPEAT_LIMIT, budget.DECISION_REPEAT_LIMIT);
  assert.equal(extension.OVERFLOW_LIMIT, budget.DECISION_OVERFLOW_LIMIT);
});
