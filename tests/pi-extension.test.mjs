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
        "mcp__superagent__superagent_list", "mcp__superagent__superagent_read",
        "mcp__superagent__superagent_search", "mcp__other__probe"],
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
