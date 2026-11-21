import assert from "node:assert/strict";
import test from "node:test";
import { composeEvalPrompt, composeRouterInstructions, parseVerdict } from "../server/router.ts";
import { composeWorkerPrompt, taskDirectory } from "../server/workers.ts";
import { dispatchMandateIssue, emptyState, verdictPlaceholderIssue } from "../shared/model.ts";
import { MAX_ROUTER_INSTRUCTIONS_CHARS, SETTINGS_DEFAULTS, superagentSettings } from "../shared/settings.ts";

// Native providers carry stable rules in systemPrompt; ACP providers use a stable user-message prefix.

test("normal Router turns contain each user message once and omit stable instructions and history", () => {
  const text = "请调研项目登录失败的原因，并整理验证结果。";
  const thread = { id: "thread", title: text, summary: text };
  const trigger = { id: "trigger", threadId: "thread", sender: "user", kind: "manual", text, status: "pending" };
  const state = emptyState();
  state.triggers.push({ ...trigger, id: "old", status: "evaluated", text: "Previous user request", receivedAt: "2020-01-01" });
  const prompt = composeEvalPrompt({ thread, batch: [trigger], state, worker: { workingDir: "/repo", isolation: "worktree", issue: null },
    includeInstructions: false, includeHistory: false });
  assert.equal(prompt.split(text).length - 1, 1);
  assert.doesNotMatch(prompt, /Previous user request|"actions"|Router instructions|Worker profiles|summary:/);
});

test("a report is not repeated in the current Ticket or in recovery history", () => {
  const text = "Worker 汇报：验证完成。";
  const state = emptyState();
  const trigger = { id: "report", threadId: "thread", sender: "worker:ticket", kind: "report", text, status: "pending" };
  state.triggers.push(trigger);
  state.tickets.push({ id: "ticket", threadId: "thread", title: "Task", status: "waiting", report: text });
  const prompt = composeEvalPrompt({ thread: { id: "thread", title: "Task" }, batch: [trigger], state,
    worker: { workingDir: "/repo", isolation: "worktree", issue: null }, includeInstructions: false, includeHistory: true });
  assert.equal(prompt.split(text).length - 1, 1);
});

test("a distinct task title survives first-thread recovery while a message-derived title is suppressed", () => {
  const context = { thread: { id: "thread", title: "API 服务", summary: null },
    batch: [{ id: "trigger", sender: "user", kind: "manual", text: "修复启动问题。", status: "pending" }],
    state: emptyState(), worker: { workingDir: "/repo", isolation: "worktree", issue: null }, includeInstructions: false };
  assert.match(composeEvalPrompt(context), /title: API 服务/);
  assert.doesNotMatch(composeEvalPrompt({ ...context, includeHistory: false }), /title:/);
});

test("the title line stays present or absent independent of this batch's texts", () => {
  // 去重不再看本批触发文本(那会随每轮批次变化,让 title 行消失/重现、打断前缀),
  // 而是看持久状态:首条已评估触发的截断首行即消息派生标题。
  const state = emptyState();
  const first = { id: "trg_first", threadId: "thread", threadKey: "manual:test", kind: "manual", sender: "user",
    text: "if u can recieve the msg, pls respones with 'pong'", status: "evaluated", context: false, receivedAt: "2026-01-01T00:00:00.000Z" };
  state.triggers.push(first);
  const context = { thread: { id: "thread", title: first.text.slice(0, 120), summary: null }, state,
    worker: { workingDir: "/repo", isolation: "worktree", issue: null }, includeInstructions: false };
  const derived = composeEvalPrompt({ ...context,
    batch: [{ id: "b1", sender: "user", kind: "manual", text: "switch back to Chinese", status: "pending" }] });
  assert.doesNotMatch(derived, /title:/, "a message-derived title is not repeated while its trigger is retained");
  const exact = composeEvalPrompt({ ...context,
    batch: [{ id: "b1", sender: "user", kind: "manual", text: first.text, status: "pending" }] });
  assert.doesNotMatch(exact, /title:/, "still suppressed when this batch repeats the first line verbatim");
  state.triggers = state.triggers.filter((trigger) => trigger.id !== "trg_first");
  const resurfaced = composeEvalPrompt({ ...context,
    batch: [{ id: "b1", sender: "user", kind: "manual", text: "switch back to Chinese", status: "pending" }] });
  assert.match(resurfaced, /title: if u can recieve/, "the title returns only when its trigger is gone from state");
});

