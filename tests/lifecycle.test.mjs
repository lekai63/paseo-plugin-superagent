import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { SuperagentEngine } from "../server/engine.ts";
import { FeishuSource } from "../server/feishu.ts";
import { emptyState } from "../shared/model.ts";
import { SETTINGS_DEFAULTS } from "../shared/settings.ts";

const oldTime = "2020-01-01T00:00:00.000Z";

const PROVIDER_ENTRIES = [
  { provider: "codex", enabled: true, status: "ready", models: [{ id: "test", isDefault: true }] },
  {
    provider: "zcode-acp", enabled: true, status: "ready",
    models: [{ id: "builtin:plan\\GLM-Flash", isDefault: false }, { id: "builtin:plan\\GLM", isDefault: true }],
  },
];

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function until(predicate) {
  for (let i = 0; i < 50; i++) {
    if (predicate()) return;
    await setImmediate();
  }
  assert.fail("expected lifecycle transition did not occur");
}

function fixture(t, status = "running", subscribed = true) {
  const state = emptyState();
  Object.assign(state.kv, {
    routerAgentId: "router", routerProvider: "codex/test", workerProvider: "codex/test",
  });
  state.threads.push({
    id: "thread", key: "manual:test", title: "test", state: "active", summary: null,
    createdAt: oldTime, updatedAt: oldTime,
  });
  const hasWorker = !["pending", "launching"].includes(status);
  state.tickets.push({
    id: "ticket", threadId: "thread", title: "test", mandate: "do the work", status,
    workerAgentId: hasWorker ? "worker" : null, workspaceId: hasWorker ? "workspace" : null,
    startedAt: oldTime, attempts: status === "pending" ? 0 : 1, subscribed,
    report: null, lastError: null, createdAt: oldTime, updatedAt: oldTime,
  });
  const calls = {
    sends: [], watches: [], archives: [], workspaceArchives: [], creates: 0, evals: [],
    routerCreates: [], workerCreates: [], prompts: [],
  };
  const controls = {
    send: async () => {},
    createAgent: async () => ({ id: "new-worker" }),
    timeline: async () => ({ entries: [{ seqStart: 1, item: { type: "assistant_message", text: "work completed" } }] }),
    verdict: { decision: "reply", reply: "done" },
    isGit: true,
    instructionFiles: [],
    /** worktree 创建后工作区 descriptor 报告的实际分支;null 表示未报告(退回请求名)。 */
    workspaceBranch: null,
  };
  const finishes = [];
  const handles = new Map();
  const ref = (id) => {
    if (!handles.has(id)) handles.set(id, {
      id,
      refresh: async () => ({ agent: { status: id === "router" ? "idle" : "running", archivedAt: null } }),
      send: async (text, options) => {
        calls.sends.push({ id, text, options });
        await controls.send(text, options);
      },
      run: async (prompt) => {
        calls.prompts.push(prompt);
        return { lastMessage: JSON.stringify(controls.verdict) };
      },
      waitForFinish: () => {
        calls.watches.push(id);
        const finish = deferred();
        finishes.push(finish);
        return finish.promise;
      },
      timeline: { refetch: () => controls.timeline() },
      archive: async () => { calls.archives.push(id); },
    });
    return handles.get(id);
  };
  const paseo = {
    agents: {
      ref,
      create: async (options) => {
        calls.routerCreates.push(options);
        return ref("new-router");
      },
    },
    providers: {
      waitForReady: async () => ({ entries: PROVIDER_ENTRIES }),
      snapshot: async () => ({ entries: PROVIDER_ENTRIES }),
    },
    workspaces: {
      create: async () => {
        calls.creates++;
        const descriptor = { gitRuntime: { currentBranch: controls.workspaceBranch } };
        return {
          id: "new-workspace",
          current: () => descriptor,
          refresh: async () => descriptor,
          agents: {
            create: (options) => {
              calls.workerCreates.push(options);
              return controls.createAgent(options);
            },
          },
          archive: async () => { calls.workspaceArchives.push("new-workspace"); },
        };
      },
      ref: (id) => ({ archive: async () => { calls.workspaceArchives.push(id); } }),
    },
  };
  const store = {
    ready: Promise.resolve(), get: () => state,
    update: async (mutate) => { mutate(state); return state; }, flush: async () => {},
  };
  const values = {
    ...SETTINGS_DEFAULTS, workingDir: "/mock/repo", routerProvider: "codex/test", workerProvider: "codex/test",
  };
  const engine = new SuperagentEngine(store, {
    subscribe: () => {}, read: async () => ({ status: "ready", values }),
  });
  engine.paseo = paseo;
  engine.workingDirProbe = {
    isDirectory: async () => true,
    isFile: async (path) => controls.instructionFiles.some((name) => path === `/mock/repo/${name}`),
    isGitWorkTree: async () => controls.isGit,
  };
  engine.primed = true;
  engine.scheduleEval = (id) => { calls.evals.push(id); };
  t.after(() => engine.stop());
  return { engine, state, calls, controls, finishes, ref, values, ticket: state.tickets[0] };
}

