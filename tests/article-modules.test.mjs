import assert from "node:assert/strict";
import test from "node:test";
import { composeEvalPrompt, composeRouterInstructions, parseVerdict } from "../server/router.ts";
import { composeWorkerPrompt, isOrchestrationAgent } from "../server/workers.ts";
import { createSessionOpenTransform, orchestrationPermission, DISPATCH_MCP_SERVER_NAME } from "../server/agent-mcp.ts";
import { startDispatchMcpServer, UNSUBSCRIBE_TOOL_NAME } from "../server/mcp-server.ts";
import { composePatrolPrompt, parseWatchdogVerdict } from "../server/watchdog.ts";
import { FeishuSource } from "../server/feishu.ts";
import { QqSource } from "../server/qq.ts";
import { directTickets, subscribesTo } from "../shared/execution.ts";
import { patrolSummaryLabel, outcomeLabel } from "../shared/labels.ts";
import { emptyState, MAX_SPECULATIVE_TICKETS, SuperagentStateSchema } from "../shared/model.ts";
import { SETTINGS_DEFAULTS } from "../shared/settings.ts";

// 《Super-agent》补齐模块的纯函数层:提示词、权限策略、引用解析、看门狗协议、多对多订阅判定。

const worker = { workingDir: "/repo", isolation: "worktree", issue: null };