test("Router preferences support old settings, multiline text and a bounded size", () => {
  assert.equal(SETTINGS_DEFAULTS.routerInstructions, "");
  const legacy = superagentSettings.schema.parse({ workingDir: "/repo", routerProvider: "zcode-acp" });
  assert.equal(legacy.routerInstructions, "");
  const text = "中文答复。\n\n汇报包含验证情况。";
  assert.equal(superagentSettings.schema.parse({ routerInstructions: `  ${text}\n` }).routerInstructions, text);
  assert.equal(superagentSettings.schema.safeParse({ routerInstructions: "a".repeat(MAX_ROUTER_INSTRUCTIONS_CHARS) }).success, true);
  const oversized = superagentSettings.schema.safeParse({ routerInstructions: "a".repeat(MAX_ROUTER_INSTRUCTIONS_CHARS + 1) });
  assert.deepEqual(oversized.error.issues[0].path, ["routerInstructions"]);
});

test("Router preferences enter the eval prompt without changing Worker instructions or the output contract", () => {
  const context = {
    thread: { id: "t", title: "test" }, batch: [], state: emptyState(),
    worker: { workingDir: "/repo", isolation: "worktree", issue: null },
  };
  const rules = "面向用户使用中文。\n汇报必须包含验证情况。";
  const prompt = composeEvalPrompt({ ...context, routerInstructions: rules });
  assert.ok(prompt.includes(rules));
  assert.ok(prompt.indexOf("do NOT call any\ntools") < prompt.indexOf(rules));
  assert.ok(prompt.indexOf(rules) < prompt.indexOf("# Thread:"));
  assert.match(prompt, /keep the decision-only role, configured worker profiles, action limit/);
  assert.match(prompt, /These replace any preferences from earlier evaluations/);
  assert.match(prompt, /Reply with exactly one JSON object/);
  assert.equal(composeEvalPrompt({ ...context, routerInstructions: " \n " }), composeEvalPrompt(context));
  assert.doesNotMatch(composeWorkerPrompt({ id: "ticket", title: "test", mandate: "work" }, "/repo", "worktree"), /面向用户使用中文/);
});