function pendingTrigger(state) {
  state.triggers.push({
    id: "trigger", threadId: "thread", threadKey: "manual:test", kind: "manual", sender: "user",
    text: "stop", status: "pending", context: false, receivedAt: oldTime,
  });
}

test("a waiting worker resumes tracking and produces a report for its follow-up", async (t) => {
  const f = fixture(t, "waiting");
  const origin = { channel: "dingtalk", chatId: "chat", senderId: "user", replyRef: "latest-webhook" };
  const result = await f.engine.dispatch({ threadId: "thread", task: "follow-up", origin });
  assert.equal(result.directDelivered, true);
  assert.equal(f.ticket.status, "running");
  assert.ok(Date.parse(f.ticket.startedAt) > Date.parse(oldTime));
  assert.deepEqual(f.calls.watches, ["worker"]);
  f.finishes[0].resolve({ status: "idle" });
  await until(() => f.state.triggers.some((trigger) => trigger.kind === "report"));
  assert.equal(f.ticket.status, "waiting");
  assert.equal(f.ticket.report, "work completed");
  assert.deepEqual(f.state.triggers.find((trigger) => trigger.kind === "report").origin, origin);
});

test("steering an already running worker keeps its deadline and existing watcher", async (t) => {
  const f = fixture(t);
  f.engine.watchTicket("ticket");
  const result = await f.engine.dispatch({ threadId: "thread", task: "more context" });
  assert.equal(result.directDelivered, true);
  assert.equal(f.ticket.startedAt, oldTime);
  assert.deepEqual(f.calls.watches, ["worker"]);
  assert.equal(f.calls.sends[0].options.activeTurnBehavior, "steer");
});

test("a failed direct send returns false and the Router evaluates the original message", async (t) => {
  const f = fixture(t, "waiting");
  f.controls.send = async () => { throw new Error("offline"); };
  const result = await f.engine.dispatch({ threadId: "thread", task: "preserve this message" });
  assert.equal(result.directDelivered, false);
  assert.equal(f.state.triggers[0].status, "pending");
  assert.match(f.state.triggers[0].note, /offline/);
  assert.equal(f.ticket.status, "waiting");
  assert.deepEqual(f.calls.evals, ["thread"]);
  await f.engine.runEval("thread");
  assert.equal(f.state.triggers[0].status, "evaluated");
  assert.equal(f.state.triggers[0].text, "preserve this message");
  assert.equal(f.state.decisions[0].outcome, "reply");
});

test("a subscribed ticket without a worker falls back to Router evaluation", async (t) => {
  const f = fixture(t, "waiting");
  f.ticket.workerAgentId = null;
  const result = await f.engine.dispatch({ threadId: "thread", task: "follow-up" });
  assert.equal(result.directDelivered, false);
  assert.equal(f.state.triggers[0].status, "pending");
  assert.deepEqual(f.calls.evals, ["thread"]);
});

test("canceling during launch retires the late worker and workspace", async (t) => {
  const f = fixture(t, "pending");
  const created = deferred();
  f.controls.createAgent = () => created.promise;
  const launching = f.engine.startTicket("ticket");
  await until(() => f.calls.creates === 1);
  await f.engine.cancelTicket("ticket");
  created.resolve({ id: "late-worker" });
  await launching;
  assert.equal(f.ticket.status, "canceled");
  assert.deepEqual(f.calls.archives, ["late-worker"]);
  assert.deepEqual(f.calls.workspaceArchives, ["new-workspace"]);
  assert.deepEqual(f.calls.watches, []);
});

