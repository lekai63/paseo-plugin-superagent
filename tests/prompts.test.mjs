import assert from "node:assert/strict";
import test from "node:test";
import { composeEvalPrompt } from "../server/router.ts";
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
  assert.match(prompt, /If answering would need a lookup, dispatch instead/);
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
  assert.equal(taskDirectory("/srv/tmp", ticket), "/srv/tmp/tasks/20261102-整理-report-xyz789");
  const shared = composeWorkerPrompt(ticket, "/srv/tmp", "shared");
  assert.match(shared, /Your task directory is \/srv\/tmp\/tasks\/20261102-整理-report-xyz789 — create it/);
  assert.match(shared, /only modify files outside your task directory when the mandate explicitly names them/);
  assert.doesNotMatch(composeWorkerPrompt(ticket, "/srv/tmp", "worktree"), /task directory/);
});