test("Router bootstrap carries the decision-only rules before the thread", () => {
  const state = emptyState();
  const thread = {
    id: "thread", key: "manual:k", title: "test", state: "active", summary: null,
    createdAt: "2020-01-01T00:00:00.000Z", updatedAt: "2020-01-01T00:00:00.000Z",
  };
  const trigger = {
    id: "trigger", threadId: "thread", threadKey: "manual:k", kind: "manual", sender: "user",
    text: "research something", status: "pending", context: false, receivedAt: "2020-01-01T00:00:00.000Z",
  };
  const worker = { workingDir: "/repo", isolation: "worktree", issue: null };
  const prompt = composeEvalPrompt({ thread, batch: [trigger], state, worker });
  assert.match(prompt, /^\[Superagent Router instructions/);
  assert.match(prompt, /do NOT call any\s+tools/);
  assert.match(prompt, /dispatch \(the default for real work\)/);
  assert.match(prompt, /SEVERAL dispatches/);
  assert.match(prompt, /If answering would need a lookup, dispatch instead/);
  assert.match(prompt, /\{"actions":\[\.\.\.\]\}/);
  assert.match(prompt, /\{"actions":\[\{"action":"steer","ticketId":"tkt_\.\.\./);
  assert.ok(prompt.indexOf("You are the Router") < prompt.indexOf("# Thread: thread"));
  assert.match(prompt, /## Worker environment\nbase directory: \/repo\nisolation: worktree/);
  assert.doesNotMatch(prompt, /PROBLEM:/);

  const shared = composeEvalPrompt({
    thread, batch: [trigger], state,
    worker: { workingDir: "/dir", isolation: "shared", issue: "worker working directory /dir does not exist" },
  });
  assert.match(shared, /isolation: shared — workers work directly inside the base directory/);
  assert.match(shared, /Each ticket automatically gets its own task directory <base directory>\/tasks\//);
  assert.doesNotMatch(prompt, /own task directory/);
  assert.match(shared, /PROBLEM: worker working directory \/dir does not exist\. Dispatching will fail/);
});

test("the Worker's first prompt carries its role and report instructions", () => {
  const ticket = { id: "tkt_abc123xyz789", title: "Do it", mandate: "the mandate", createdAt: "2026-11-02T04:00:00.000Z" };
  for (const isolation of ["worktree", "shared"]) {
    const prompt = composeWorkerPrompt(ticket, "/repo", isolation);
    assert.match(prompt, /^\[Worker instructions\]\nYou are a Worker agent/);
    assert.match(prompt, /your final message is the REPORT for the orchestrator/);
    assert.match(prompt, /FIRST LINE must be one self-contained conclusion sentence/);
    assert.match(prompt, /keyword recall matches on/);
    assert.ok(prompt.indexOf("[Execution environment]") < prompt.indexOf("# Ticket: Do it"));
    assert.ok(prompt.endsWith("the mandate"));
  }
});

test("shared isolation gives each ticket its own task directory", () => {
  const ticket = { id: "tkt_abc123xyz789", title: "整理 Report", mandate: "m", createdAt: "2026-11-02T04:00:00.000Z" };
  const dir = "/srv/tmp/tasks/20261102-整理-report-xyz789";
  assert.equal(taskDirectory("/srv/tmp", ticket), dir);
  // 太平洋时间 11-09 晚上 = 北京时间 11-10 凌晨:按北京日期命名,与 daemon 主机时区无关。
  assert.equal(taskDirectory("/srv/tmp", { ...ticket, createdAt: "2026-11-09T19:00:00.000Z" }), "/srv/tmp/tasks/20261110-整理-report-xyz789");
  assert.match(taskDirectory("/srv/tmp", { ...ticket, createdAt: "not a date" }), /^\/srv\/tmp\/tasks\/\d{8}-整理-report-xyz789$/, "an invalid timestamp falls back to now");
  const shared = composeWorkerPrompt(ticket, "/srv/tmp", "shared");
  assert.ok(shared.includes(`Your task directory is ${dir} — create it`));
  assert.match(shared, /state where you put the outputs/);
  assert.match(shared, /only modify files outside your task directory when the mandate explicitly names them/);
  assert.doesNotMatch(composeWorkerPrompt(ticket, "/srv/tmp", "worktree"), /task directory/);
});

test("shared workers follow the base directory's own filing rules before the task directory", () => {
  const ticket = { id: "tkt_abc123xyz789", title: "Report", mandate: "m", createdAt: "2026-11-02T04:00:00.000Z" };
  const prompt = composeWorkerPrompt(ticket, "/srv/tmp", "shared", ["AGENTS.md"]);
  assert.match(prompt, /own project instructions: \/srv\/tmp\/AGENTS\.md\. Read them if they are not already in your context/);
  assert.match(prompt, /make any index or registry updates they require/);
  assert.match(prompt, /Only if they do not say where this ticket's outputs belong, use \/srv\/tmp\/tasks\//);
  assert.doesNotMatch(prompt, /only modify files outside your task directory/);

  const state = emptyState();
  const thread = { id: "t", key: "k", title: "t", state: "active", summary: null, createdAt: "", updatedAt: "" };
  const trigger = { id: "g", threadId: "t", threadKey: "k", kind: "manual", sender: "u", text: "x", status: "pending", context: false, receivedAt: "" };
  const router = composeEvalPrompt({
    thread, batch: [trigger], state,
    worker: { workingDir: "/srv/tmp", isolation: "shared", issue: null, instructionFiles: ["AGENTS.md", "CLAUDE.md"] },
  });
  assert.match(router, /own project instructions \(AGENTS\.md, CLAUDE\.md\) that define where/);
  assert.doesNotMatch(router, /Write the mandate around "your task directory"/);
});

test("active ticket lines expose the worker branch for steering and review", () => {
  const state = emptyState();
  const thread = { id: "t", key: "k", title: "t", state: "active", summary: null, createdAt: "", updatedAt: "" };
  const trigger = { id: "g", threadId: "t", threadKey: "k", kind: "manual", sender: "u", text: "x", status: "pending", context: false, receivedAt: "" };
  state.tickets.push({
    id: "tkt_1", threadId: "t", title: "Fix parser", mandate: "m", status: "running",
    workerAgentId: "ag", workspaceId: "ws", branchName: "superagent/fix-parser-abc123",
    startedAt: null, attempts: 1, subscribed: true, report: null, lastError: null,
    createdAt: "", updatedAt: "",
  });
  const prompt = composeEvalPrompt({
    thread, batch: [trigger], state,
    worker: { workingDir: "/repo", isolation: "worktree", issue: null },
  });
  assert.match(prompt, /- \[tkt_1\] "Fix parser" status=running subscribed=true branch=superagent\/fix-parser-abc123/);
});

test("recently finished tickets are listed with ids, status and branch as retry targets", () => {
  const state = emptyState();
  const thread = { id: "t", key: "k", title: "t", state: "active", summary: null, createdAt: "", updatedAt: "" };
  const trigger = { id: "g", threadId: "t", threadKey: "k", kind: "manual", sender: "u", text: "retry the failed one", status: "pending", context: false, receivedAt: "" };
  const finished = (id, title, status, updatedAt, extra = {}) => ({
    id, threadId: "t", title, mandate: "m", status, workerAgentId: "ag", workspaceId: "ws",
    branchName: null, startedAt: null, attempts: 1, subscribed: false, report: null,
    lastError: null, createdAt: "", updatedAt, ...extra,
  });
  state.tickets.push(finished("tkt_fail", "Fix parser", "failed", "2026-01-03T00:00:00.000Z", {
    branchName: "superagent/fix-parser-abc123", lastError: "tests failed",
  }));
  state.tickets.push(finished("tkt_done", "Write docs", "completed", "2026-01-02T00:00:00.000Z"));
  state.tickets.push(finished("tkt_old", "Old job", "canceled", "2026-01-01T00:00:00.000Z"));
  const prompt = composeEvalPrompt({
    thread, batch: [trigger], state,
    worker: { workingDir: "/repo", isolation: "worktree", issue: null },
  });
  assert.match(prompt, /## Recently finished tickets \(newest first, up to 5\)/);
  const failIndex = prompt.indexOf('- [tkt_fail] "Fix parser" status=failed branch=superagent/fix-parser-abc123 error="tests failed"');
  const doneIndex = prompt.indexOf('- [tkt_done] "Write docs" status=completed');
  const oldIndex = prompt.indexOf('- [tkt_old] "Old job" status=canceled');
  assert.ok(failIndex > 0 && doneIndex > failIndex && oldIndex > doneIndex, "newest terminal tickets come first");
  assert.match(prompt, /Terminal tickets of this thread are listed under "Recently finished tickets" below/);
});

test("parseVerdict accepts the actions format and enforces the 1-5 cap", () => {
  const ok = parseVerdict(
    '```json\n{"actions":[{"action":"dispatch","title":"A","mandate":"m"},{"action":"steer","ticketId":"tkt_1","text":"hi","mode":"interrupt"}]}\n```',
  );
  assert.equal(ok.verdict.actions.length, 2);
  assert.equal(ok.verdict.actions[1].mode, "interrupt");

  const empty = parseVerdict('{"actions":[]}');
  assert.ok("error" in empty, "an empty action list must be rejected");
  const tooMany = parseVerdict(
    JSON.stringify({ actions: Array.from({ length: 6 }, () => ({ action: "ignore" })) }),
  );
  assert.match(tooMany.error, /verdict schema/);
  const shapeless = parseVerdict('{"decision2":"reply"}');
  assert.match(shapeless.error, /verdict schema/);
});

test("parseVerdict normalizes legacy single-decision verdicts", () => {
  const reply = parseVerdict('{"decision":"reply","reply":"done"}');
  assert.deepEqual(reply.verdict.actions, [{ action: "reply", reply: "done" }]);

  const stop = parseVerdict('{"decision":"stop","rationale":"done talking"}');
  assert.deepEqual(stop.verdict.actions, [{ action: "stop", rationale: "done talking" }]);

  const dispatch = parseVerdict(
    '```json\n{"decision":"dispatch","title":"T","mandate":"m","reply":"on it","unsubscribe":true}\n```',
  );
  assert.deepEqual(dispatch.verdict.actions, [
    { action: "dispatch", title: "T", mandate: "m", unsubscribe: true },
    { action: "reply", reply: "on it" },
  ]);
});

test("parseVerdict reports the actual JSON syntax error and the malformed reply properties", () => {
  const parsed = parseVerdict('```json\n{"actions":[{"action":"reply":"收到"}]}\n```');
  assert.match(parsed.error, /JSON syntax:/);
  assert.match(parsed.error, /position \d+/);
  assert.match(parsed.error, /near/);
  assert.ok(parsed.error.includes('{"action":"reply","reply":"text"}'));
  assert.ok(parsed.error.includes('{"action":"reply":"text"}'));
});

test("parseVerdict reports syntax errors other than malformed reply properties", () => {
  const parsed = parseVerdict('```json\n{"actions":[{"action":"ignore",}]}\n```');
  assert.match(parsed.error, /JSON syntax:/);
  assert.match(parsed.error, /position \d+/);
  assert.ok(!parsed.error.includes("Reply syntax must be"));
});

// 模型多块自我纠正的回复形态:首个围栏块结构错误,第二个围栏块照抄提示词示例的
// 占位值("..." / "tkt_..."),真正的裁决反而是围栏外的裸 JSON(线上实际事故)。

test("parseVerdict rescues the bare final JSON after a broken block and an example-echo block", () => {
  const reply = [
    "```json",
    '{"actions":[{"action":"dispatch","title":"采集","mandate":"完整指令",},{"action":"oops"}],"profile":"p"}',
    "```",
    "Wait — I need to fix the JSON structure. Let me correct:",
    "```json",
    '{"actions":[{"action":"dispatch","title":"...","mandate":"...","profile":"p","unsubscribe":false}]}',
    "```",
    "Replying with the corrected block:",
    '{"actions":[{"action":"dispatch","title":"采集","mandate":"完整指令","profile":"p","unsubscribe":false}]}',
  ].join("\n");
  const parsed = parseVerdict(reply);
  assert.ok(!("error" in parsed), `expected a verdict, got: ${"error" in parsed ? parsed.error : ""}`);
  assert.equal(parsed.verdict.actions.length, 1);
  assert.equal(parsed.verdict.actions[0].mandate, "完整指令");
});

test("parseVerdict keeps trying earlier candidates after a schema failure", () => {
  const reply = '```json\n{"actions":[{"action":"ignore"}]}\n```\nsecond try:\n```json\n{"actions":[]}\n```';
  const parsed = parseVerdict(reply);
  assert.ok(!("error" in parsed));
  assert.equal(parsed.verdict.actions[0].action, "ignore");
});

test("parseVerdict rejects verdicts whose values are example placeholders", () => {
  const dispatch = parseVerdict('```json\n{"actions":[{"action":"dispatch","title":"...","mandate":"..."}]}\n```');
  assert.ok("error" in dispatch);
  assert.match(dispatch.error, /placeholder/);

  const steer = parseVerdict('{"actions":[{"action":"steer","ticketId":"tkt_...","text":"hi there for real"}]}');
  assert.ok("error" in steer);
  assert.match(steer.error, /placeholder/);

  // 占位块被跳过后,若没有其他候选,错误要同时携带占位与解析两段原因。
  const lone = parseVerdict('{"actions":[{"action":"reply","reply":"..."}]}');
  assert.ok("error" in lone);
  assert.match(lone.error, /placeholder/);
});

test("placeholder checks accept terse but real values and catch ellipsis-only ones", () => {
  assert.equal(dispatchMandateIssue("do the job"), null);
  assert.equal(dispatchMandateIssue("修复登录问题"), null);
  assert.ok(dispatchMandateIssue("..."));
  assert.ok(dispatchMandateIssue("。。。"));
  assert.ok(dispatchMandateIssue(" … . "));
  assert.equal(verdictPlaceholderIssue({ actions: [{ action: "ignore" }] }), null);
  assert.equal(
    verdictPlaceholderIssue({ actions: [{ action: "dispatch", title: "T", mandate: "m" }] }),
    null,
  );
  assert.ok(verdictPlaceholderIssue({ actions: [{ action: "retry", ticketId: "tkt_..." }] }));
});

// 跨线程可见性与 Chain of Recall 的提示词面。

test("other active threads appear as steer stubs and truncated texts carry recall pointers", () => {
  const state = emptyState();
  const thread = { id: "t", key: "k", title: "main topic", state: "active", summary: null, createdAt: "", updatedAt: "" };
  state.threads.push(thread);
  state.threads.push({ ...thread, id: "t2", key: "k2", title: "plan B", updatedAt: "2026-02-01T00:00:00.000Z" });
  state.tickets.push({
    id: "tkt_b", threadId: "t2", title: "Other work", mandate: "m", status: "running",
    workerAgentId: "ag", subscribed: true, createdAt: "", updatedAt: "",
  });
  const long = "x".repeat(5000);
  const trigger = {
    id: "trg_long", threadId: "t", threadKey: "k", kind: "manual", sender: "u", text: long,
    status: "pending", context: false, receivedAt: "",
  };
  const prompt = composeEvalPrompt({ thread, batch: [trigger], state, worker: { workingDir: "/repo", isolation: "worktree", issue: null } });
  assert.doesNotMatch(prompt, /## Other active threads|plan B|tkt_b/);
  assert.match(prompt, /\[truncated — full text: superagent_read trg_long\]/);
});

test("delivered context truncation carries a recall pointer", () => {
  const state = emptyState();
  const thread = { id: "t", key: "k", title: "topic", state: "active", summary: null, createdAt: "", updatedAt: "" };
  const long = "y".repeat(2000);
  const context = {
    id: "trg_ctx", threadId: "t", threadKey: "k", kind: "manual", sender: "u", text: long,
    status: "delivered", context: false, receivedAt: "",
  };
  const batch = [{
    id: "trg_new", threadId: "t", threadKey: "k", kind: "manual", sender: "u", text: "go on",
    status: "pending", context: false, receivedAt: "",
  }];
  const prompt = composeEvalPrompt({
    thread, batch, state, worker: { workingDir: "/repo", isolation: "worktree", issue: null },
    contextTriggers: [context],
  });
  assert.match(prompt, /already delivered directly to Workers \(do not dispatch again\nunless a \[handback\] trigger/);
  assert.match(prompt, /\[truncated — full text: superagent_read trg_ctx\]/);
});

test("router rules allow only the recall tools and define handback re-routing", () => {
  const state = emptyState();
  const thread = { id: "t", key: "k", title: "t", state: "active", summary: null, createdAt: "", updatedAt: "" };
  const trigger = { id: "g", threadId: "t", threadKey: "k", kind: "manual", sender: "u", text: "x", status: "pending", context: false, receivedAt: "" };
  const prompt = composeEvalPrompt({ thread, batch: [trigger], state, worker: { workingDir: "/repo", isolation: "worktree", issue: null } });
  assert.match(prompt, /Apart from the orchestrator's own\nread-only recall tools \(superagent_list, superagent_read, superagent_search\), do NOT call any\ntools/);
  assert.match(prompt, /Find other threads, including\s+previous IM days and other IM channels/);
  assert.match(prompt, /When a trigger starts with "\[handback\]"/);
  assert.match(prompt, /Do not steer the same message back to the worker that handed it back/);
  assert.match(prompt, /before steering, canceling, retrying or subscribing/);
});

test("router rules carry the memory discipline and reconciliation guardrail", () => {
  const state = emptyState();
  const thread = { id: "t", key: "k", title: "t", state: "active", summary: null, createdAt: "", updatedAt: "" };
  const trigger = { id: "g", threadId: "t", threadKey: "k", kind: "manual", sender: "u", text: "x", status: "pending", context: false, receivedAt: "" };
  const prompt = composeEvalPrompt({ thread, batch: [trigger], state, worker: { workingDir: "/repo", isolation: "worktree", issue: null } });
  assert.match(prompt, /only the supplied thread memory and records carry facts across evaluations/);
  assert.match(prompt, /Keep open commitments in a ticket mandate,\s+a reply, or sourced thread memory/);
  assert.match(prompt, /Before stop, or any steer\/cancel\/retry against another thread when\s+the target is not certain from the stubs, reconcile the full picture with superagent_list/);
  assert.match(prompt, /superagent_search when you remember only fragments of the target/);
});

test("history stubs keep trigger and decision ids for recall", () => {
  const state = emptyState();
  const thread = { id: "t", key: "k", title: "t", state: "active", summary: null, createdAt: "", updatedAt: "" };
  state.triggers.push({
    id: "trg_old", threadId: "t", threadKey: "k", kind: "manual", sender: "u", text: "old request",
    status: "evaluated", context: false, receivedAt: "2026-01-01T00:00:00.000Z",
  });
  state.decisions.push({
    id: "dec_old", threadId: "t", triggerIds: ["trg_old"], outcome: "reply",
    reply: "old answer", rationale: null, ticketId: null, raw: null, createdAt: "2026-01-01T00:00:01.000Z",
  });
  const trigger = { id: "g", threadId: "t", threadKey: "k", kind: "manual", sender: "u", text: "x", status: "pending", context: false, receivedAt: "2026-01-02T00:00:00.000Z" };
  const prompt = composeEvalPrompt({
    thread, batch: [trigger], state, worker: { workingDir: "/repo", isolation: "worktree", issue: null },
    includeHistory: true, includeInstructions: false,
  });
  assert.match(prompt, /- \[trigger trg_old manual evaluated\] u: old request/);
  assert.match(prompt, /- \[router dec_old reply\] reply="old answer"/);
  // worker report 存根不再内嵌票据状态:状态变化不应漂移已进窗口的行(前缀缓存)。
  state.tickets.push({
    id: "tkt_r", threadId: "t", title: "Report job", mandate: "m", status: "completed", workerAgentId: "ag",
    workspaceId: null, branchName: null, startedAt: null, attempts: 1, subscribed: false,
    report: "work finished", lastError: null, createdAt: "", updatedAt: "2026-01-01T00:00:02.000Z",
  });
  const withReport = composeEvalPrompt({
    thread, batch: [trigger], state,
    worker: { workingDir: "/repo", isolation: "worktree", issue: null }, includeHistory: true, includeInstructions: false,
  });
  assert.match(withReport, /- \[worker report\] "Report job": work finished/);
  const statusFlipped = structuredClone(state);
  statusFlipped.tickets[0].status = "failed";
  const afterFlip = composeEvalPrompt({
    thread, batch: [trigger], state: statusFlipped,
    worker: { workingDir: "/repo", isolation: "worktree", issue: null }, includeHistory: true, includeInstructions: false,
  });
  const prefixOf = (text) => text.slice(0, text.indexOf("summary:") >= 0 ? text.indexOf("summary:") : text.indexOf("## Recently finished tickets"));
  assert.equal(prefixOf(withReport), prefixOf(afterFlip), "a ticket status change does not rewrite history bytes");
});

test("IM-origin threads get channel reply-style guidance; manual threads do not", () => {
  const state = emptyState();
  const thread = { id: "t", key: "k", title: "t", state: "active", summary: null, createdAt: "", updatedAt: "" };
  const imTrigger = {
    id: "g1", threadId: "t", threadKey: "k", kind: "feishu", sender: "u", text: "查一下数据",
    status: "pending", context: false, receivedAt: "",
    origin: { channel: "feishu", chatId: "oc_1", senderId: "u_1" },
  };
  const manualTrigger = {
    id: "g2", threadId: "t2", threadKey: "k2", kind: "manual", sender: "u", text: "详细调研",
    status: "pending", context: false, receivedAt: "",
  };
  const worker = { workingDir: "/repo", isolation: "worktree", issue: null };
  const imPrompt = composeEvalPrompt({ thread, batch: [imTrigger], state, worker, includeInstructions: false });
  assert.doesNotMatch(imPrompt, /Reply style for this channel/);
  assert.match(
    composeRouterInstructions(worker, undefined, { channel: "feishu" }),
    /## Reply style for this channel\nThe human reads your replies inside a chat client \(feishu\)/,
  );
  assert.match(composeRouterInstructions(worker, undefined, { channel: "feishu" }), /under ~100 words/);
  assert.doesNotMatch(composeRouterInstructions(worker), /Reply style for this channel/);
  const manualState = emptyState();
  const manualPrompt = composeEvalPrompt({
    thread: { ...thread, id: "t2", key: "k2" }, batch: [manualTrigger], state: manualState, worker, includeInstructions: false,
  });
  assert.doesNotMatch(manualPrompt, /Reply style for this channel/);
});

test("the channel style guide keeps the instruction prefix stable across turns", () => {
  const worker = { workingDir: "/repo", isolation: "worktree", issue: null };
  const first = composeRouterInstructions(worker, undefined, { channel: "feishu" });
  const second = composeRouterInstructions({ ...worker, workingDir: "/other" }, "Answer in English", { channel: "feishu", speculative: true });
  const guide = "\n\n## Reply style for this channel";
  // 风格指南在提示词末尾且仅按渠道分叉:同渠道跨轮、跨配置字节相同。
  assert.equal(first.slice(first.indexOf(guide)), second.slice(second.indexOf(guide)));
  assert.ok(first.indexOf(guide) > first.indexOf("## Worker environment"));
  assert.doesNotMatch(composeRouterInstructions(worker, undefined, { channel: "dingtalk" }).slice(
    composeRouterInstructions(worker, undefined, { channel: "dingtalk" }).indexOf(guide),
  ), /\(feishu\)/);
});


test("Router static rules and examples stay ahead of variable configuration", () => {
  const worker = { workingDir: "/repo", isolation: "worktree", issue: null };
  const first = composeRouterInstructions(worker, "用中文回答");
  const second = composeRouterInstructions({ ...worker, workingDir: "/other", profiles: [
    { name: "research", provider: "pi/model", description: "research" },
  ] }, "Answer in English", { speculative: true });
  const prefix = first.slice(0, first.indexOf("\n\n## Current Router preferences"));
  assert.ok(prefix.includes('"action":"respond"'));
  assert.ok(prefix.includes('"action":"stop"'));
  assert.ok(second.startsWith(prefix));
  assert.ok(first.indexOf('"action":"stop"') < first.indexOf("用中文回答"));
});

test("fresh evaluation history grows append-only and excludes other threads", () => {
  const state = emptyState();
  for (let i = 0; i < 15; i++) state.triggers.push({
    id: `old-${i}`, threadId: "thread", status: "evaluated", kind: "manual", sender: "user",
    text: `old message ${i}`, receivedAt: String(i).padStart(2, "0"),
  });
  state.triggers.push({ ...state.triggers.at(-1), id: "other", threadId: "other", text: "other thread secret" });
  const prompt = composeEvalPrompt({ thread: { id: "thread", title: "topic" },
    batch: [{ id: "current", text: "current event", sender: "user", kind: "manual" }], state,
    worker: { workingDir: "/repo", isolation: "worktree", issue: null }, includeInstructions: false });
  assert.equal(prompt.match(/^- \[trigger /gm).length, 15, "the window is append-only: every past event is kept");
  assert.match(prompt, /old message 7/);
  assert.match(prompt, /old message 0/);
  assert.doesNotMatch(prompt, /other thread secret/);
});

test("the thread window trims in batches only past its cap", () => {
  const state = emptyState();
  for (let i = 0; i < 41; i++) state.triggers.push({
    id: `old-${i}`, threadId: "thread", status: "evaluated", kind: "manual", sender: "user",
    text: `old message ${i}`, receivedAt: String(i).padStart(2, "0"),
  });
  const prompt = composeEvalPrompt({ thread: { id: "thread", title: "topic" },
    batch: [{ id: "current", text: "current event", sender: "user", kind: "manual" }], state,
    worker: { workingDir: "/repo", isolation: "worktree", issue: null }, includeInstructions: false });
  assert.equal(prompt.match(/^- \[trigger /gm).length, 24, "over the cap the window trims once to the keep size");
  assert.match(prompt, /old message 40/);
  assert.doesNotMatch(prompt, /old message 16/);
});

test("the eval prompt keeps a byte-stable prefix across turns and parks churn after the history", () => {
  const state = emptyState();
  const thread = { id: "t", key: "k", title: "t", state: "active", summary: null, createdAt: "", updatedAt: "" };
  const base = { thread, batch: [{ id: "g", threadId: "t", threadKey: "k", kind: "manual", sender: "u", text: "x", status: "pending", context: false, receivedAt: "" }], state,
    worker: { workingDir: "/repo", isolation: "worktree", issue: null }, includeHistory: true, includeInstructions: false };
  const first = composeEvalPrompt(base);
  // 第一轮已有一条已评估事件:第二轮窗口只追加,头部+历史字节不变。
  state.triggers.push({ id: "g0", threadId: "t", threadKey: "k", kind: "manual", sender: "u", text: "earlier", status: "evaluated", context: false, receivedAt: "2020-01-01T00:00:00.000Z" });
  const later = composeEvalPrompt(base);
  const grown = composeEvalPrompt({ ...base, thread: { ...thread, summary: "先前的总结", routerMemory: [{ text: "文档优先", triggerId: "g0" }] } });
  // summary/memory 变化不打断前缀:历史之前的头部与历史本身字节稳定。
  assert.ok(grown.startsWith(later.slice(0, later.indexOf("## New triggers"))), "the prefix through the history survives summary and memory changes");
  assert.ok(grown.indexOf("## Recent thread history") < grown.indexOf("summary: 先前的总结"));
  assert.ok(grown.indexOf("## Recent thread history") < grown.indexOf("## Saved thread memory"));
});