test("a canceled launch that fails does not retry or enqueue a failure report", async (t) => {
  const f = fixture(t, "pending");
  const created = deferred();
  f.controls.createAgent = () => created.promise;
  const launching = f.engine.startTicket("ticket");
  await until(() => f.calls.creates === 1);
  await f.engine.cancelTicket("ticket");
  created.reject(new Error("creation failed"));
  await launching;
  assert.equal(f.ticket.status, "canceled");
  assert.equal(f.calls.creates, 1);
  assert.deepEqual(f.state.triggers, []);
  assert.deepEqual(f.calls.workspaceArchives, ["new-workspace"]);
});

test("canceling during provider discovery prevents worker creation", async (t) => {
  const f = fixture(t, "pending");
  const provider = deferred();
  f.engine.resolveProvider = () => provider.promise;
  const launching = f.engine.startTicket("ticket");
  await setImmediate();
  await f.engine.cancelTicket("ticket");
  provider.resolve("codex/test");
  await launching;
  assert.equal(f.ticket.status, "canceled");
  assert.equal(f.calls.creates, 0);
});

for (const closer of ["closeThread", "Router stop"]) {
  test(`${closer} during launch retires the late worker and workspace`, async (t) => {
    const f = fixture(t, "pending", false);
    const created = deferred();
    f.controls.createAgent = () => created.promise;
    const launching = f.engine.startTicket("ticket");
    await until(() => f.calls.creates === 1);
    if (closer === "closeThread") {
      await f.engine.closeThread("thread");
    } else {
      pendingTrigger(f.state);
      f.controls.verdict = { decision: "stop" };
      await f.engine.runEval("thread");
    }
    created.resolve({ id: "late-worker" });
    await launching;
    assert.equal(f.ticket.status, "canceled");
    assert.equal(f.state.threads[0].state, "closed");
    assert.deepEqual(f.calls.archives, ["late-worker"]);
    assert.deepEqual(f.calls.workspaceArchives, ["new-workspace"]);
    assert.deepEqual(f.calls.watches, []);
  });
}

test("closing a thread retires unsubscribed workers", async (t) => {
  const f = fixture(t, "running", false);
  await f.engine.closeThread("thread");
  assert.equal(f.ticket.status, "canceled");
  assert.equal(f.state.threads[0].state, "closed");
  assert.deepEqual(f.calls.archives, ["worker"]);
  assert.deepEqual(f.calls.workspaceArchives, ["workspace"]);
});

test("Router stop retires every active worker, including unsubscribed and launching tickets", async (t) => {
  const f = fixture(t, "running", false);
  f.state.tickets.push({ ...f.ticket, id: "launching", status: "launching", workerAgentId: "starting-worker", workspaceId: "starting-workspace" });
  f.state.tickets.push({ ...f.ticket, id: "completed", status: "completed", workerAgentId: "finished-worker" });
  pendingTrigger(f.state);
  f.controls.verdict = { decision: "stop" };
  await f.engine.runEval("thread");
  assert.deepEqual(f.calls.archives.sort(), ["starting-worker", "worker"]);
  assert.deepEqual(f.calls.workspaceArchives.sort(), ["starting-workspace", "workspace"]);
  assert.deepEqual(f.state.tickets.map((ticket) => ticket.status), ["canceled", "canceled", "completed"]);
});

test("a fan-out verdict dispatches one worker per independent ask", async (t) => {
  const f = fixture(t, "completed");
  pendingTrigger(f.state);
  f.controls.verdict = {
    actions: [
      { action: "dispatch", title: "First", mandate: "do the first thing" },
      { action: "dispatch", title: "Second", mandate: "do the second thing", unsubscribe: true },
    ],
  };
  await f.engine.runEval("thread");
  await until(() => f.calls.creates === 2);
  await until(() => f.state.tickets.filter((ticket) => ticket.status === "running").length === 2);
  assert.deepEqual(f.state.decisions.map((decision) => decision.outcome), ["dispatch", "dispatch"]);
  const launched = f.state.tickets.filter((ticket) => ticket.title !== "test");
  assert.deepEqual(launched.map((ticket) => ticket.subscribed), [true, false]);
  assert.equal(f.state.triggers[0].status, "evaluated");
  assert.equal(f.state.threads[0].state, "active");
});

