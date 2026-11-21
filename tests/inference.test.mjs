import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { Deadline } from "../server/deadline.ts";
import { runInference } from "../server/inference.ts";
import { parseVerdict } from "../server/router.ts";

const tool = (id, name, args) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const payload = (content, tools, usage) => ({
  choices: [{ finish_reason: tools ? "tool_calls" : "stop", message: { content, tool_calls: tools } }],
  usage: usage ?? { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 80 } },
});
const okText = '{"actions":[{"action":"reply","reply":"done"}]}';

function options(t, recall = {}, config = {}) {
  const deadline = new Deadline(5_000, "test inference");
  t.after(() => deadline.cancel());
  return {
    config: { baseUrl: "https://inference.example/api/v1/", model: "test-model", apiKey: "test-secret", ...config },
    instructions: "Only decide with JSON.",
    context: "Route this task.",
    recall: {
      list: async () => assert.fail("unexpected list"),
      read: async () => assert.fail("unexpected read"),
      search: async () => assert.fail("unexpected search"),
      ...recall,
    },
    parse: parseVerdict,
    repair: (error) => `Resend the complete verdict: ${error}`,
    deadline,
  };
}

test("direct inference exchanges tools and a verdict over the Chat Completions HTTP protocol", async t => {
  const requests = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ body, url: request.url, authorization: request.headers.authorization,
      userAgent: request.headers["user-agent"], threadHeader: request.headers["x-superagent-thread"] });
    const result = requests.length === 1
      ? payload(null, [tool("q1", "superagent_search", { query: "earlier job" }), tool("q2", "read_file", { path: "/repo" })])
      : payload(okText);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(result));
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const result = await runInference({ ...options(t, { search: async (query) => {
    assert.equal(query, "earlier job");
    return "matched tkt_123";
  } }, { baseUrl: `http://127.0.0.1:${server.address().port}/v1` }), threadId: "thr_cache" });
  assert.equal(requests[0].url, "/v1/chat/completions");
  assert.equal(requests[0].authorization, "Bearer test-secret");
  assert.equal(requests[0].userAgent, "paseo-superagent");
  assert.equal(requests[0].threadHeader, "thr_cache");
  assert.deepEqual(requests[0].body.tools.map(item => item.function.name), ["superagent_list", "superagent_read", "superagent_search"]);
  assert.equal(requests[0].body.model, "test-model");
  assert.ok(!JSON.stringify(requests[0].body).includes("test-secret"));
  const [returned, denied] = requests[1].body.messages.slice(-2);
  assert.equal(returned.tool_call_id, "q1");
  assert.match(returned.content, /Untrusted orchestration data[\s\S]*matched tkt_123/);
  assert.match(denied.content, /Unknown tool/);
  assert.equal(result.verdict.actions[0].reply, "done");
  assert.equal(result.trace.recallCalls, 1);
  assert.equal(result.trace.inputTokens, 200);
  assert.equal(result.trace.cachedInputTokens, 160);
});

test("the thread header stays ASCII-bounded and cached tokens stay optional", async t => {
  const bodies = [];
  const result = await runInference(options(t), async (_url, init) => {
    bodies.push({ headers: init.headers });
    return Response.json(payload(okText, null, { prompt_tokens: 10 }));
  });
  assert.equal(bodies[0].headers["x-superagent-thread"], undefined);
  assert.equal(result.trace.cachedInputTokens, undefined);
  const tagged = await runInference({ ...options(t), threadId: "thr_a\u4e2db\n" + "x".repeat(120) }, async (_url, init) =>
    Response.json(payload(okText)));
  assert.equal(tagged.trace.cachedInputTokens, 80);
});

test("recall is bounded and format repair comes after a tool-free verdict request", async t => {
  const bodies = [];
  let reads = 0;
  const result = await runInference(options(t, { read: async () => { reads++; return "record"; } }), async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (bodies.length === 1) return Response.json(payload(null, [
      ...Array.from({ length: 4 }, (_, i) => tool(`same-${i}`, "superagent_read", { id: "trg_same" })),
      ...Array.from({ length: 10 }, (_, i) => tool(`distinct-${i}`, "superagent_read", { id: `trg_${i}` })),
    ]));
    if (bodies.length === 2) return Response.json(payload("invalid"));
    return Response.json(payload(okText));
  });
  assert.equal(reads, 12);
  assert.equal(bodies[1].tools, undefined);
  assert.match(bodies[1].messages.find(message => message.tool_call_id === "same-3").content, /Repeated recall limit/);
  assert.match(bodies[1].messages.find(message => message.tool_call_id === "distinct-9").content, /Recall budget exhausted/);
  assert.equal(bodies[2].tools, undefined);
  assert.match(bodies[2].messages.at(-1).content, /Resend the complete verdict/);
  assert.equal(result.trace.requests, 3);
  assert.equal(result.trace.recallCalls, 12);
});

test("direct inference returns actionable HTTP errors without returning upstream response bodies", async t => {
  await assert.rejects(runInference(options(t), async () => new Response("key or private prompt", { status: 401 })), /HTTP 401$/);
  await assert.rejects(runInference(options(t, {}, { baseUrl: "https://user:pwd@example.com/v1" }),
    async () => assert.fail("invalid URL reached fetch")), /without credentials/);
});

test("plaintext inference requests are restricted to loopback IP addresses", async t => {
  for (const host of ["inference.example", "127.example", "10.0.0.1", "[2001:db8::1]"]) {
    await assert.rejects(runInference(options(t, {}, { baseUrl: `http://${host}/v1` }),
      async () => assert.fail("an insecure endpoint reached fetch")), /requires HTTPS/);
  }
  const result = await runInference(options(t, {}, { baseUrl: "http://[::1]:8000/v1" }), async (url, init) => {
    assert.equal(url.hostname, "[::1]");
    assert.equal(init.redirect, "error");
    return Response.json(payload(okText));
  });
  assert.equal(result.verdict.actions[0].reply, "done");
});

test("an API without JSON mode can fall back to a locally validated JSON verdict", async t => {
  const bodies = [];
  const result = await runInference(options(t), async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    return body.response_format
      ? new Response("unsupported response_format", { status: 400 })
      : Response.json(payload(okText));
  });
  assert.deepEqual(bodies[0].response_format, { type: "json_object" });
  assert.equal(bodies[1].response_format, undefined);
  assert.deepEqual(bodies[1].tools, bodies[0].tools);
  assert.equal(result.trace.requests, 2);
  assert.equal(result.verdict.actions[0].reply, "done");
});