test("Router rules describe fan-out, subscribe, overheard chatter and watchdog notes", () => {
  const rules = composeRouterInstructions(worker, "");
  assert.match(rules, /go straight to EVERY subscribed\s+worker, not to you/);
  assert.doesNotMatch(rules, /follow-ups reach you instead of one of/, "the stale single-subscriber wording is gone");
  assert.match(rules, /- subscribe: make the Worker of an existing active ticket/);
  assert.match(rules, /\{"actions":\[\{"action":"subscribe","ticketId":"tkt_\.\.\."\}\]\}/);
  assert.match(rules, /\(context-only\) were overheard[\s\S]*Default to ignore/);
  assert.match(rules, /from "watchdog" comes from the orchestration watchdog/);
  assert.doesNotMatch(rules, /Speculative execution/);
  const speculative = composeRouterInstructions(worker, "", { speculative: true });
  assert.match(speculative, /## Speculative execution \(enabled\)/);
  assert.match(speculative, new RegExp(`At most\\s+${MAX_SPECULATIVE_TICKETS} speculative tickets`));
  assert.match(speculative, /"speculative":true/);
});

test("Router verdicts accept subscribe actions and the speculative dispatch flag", () => {
  const parsed = parseVerdict('```json\n{"actions":[{"action":"subscribe","ticketId":"tkt_a"},{"action":"dispatch","title":"复现","mandate":"静默复现","speculative":true}]}\n```');
  assert.ok("verdict" in parsed);
  assert.deepEqual(parsed.verdict.actions[0], { action: "subscribe", ticketId: "tkt_a" });
  assert.equal(parsed.verdict.actions[1].speculative, true);
  assert.ok("error" in parseVerdict('{"actions":[{"action":"subscribe","ticketId":"tkt_..."}]}'), "placeholder ids are rejected");
});

test("Router responses preserve question answers and reject placeholder IDs or persistent permission expansion", () => {
  const response = { behavior: "allow", updatedInput: { answers: { Features: ["One", "Two"] } } };
  const parsed = parseVerdict(JSON.stringify({ actions: [{ action: "respond", ticketId: "tkt_a", requestId: "ask-1", response }] }));
  assert.deepEqual(parsed.verdict.actions[0].response, response);
  for (const change of [
    { requestId: "..." }, { ticketId: "tkt_..." },
    { response: { behavior: "allow", updatedPermissions: [{ type: "allowAll" }] } },
  ]) {
    assert.ok("error" in parseVerdict(JSON.stringify({ actions: [{ action: "respond", ticketId: "tkt_a", requestId: "ask-1", response, ...change }] })));
  }
});

test("the eval prompt lists followers, quotes, overheard chatter and ticket tags", () => {
  const state = emptyState();
  const thread = { id: "thr_b", title: "B", state: "active" };
  state.threads.push(thread, { id: "thr_a", title: "A", state: "active" });
  state.tickets.push({ id: "tkt_a", threadId: "thr_a", title: "Fix A", status: "running", subscribed: true, follows: ["thr_b"], speculative: false });
  state.tickets.push({ id: "tkt_s", threadId: "thr_b", title: "Try", status: "running", subscribed: false, follows: [], speculative: true });
  const batch = [{
    id: "trg_new", threadId: "thr_b", sender: "feishu:ou", kind: "feishu", text: "还是不行", status: "pending",
    origin: { channel: "feishu", chatId: "c", senderId: "ou" },
    quote: { triggerId: "trg_old", sender: "feishu:ou_a", text: "登录页报 500", messageId: "m1" },
  }];
  const chatter = [{ id: "trg_c1", sender: "feishu:ou_x", text: "我这边也\n复现了", status: "filtered" }];
  const prompt = composeEvalPrompt({ thread, batch, state, worker, includeInstructions: false, includeHistory: false, chatter });
  assert.match(prompt, /## Tickets of other threads that also follow this thread[^\n]*\n- \[tkt_a\] "Fix A" status=running home-thread=thr_a/);
  assert.match(prompt, /- \[tkt_s\] "Try" status=running subscribed=false speculative/);
  assert.match(prompt, /## Recent unaddressed chat in this conversation \(filtered at admission; context only\)\n- \[trg_c1\] feishu:ou_x: 我这边也 复现了/);
  assert.match(prompt, /id: trg_new\nfrom: feishu:ou kind=feishu\nquoting: trg_old \(feishu:ou_a\): "登录页报 500"/);
});

test("speculative workers are told to work silently and lead their report with DELIVER or DISCARD", () => {
  const ticket = { id: "tkt_abcdef", title: "复现", mandate: "静默复现", createdAt: "2026-01-01T00:00:00.000Z" };
  const plain = composeWorkerPrompt(ticket, "/repo", "worktree");
  assert.doesNotMatch(plain, /Speculative background attempt/);
  assert.match(plain, /prefixed "\[thread thr_…\]" comes from another/);
  assert.match(plain, /Pass `threadId` to leave only one\s+followed conversation/);
  const speculative = composeWorkerPrompt({ ...ticket, speculative: true }, "/repo", "worktree");
  assert.match(speculative, /\[Speculative background attempt\]/);
  assert.match(speculative, /DELIVER: <conclusion>[\s\S]*DISCARD: <reason>[\s\S]*When in doubt, DISCARD\./);
});

test("Router and watchdog may only use their own recall tools; workers get their session tools auto-approved", () => {
  const tool = (name) => ({ name, kind: "tool" });
  assert.deepEqual(orchestrationPermission("router", tool("mcp__superagent__superagent_read")), { behavior: "allow" });
  assert.deepEqual(orchestrationPermission("watchdog", tool("superagent_search")), { behavior: "allow" });
  const denied = orchestrationPermission("router", tool("Bash"));
  assert.equal(denied.behavior, "deny");
  assert.match(denied.message, /decision-only/);
  assert.equal(orchestrationPermission("router", { name: "ExitPlanMode", kind: "plan" }).behavior, "deny");
  assert.equal(orchestrationPermission("watchdog", tool("Edit")).behavior, "deny");
  assert.deepEqual(orchestrationPermission("worker", tool("mcp__superagent__superagent_handback")), { behavior: "allow" });
  assert.equal(orchestrationPermission("worker", tool("Bash")), null, "other worker permissions stay with the human");
  assert.equal(orchestrationPermission(null, tool("Bash")), null);
  assert.equal(orchestrationPermission("router", tool("mcp__other__not_superagent_read_x")).behavior, "deny");
});

test("the watchdog session gets the read-only recall tools and never the dispatch tool", async (t) => {
  const endpoint = await startDispatchMcpServer({ dispatch: async () => ({ threadId: "t", triggerId: "g", directDelivered: false, note: null }) });
  t.after(() => endpoint.stop());
  const transform = createSessionOpenTransform(() => endpoint, () => true, () => ["codex"]);
  const request = {
    agentId: "wd", workspaceId: null, provider: "codex/test", cwd: "/repo", reason: "create", purpose: "interactive",
    title: null, labels: { "superagent.role": "watchdog" }, tools: [], env: {}, mcpServers: {},
  };
  const injected = transform(request);
  assert.equal(new URL(injected.mcpServers[DISPATCH_MCP_SERVER_NAME].url).searchParams.get("role"), "router");
  assert.equal(isOrchestrationAgent({ "superagent.role": "watchdog" }), true);
});

test("the worker unsubscribe tool can leave a single followed thread", async (t) => {
  const calls = [];
  const endpoint = await startDispatchMcpServer({
    dispatch: async () => ({ threadId: "t", triggerId: "g", directDelivered: false, note: null }),
    workerUnsubscribe: async (ticketId, threadId) => {
      calls.push([ticketId, threadId]);
      return { ok: true, note: "left" };
    },
  });
  t.after(() => endpoint.stop());
  const response = await fetch(endpoint.workerUrl("tkt_1"), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: UNSUBSCRIBE_TOOL_NAME, arguments: { threadId: "thr_b" } } }),
  });
  assert.equal(response.status, 200);
  await response.text();
  assert.deepEqual(calls, [["tkt_1", "thr_b"]]);
});