test("a Router steer action reaches the ticket's worker and revives a waiting one", async (t) => {
  const f = fixture(t, "waiting");
  pendingTrigger(f.state);
  f.controls.verdict = {
    actions: [{ action: "steer", ticketId: "ticket", text: "focus on the parser first", mode: "interrupt" }],
  };
  await f.engine.runEval("thread");
  assert.equal(f.calls.sends.length, 1);
  assert.ok(f.calls.sends[0].text.includes("focus on the parser first"));
  assert.equal(f.calls.sends[0].options.activeTurnBehavior, "interrupt");
  assert.equal(f.ticket.status, "running");
  assert.deepEqual(f.state.decisions.map((decision) => decision.outcome), ["steer"]);
  assert.equal(f.state.decisions[0].ticketId, "ticket");
  assert.equal(f.state.triggers[0].status, "evaluated");
  assert.deepEqual(f.calls.watches, ["worker"]);
});

test("a failed steer stays as a retriable pending action without replaying the batch", async (t) => {
  const f = fixture(t, "waiting");
  f.controls.send = async () => { throw new Error("offline"); };
  pendingTrigger(f.state);
  f.controls.verdict = { actions: [{ action: "steer", ticketId: "ticket", text: "hello?" }] };
  await f.engine.runEval("thread");
  assert.equal(f.state.decisions[0].outcome, "steer");
  assert.equal(f.state.triggers[0].status, "evaluated");
  assert.equal(f.state.pendingActions.length, 1);
  assert.equal(f.state.pendingActions[0].attempts, 1);
  assert.equal(f.ticket.status, "waiting");
});

test("a dispatch before a failing steer runs exactly once and the failure reflows to the Router", async (t) => {
  const f = fixture(t, "running");
  f.ticket.startedAt = new Date().toISOString();
  f.controls.send = async () => { throw new Error("offline"); };
  pendingTrigger(f.state);
  f.controls.verdict = {
    actions: [
      { action: "dispatch", title: "Job", mandate: "do the job" },
      { action: "steer", ticketId: "ticket", text: "and also this" },
    ],
  };
  await f.engine.runEval("thread");
  await until(() => f.calls.creates === 1);
  await until(() => f.state.tickets.filter((ticket) => ticket.title === "Job").length === 1);
  // 看门狗重试耗尽尝试上限后放弃,失败回流成触发,原批触发保持已消费。
  await f.engine.reconcile();
  await until(() => f.state.pendingActions[0]?.attempts === 2);
  await f.engine.reconcile();
  await until(() => f.state.pendingActions.length === 0);
  assert.equal(f.state.tickets.filter((ticket) => ticket.title === "Job").length, 1);
  const failure = f.state.triggers.find((trigger) => trigger.sender === "engine");
  assert.equal(failure.kind, "engine");
  assert.equal(failure.status, "pending");
  assert.match(failure.text, /Router steer action failed after 3 attempts: offline/);
  assert.match(failure.text, /Undelivered instruction for ticket: "and also this"/);
  assert.equal(f.state.triggers[0].status, "evaluated");
  assert.match(f.state.triggers[0].note, /steer action failed: offline/);
});

test("recovery re-executes a persisted cancel action after a restart", async (t) => {
  const f = fixture(t);
  f.ticket.startedAt = new Date().toISOString();
  f.state.pendingActions.push({
    id: "act_restart", threadId: "thread", decisionId: "dec_restart", kind: "cancel",
    ticketId: "ticket", text: null, mode: null, attempts: 0, createdAt: oldTime,
  });
  await f.engine.recover();
  await until(() => f.state.pendingActions.length === 0);
  assert.equal(f.ticket.status, "canceled");
  assert.deepEqual(f.calls.archives, ["worker"]);
  assert.deepEqual(f.calls.workspaceArchives, ["workspace"]);
});

test("recovery re-executes a persisted steer action after a restart", async (t) => {
  const f = fixture(t);
  f.ticket.startedAt = new Date().toISOString();
  f.state.pendingActions.push({
    id: "act_restart", threadId: "thread", decisionId: "dec_restart", kind: "steer",
    ticketId: "ticket", text: "focus on tests", mode: "interrupt", attempts: 0, createdAt: oldTime,
  });
  await f.engine.recover();
  await until(() => f.state.pendingActions.length === 0);
  assert.equal(f.calls.sends.length, 1);
  assert.ok(f.calls.sends[0].text.includes("focus on tests"));
  assert.equal(f.calls.sends[0].options.activeTurnBehavior, "interrupt");
});

