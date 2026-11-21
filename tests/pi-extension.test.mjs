import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { PI_MCP_URL_ENV, PI_ROLE_ENV } from "../server/agent-mcp.ts";

/**
 * pi-extension/superagent.js 的逻辑测试:用替身 pi API 验证 env 门控与 direct
 * exposure 注册。扩展在工厂调用时读 env,同一模块可以按用例反复实例化。
 * Router/看门狗角色已随直接推理迁移移除;Worker 与普通委派只做 MCP 注册。
 */

const extension = await import(pathToFileURL(new URL("../pi-extension/superagent.js", import.meta.url).pathname).href);

function fakePi() {
  const registered = [];
  const handlers = {};
  return {
    registered,
    handlers,
    registerMcpServer: (name, config) => registered.push({ name, config }),
    on: (event, handler) => {
      (handlers[event] ??= []).push(handler);
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
  const url = "http://127.0.0.1:1/secret/mcp?role=worker";
  for (const role of ["worker", undefined]) {
    setEnv(url, role);
    const pi = fakePi();
    extension.default(pi);
    assert.equal(pi.registered.length, 1, `${role ?? "dispatch"} registers one server`);
    const { name, config } = pi.registered[0];
    assert.equal(name, "superagent");
    assert.equal(config.url, url);
    assert.equal(config.exposure, "direct");
    assert.equal(
      config.description,
      role === "worker" ? ROLE_TEXT_WORKER : ROLE_TEXT_DISPATCH,
      `${role ?? "dispatch"} gets its role description`,
    );
  }
});

test("legacy decision roles are no longer special-cased: registration only, no tool hooks", () => {
  setEnv("http://127.0.0.1:1/mcp", "router");
  const pi = fakePi();
  extension.default(pi);
  assert.equal(pi.registered.length, 1, "the server still registers (upgrade path keeps old env values benign)");
  assert.equal(pi.handlers["before_agent_start"], undefined);
  assert.equal(pi.handlers["tool_call"], undefined);
});

test("unknown roles fall back to the dispatch description", () => {
  setEnv("http://127.0.0.1:1/mcp", "watchdog");
  const pi = fakePi();
  extension.default(pi);
  assert.equal(pi.registered[0].config.description, ROLE_TEXT_DISPATCH);
});

test("registration failure is reported without throwing", () => {
  setEnv("http://127.0.0.1:1/mcp", "worker");
  const pi = fakePi();
  pi.registerMcpServer = () => {
    throw new Error("old pi without registerMcpServer");
  };
  extension.default(pi);
  assert.equal(pi.registered.length, 0);
});

const ROLE_TEXT_WORKER = "Superagent session control: superagent_unsubscribe / superagent_handback";
const ROLE_TEXT_DISPATCH = "superagent_dispatch: delegate a task to the Superagent orchestrator";