test("Feishu carries the quoted parent and root ids and returns sent message ids", async () => {
  const source = new FeishuSource({ appId: "a", appSecret: "b", allowUsers: ["ou_1"], allowChats: [], observeGroups: false });
  const inbound = await source.translate({
    sender: { sender_id: { open_id: "ou_1" }, sender_type: "user" },
    message: {
      message_id: "om_new", parent_id: "om_parent", root_id: "om_root", chat_id: "oc_g", chat_type: "p2p",
      message_type: "text", content: JSON.stringify({ text: "接着上面说" }), mentions: [],
    },
  }, () => {});
  assert.deepEqual(inbound.replyTo, ["om_parent", "om_root"]);
  source.client = { im: { v1: { message: {
    reply: async () => ({ code: 0, data: { message_id: "om_reply" } }),
    create: async () => ({ code: 0, data: { message_id: "om_sent" } }),
  } } } };
  assert.equal(await source.send({ channel: "feishu", chatId: "oc_g", messageId: "om_new", senderId: "ou_1" }, "hi"), "om_reply");
  assert.equal(await source.send({ channel: "feishu", chatId: "oc_g", messageId: null, senderId: "ou_1" }, "hi"), "om_sent");
});

test("QQ reads reply segments from both message arrays and CQ strings", () => {
  const source = new QqSource({ endpoint: "ws://x", token: "", allowUsers: ["10001"], allowGroups: ["20001"], observeGroups: false });
  const base = { post_type: "message", message_type: "private", user_id: 10001, self_id: 99999, message_id: 8 };
  const segments = source.translate({
    ...base,
    message: [{ type: "reply", data: { id: "77" } }, { type: "text", data: { text: "这个不对" } }],
    raw_message: "[CQ:reply,id=77]这个不对",
  });
  assert.deepEqual(segments.replyTo, ["77"]);
  assert.equal(segments.text, "这个不对");
  const cq = source.translate({ ...base, message: "[CQ:reply,id=-12]再看看", raw_message: "[CQ:reply,id=-12]再看看" });
  assert.deepEqual(cq.replyTo, ["-12"]);
  assert.equal(cq.text, "再看看");
});