test("a steer before stop is delivered before the thread closes", async (t) => {
  const f = fixture(t);
  pendingTrigger(f.state);
  f.controls.verdict = {
    actions: [
      { action: "steer", ticketId: "ticket", text: "wrap up now", mode: "interrupt" },
      { action: "stop", rationale: "conversation done" },
    ],
  };
  await f.engine.runEval("thread");
  assert.equal(f.calls.sends.length, 1);
  assert.ok(f.calls.sends[0].text.includes("wrap up now"));
  assert.equal(f.ticket.status, "canceled");
  assert.equal(f.state.threads[0].state, "closed");
  assert.deepEqual(f.calls.archives, ["worker"]);
  assert.deepEqual(f.calls.workspaceArchives, ["workspace"]);
  assert.equal(f.state.triggers[0].status, "evaluated");
  assert.equal(f.state.pendingActions.length, 0);
});

test("follow-ups on a thread with several subscribed tickets go through the Router", async (t) => {
  const f = fixture(t);
  f.state.tickets.push({
    ...f.ticket, id: "ticket2", workerAgentId: "worker2", workspaceId: "workspace2",
  });
  const result = await f.engine.dispatch({ threadId: "thread", task: "cancel the second task" });
  assert.equal(result.directDelivered, false);
  assert.deepEqual(f.calls.evals, ["thread"]);
  assert.equal(f.state.triggers[0].status, "pending");
  assert.deepEqual(f.calls.sends, []);
});

test("a renamed worktree branch is read back from the created workspace", async (t) => {
  const f = fixture(t, "pending");
  f.controls.workspaceBranch = "superagent/test-ticket-2";
  await f.engine.startTicket("ticket");
  assert.equal(f.ticket.branchName, "superagent/test-ticket-2");
});

test("steering a ticket that has no worker yet keeps the steer as a pending action", async (t) => {
  const f = fixture(t, "launching");
  pendingTrigger(f.state);
  f.controls.verdict = { actions: [{ action: "steer", ticketId: "ticket", text: "go" }] };
  await f.engine.runEval("thread");
  assert.deepEqual(f.calls.sends, []);
  assert.equal(f.state.triggers[0].status, "evaluated");
  assert.equal(f.state.pendingActions.length, 1);
  assert.equal(f.state.pendingActions[0].attempts, 1);
});

test("a Router cancel action cancels exactly one ticket and keeps the thread open", async (t) => {
  const f = fixture(t, "running", false);
  f.state.tickets.push({
    ...f.ticket, id: "other", title: "other", workerAgentId: "worker2", workspaceId: "workspace2",
  });
  pendingTrigger(f.state);
  f.controls.verdict = { actions: [{ action: "cancel", ticketId: "other", rationale: "wrong approach" }] };
  await f.engine.runEval("thread");
  assert.equal(f.state.threads[0].state, "active");
  assert.equal(f.ticket.status, "running");
  assert.equal(f.state.tickets.find((ticket) => ticket.id === "other").status, "canceled");
  assert.deepEqual(f.calls.archives, ["worker2"]);
  assert.deepEqual(f.calls.workspaceArchives, ["workspace2"]);
  assert.equal(f.state.triggers[0].status, "evaluated");
});

test("a Router retry action relaunches a failed ticket", async (t) => {
  const f = fixture(t, "failed");
  pendingTrigger(f.state);
  f.controls.verdict = { actions: [{ action: "retry", ticketId: "ticket" }] };
  await f.engine.runEval("thread");
  await until(() => f.calls.creates === 1);
  await until(() => f.ticket.status === "running");
  assert.equal(f.ticket.workerAgentId, "new-worker");
  assert.deepEqual(f.state.decisions.map((decision) => decision.outcome), ["retry"]);
  assert.equal(f.state.triggers[0].status, "evaluated");
});

test("worktree workers surface their branch on the ticket and in the Router prompt", async (t) => {
  const f = fixture(t, "pending");
  await f.engine.startTicket("ticket");
  assert.equal(f.ticket.branchName, "superagent/test-ticket");
  pendingTrigger(f.state);
  f.controls.verdict = { actions: [{ action: "ignore", rationale: "status check" }] };
  await f.engine.runEval("thread");
  assert.match(
    f.calls.prompts.at(-1),
    /- \[ticket\] "test" status=running subscribed=true branch=superagent\/test-ticket/,
  );
});

