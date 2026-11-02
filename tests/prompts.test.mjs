import assert from "node:assert/strict";
import test from "node:test";
import { composeEvalPrompt, parseVerdict } from "../server/router.ts";
import { composeWorkerPrompt, taskDirectory } from "../server/workers.ts";
import { emptyState } from "../shared/model.ts";

// ACP providers (e.g. zcode-acp) drop systemPrompt, so the role rules must travel in the prompts.

test("every Router eval prompt carries the decision-only rules before the thread", () => {
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
  assert.match(prompt, /do NOT call any tools/);
  assert.match(prompt, /dispatch \(the default for real work\)/);
  assert.match(prompt, /SEVERAL dispatches/);
  assert.match(prompt, /If answering would need a lookup, dispatch instead/);
  assert.match(prompt, /\{"actions":\[\.\.\.\]\}/);
  assert.match(prompt, /\{"actions":\[\{"action":"steer","ticketId":"tkt_\.\.\./);
  assert.ok(prompt.indexOf("You are the Router") < prompt.indexOf("# Thread: test"));
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
    assert.ok(prompt.indexOf("[Execution environment]") < prompt.indexOf("# Ticket: Do it"));
    assert.ok(prompt.endsWith("the mandate"));
  }
});

test("shared isolation gives each ticket its own task directory", () => {
  const ticket = { id: "tkt_abc123xyz789", title: "整理 Report", mandate: "m", createdAt: "2026-11-02T04:00:00.000Z" };
  const created = new Date(ticket.createdAt);
  const pad = (value) => String(value).padStart(2, "0");
  const localDate = `${created.getFullYear()}${pad(created.getMonth() + 1)}${pad(created.getDate())}`;
  const dir = `/srv/tmp/tasks/${localDate}-整理-report-xyz789`;
  assert.equal(taskDirectory("/srv/tmp", ticket), dir);
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
  assert.match(prompt, /Terminal tickets are listed under "Recently finished tickets" below/);
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