test("watchdog verdicts parse strictly and patrol digests show progress and health", () => {
  const ok = parseWatchdogVerdict('Looks fine.\n```json\n{"summary":"1 worker stuck","actions":[{"action":"interrupt","ticketId":"tkt_1","text":"stop retrying"}]}\n```');
  assert.ok("verdict" in ok);
  assert.equal(ok.verdict.actions[0].action, "interrupt");
  assert.deepEqual(parseWatchdogVerdict('{"summary":"fine"}').verdict, { summary: "fine", actions: [] });
  assert.ok("error" in parseWatchdogVerdict('{"summary":"x","actions":[{"action":"rm -rf"}]}'));
  assert.ok("error" in parseWatchdogVerdict("no json here"));

  const prompt = composePatrolPrompt({
    at: "2026-11-05T10:00:00.000Z", intervalMin: 30,
    tickets: [{
      id: "tkt_1", title: "Fix", threadId: "thr_1", threadTitle: "登录", status: "running", attempts: 1, profile: null,
      provider: "codex/x", speculative: true, runningMin: 95, lastError: null, mandate: "fix it", sessionStatus: "running",
      pendingPermissions: 2, newEntries: 0, quietMin: 41, latestMessage: "retrying the same test",
    }],
    health: ["thread thr_2 \"x\": Router output unparsed 3 times in a row"],
  }, null);
  assert.match(prompt, /### tkt_1 "Fix" — status=running, running 95 min, attempt 1, provider=codex\/x, speculative/);
  assert.match(prompt, /worker session: running; waiting for 2 permission request\(s\)/);
  assert.match(prompt, /activity since last patrol: NONE \(last change 41 min ago\)/);
  assert.match(prompt, /## Engine health\n- thread thr_2/);
  assert.doesNotMatch(prompt, /Watchdog instructions/);
});

test("subscription helpers treat home subscriptions and follows alike", () => {
  const home = { id: "a", threadId: "t1", subscribed: true, follows: ["t2"], status: "running", workerAgentId: "w" };
  const legacy = { id: "b", threadId: "t1", subscribed: false, status: "waiting", workerAgentId: "w2" };
  assert.equal(subscribesTo(home, "t1"), true);
  assert.equal(subscribesTo(home, "t2"), true);
  assert.equal(subscribesTo(legacy, "t2"), false, "tickets saved before follows existed still work");
  assert.deepEqual(directTickets([home, legacy], "t2").map((ticket) => ticket.id), ["a"]);
  assert.deepEqual(directTickets([home, legacy]).map((ticket) => ticket.id), ["a"]);
});

test("state saved before these modules parses with empty follows, quotes and sent ids", () => {
  const parsed = SuperagentStateSchema.parse({
    version: 1, kv: {}, threads: [], triggers: [], decisions: [],
    tickets: [{ id: "tkt", threadId: "thr", title: "t", mandate: "m", status: "running", createdAt: "x", updatedAt: "x" }],
    imDeliveries: [{ id: "im", threadId: "thr", origin: { channel: "qq", chatId: "g:1", senderId: "u" }, parts: ["a"], nextPart: 1, status: "sent", createdAt: "x", updatedAt: "x" }],
  });
  assert.deepEqual(parsed.tickets[0].follows, []);
  assert.equal(parsed.tickets[0].speculative, false);
  assert.deepEqual(parsed.imDeliveries[0].sentMessageIds, []);
  assert.equal(SETTINGS_DEFAULTS.speculativeEnabled, false);
  assert.equal(SETTINGS_DEFAULTS.watchdogEnabled, false);
  assert.equal(SETTINGS_DEFAULTS.watchdogIntervalMin, 30);
});

test("new outcomes and patrol notes read naturally in Chinese", () => {
  assert.equal(outcomeLabel("subscribe"), "订阅");
  assert.equal(outcomeLabel("watchdog"), "巡检");
  assert.equal(patrolSummaryLabel("nothing to patrol"), "没有进行中的任务,未调用模型");
  assert.equal(patrolSummaryLabel("nothing to patrol: 4 parked waiting ticket(s)"), "只有 4 个待命任务且无新动静,未调用模型");
  assert.equal(patrolSummaryLabel("2 workers fine"), "2 workers fine");
});