test("recovery launches a persisted pending ticket once despite overlapping reconciliation", async (t) => {
  const f = fixture(t, "pending");
  await Promise.all([f.engine.recover(), f.engine.reconcile(), f.engine.reconcile()]);
  await until(() => f.ticket.status === "running");
  assert.equal(f.calls.creates, 1);
  assert.equal(f.ticket.attempts, 1);
  assert.equal(f.ticket.workerAgentId, "new-worker");
  assert.deepEqual(f.calls.watches, ["new-worker"]);
});

test("recovery does not launch pending work belonging to a closed thread", async (t) => {
  const f = fixture(t, "pending");
  f.state.threads[0].state = "closed";
  await f.engine.recover();
  await setImmediate();
  assert.equal(f.calls.creates, 0);
});

test("closing a thread during Router evaluation discards the late dispatch verdict", async (t) => {
  const f = fixture(t, "completed");
  pendingTrigger(f.state);
  const verdict = deferred();
  const entered = deferred();
  f.ref("router").run = () => { entered.resolve(); return verdict.promise; };
  const evaluating = f.engine.runEval("thread");
  await entered.promise;
  await f.engine.closeThread("thread");
  verdict.resolve({ lastMessage: JSON.stringify({ decision: "dispatch", title: "late", mandate: "do work" }) });
  await evaluating;
  assert.equal(f.state.tickets.length, 1);
  assert.equal(f.calls.creates, 0);
  assert.equal(f.state.decisions.length, 0);
});

test("cancellation during report collection remains canceled", async (t) => {
  const f = fixture(t);
  const report = deferred();
  const entered = deferred();
  f.controls.timeline = () => { entered.resolve(); return report.promise; };
  const settling = f.engine.settleTicketRun("ticket", null);
  await entered.promise;
  await f.engine.cancelTicket("ticket");
  report.resolve({ entries: [] });
  await settling;
  assert.equal(f.ticket.status, "canceled");
  assert.deepEqual(f.state.triggers, []);
});

test("Feishu stop closes its connection and is idempotent", async () => {
  const source = new FeishuSource({ appId: "mock", appSecret: "mock", allowUsers: [], allowChats: [] });
  const closes = [];
  source.wsClient = { close: (options) => closes.push(options) };
  source.client = {};
  await source.stop();
  await source.stop();
  assert.deepEqual(closes, [{ force: true }]);
  assert.equal(source.wsClient, null);
  assert.equal(source.client, null);
  assert.equal(source.stopped, true);
});

test("Feishu stop clears references even when closing throws", async () => {
  const source = new FeishuSource({ appId: "mock", appSecret: "mock", allowUsers: [], allowChats: [] });
  source.wsClient = { close: () => { throw new Error("close failed"); } };
  source.client = {};
  await assert.rejects(source.stop(), /close failed/);
  assert.equal(source.wsClient, null);
  assert.equal(source.client, null);
});

test("an over-escaped router model id is normalized before creating the Router", async (t) => {
  const f = fixture(t);
  f.state.kv.routerAgentId = null;
  f.values.routerProvider = "zcode-acp/builtin:plan\\\\GLM-Flash";
  pendingTrigger(f.state);
  await f.engine.runEval("thread");
  assert.equal(f.calls.routerCreates.length, 1);
  assert.equal(f.calls.routerCreates[0].config.provider, "zcode-acp/builtin:plan\\GLM-Flash");
  assert.equal(f.state.kv.routerAgentId, "new-router");
  assert.equal(f.state.kv.routerProvider, "zcode-acp/builtin:plan\\GLM-Flash");
});

test("an unknown router model fails the eval with the available model ids instead of creating an agent", async (t) => {
  const f = fixture(t);
  f.state.kv.routerAgentId = null;
  f.values.routerProvider = "zcode-acp/nope";
  pendingTrigger(f.state);
  await assert.rejects(f.engine.runEval("thread"), (error) => {
    assert.match(error.message, /router provider setting "zcode-acp\/nope" is invalid/);
    assert.match(error.message, /builtin:plan\\GLM-Flash/);
    return true;
  });
  assert.equal(f.calls.routerCreates.length, 0);
});

test("Router creation failures name the provider", async (t) => {
  const f = fixture(t);
  f.state.kv.routerAgentId = null;
  f.values.routerProvider = "zcode-acp/builtin:plan\\GLM";
  pendingTrigger(f.state);
  f.engine.paseo.agents.create = async () => { throw new Error("Internal error"); };
  await assert.rejects(
    f.engine.runEval("thread"),
    /router agent creation failed \(provider "zcode-acp\/builtin:plan\\GLM", cwd \/mock\/repo\): Internal error/,
  );
});

test("an invalid worker model keeps the ticket pending with a readable lastError", async (t) => {
  const f = fixture(t, "pending");
  f.values.workerProvider = "zcode-acp/nope";
  await assert.rejects(f.engine.startTicket("ticket"), /worker provider setting/);
  assert.equal(f.ticket.status, "pending");
  assert.match(f.ticket.lastError, /model "nope" is not offered by provider "zcode-acp"/);
  assert.equal(f.calls.creates, 0);
});

test("an over-escaped worker model id is normalized before launching the worker", async (t) => {
  const f = fixture(t, "pending");
  f.values.workerProvider = "zcode-acp/builtin:plan\\\\GLM";
  await f.engine.startTicket("ticket");
  assert.equal(f.ticket.status, "running");
  assert.equal(f.calls.workerCreates[0].config.provider, "zcode-acp/builtin:plan\\GLM");
});

test("a non-git base directory fails the launch with the directory and isolation named", async (t) => {
  const f = fixture(t, "pending");
  f.controls.isGit = false;
  await f.engine.startTicket("ticket");
  assert.equal(f.calls.creates, 0);
  assert.equal(f.ticket.status, "failed");
  assert.match(f.ticket.lastError, /\/mock\/repo is not a git repository, but workerIsolation=worktree/);
  const report = f.state.triggers.find((trigger) => trigger.kind === "report");
  assert.match(report.text, /Launch failed: worker working directory \/mock\/repo is not a git repository/);
});

test("workspace creation errors name the base directory and isolation", async (t) => {
  const f = fixture(t, "pending");
  f.engine.paseo.workspaces.create = async () => { throw new Error("Create worktree requires a git repository"); };
  await f.engine.startTicket("ticket");
  assert.match(
    f.ticket.lastError,
    /worker workspace creation failed \(base \/mock\/repo, isolation worktree\): Create worktree requires a git repository/,
  );
});

test("the Router sees the worker base directory and any problem with it", async (t) => {
  const f = fixture(t);
  f.controls.isGit = false;
  pendingTrigger(f.state);
  await f.engine.runEval("thread");
  const prompt = f.calls.prompts.at(-1);
  assert.match(prompt, /## Worker environment\nbase directory: \/mock\/repo\nisolation: worktree/);
  assert.match(prompt, /PROBLEM: worker working directory \/mock\/repo is not a git repository/);
  assert.match(f.engine.snapshot().workingDirIssue, /not a git repository/);
});

test("a usable base directory reports no problem to the Router or the snapshot", async (t) => {
  const f = fixture(t);
  pendingTrigger(f.state);
  await f.engine.runEval("thread");
  assert.doesNotMatch(f.calls.prompts.at(-1), /PROBLEM:/);
  assert.equal(f.engine.snapshot().workingDirIssue, null);
});

test("shared workers and the Router are pointed at the base directory's AGENTS.md filing rules", async (t) => {
  const f = fixture(t, "pending");
  f.values.workerIsolation = "shared";
  f.controls.instructionFiles = ["AGENTS.md"];
  await f.engine.startTicket("ticket");
  assert.equal(f.ticket.branchName, null);
  const prompt = f.calls.workerCreates[0].prompt;
  assert.match(prompt, /own project instructions: \/mock\/repo\/AGENTS\.md/);
  assert.match(prompt, /Their rules on where outputs go take priority/);

  pendingTrigger(f.state);
  f.state.tickets[0].status = "completed";
  await f.engine.runEval("thread");
  assert.match(f.calls.prompts.at(-1), /The base directory has its own project instructions \(AGENTS\.md\)/);
});

test("worktree workers are not told about base-directory instruction files", async (t) => {
  const f = fixture(t, "pending");
  f.controls.instructionFiles = ["AGENTS.md"];
  await f.engine.startTicket("ticket");
  assert.doesNotMatch(f.calls.workerCreates[0].prompt, /project instructions/);
});

const GLM = "zcode-acp/builtin:plan\\GLM";
const WORKER_PROFILES = [
  { name: "glm", provider: GLM, description: "Chinese reports and research" },
  { name: "flash", provider: "zcode-acp/builtin:plan\\GLM-Flash", description: "quick lookups" },
];

test("dispatches run each ticket on the provider of its chosen worker profile", async (t) => {
  const f = fixture(t, "completed");
  f.values.workerProfiles = WORKER_PROFILES;
  pendingTrigger(f.state);
  f.controls.verdict = {
    actions: [
      { action: "dispatch", title: "Code", mandate: "fix the bug" },
      { action: "dispatch", title: "Report", mandate: "write the report", profile: "glm" },
    ],
  };
  await f.engine.runEval("thread");
  await until(() => f.calls.workerCreates.length === 2);
  await until(() => f.state.tickets.filter((ticket) => ticket.status === "running").length === 2);
  const providers = f.calls.workerCreates.map((options) => options.config.provider).sort();
  assert.deepEqual(providers, ["codex/test", GLM].sort());
  const [code, report] = ["Code", "Report"].map((title) => f.state.tickets.find((ticket) => ticket.title === title));
  assert.deepEqual([code.profile, code.provider], [null, "codex/test"]);
  assert.deepEqual([report.profile, report.provider], ["glm", GLM]);
  assert.equal(f.state.kv.workerProvider, "codex/test", "a named profile never overwrites the default worker");
  assert.match(f.calls.prompts.at(-1), /## Worker profiles/);
  assert.match(f.calls.prompts.at(-1), /- default \(codex\/test\): general work that fits no other profile/);
});

test("an unknown profile from the Router falls back to the default worker and is recorded", async (t) => {
  const f = fixture(t, "completed");
  f.values.workerProfiles = WORKER_PROFILES;
  pendingTrigger(f.state);
  f.controls.verdict = { actions: [{ action: "dispatch", title: "Any", mandate: "m", profile: "codex/gpt-9" }] };
  await f.engine.runEval("thread");
  await until(() => f.calls.workerCreates.length === 1);
  assert.equal(f.calls.workerCreates[0].config.provider, "codex/test");
  const ticket = f.state.tickets.find((candidate) => candidate.title === "Any");
  assert.equal(ticket.profile, null);
  assert.match(f.state.decisions[0].rationale, /unknown worker profile "codex\/gpt-9" \(configured: glm, flash\)/);
});

test("retry keeps the ticket's profile and picks up that profile's current model", async (t) => {
  const f = fixture(t, "failed");
  f.values.workerProfiles = WORKER_PROFILES;
  Object.assign(f.ticket, { profile: "glm", provider: GLM });
  f.values.workerProfiles = [{ ...WORKER_PROFILES[0], provider: "zcode-acp/builtin:plan\\GLM-Flash" }];
  await f.engine.retryTicket("ticket");
  assert.equal(f.ticket.status, "running");
  assert.equal(f.ticket.profile, "glm");
  assert.equal(f.calls.workerCreates[0].config.provider, "zcode-acp/builtin:plan\\GLM-Flash");
  assert.equal(f.ticket.provider, "zcode-acp/builtin:plan\\GLM-Flash");
});

test("a profile removed from settings launches on the default worker", async (t) => {
  const f = fixture(t, "pending");
  f.ticket.profile = "gone";
  await f.engine.startTicket("ticket");
  assert.equal(f.calls.workerCreates[0].config.provider, "codex/test");
  assert.equal(f.ticket.profile, null);
  assert.equal(f.ticket.provider, "codex/test");
});

test("an invalid profile model keeps the ticket pending and names the profile", async (t) => {
  const f = fixture(t, "pending");
  f.values.workerProfiles = [{ ...WORKER_PROFILES[0], provider: "zcode-acp/nope" }];
  f.ticket.profile = "glm";
  await assert.rejects(f.engine.startTicket("ticket"), /worker profile "glm" provider setting "zcode-acp\/nope" is invalid/);
  assert.equal(f.ticket.status, "pending");
  assert.match(f.ticket.lastError, /worker profile "glm"/);
  assert.equal(f.calls.creates, 0);
});

test("the snapshot exposes the configured worker profiles", async (t) => {
  const f = fixture(t);
  await setImmediate(); // the fixture's settings are delivered asynchronously
  assert.deepEqual(f.engine.snapshot().workerProfiles, []);
  f.values.workerProfiles = WORKER_PROFILES;
  assert.deepEqual(f.engine.snapshot().workerProfiles.map((profile) => profile.name), ["glm", "flash"]);
});
