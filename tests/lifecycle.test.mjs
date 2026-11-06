import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { SuperagentEngine } from "../server/engine.ts";
import { FeishuSource } from "../server/feishu.ts";
import { emptyState, SuperagentStateSchema } from "../shared/model.ts";
import { splitImReply } from "../server/im-replies.ts";
import { SETTINGS_DEFAULTS } from "../shared/settings.ts";

const oldTime = "2020-01-01T00:00:00.000Z";

const PROVIDER_ENTRIES = [
  { provider: "codex", enabled: true, status: "ready", models: [{ id: "test", isDefault: true }], modes: [{ id: "full-access" }, { id: "read-only" }] },
  {
    provider: "zcode-acp", enabled: true, status: "ready",
    models: [{ id: "builtin:plan\\GLM-Flash", isDefault: false }, { id: "builtin:plan\\GLM", isDefault: true }],
    modes: [{ id: "ask" }, { id: "agent" }],
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
    ownsWorkspace: hasWorker ? true : null,
    startedAt: oldTime, attempts: status === "pending" ? 0 : 1, subscribed,
    report: null, lastError: null, createdAt: oldTime, updatedAt: oldTime,
  });
  const calls = {
    sends: [], watches: [], archives: [], workspaceArchives: [], creates: 0, workspaceCreateOptions: [], evals: [],
    routerCreates: [], workerCreates: [], prompts: [], watchdogCreates: [], patrols: [],
    permissionResponses: [],
  };
  const controls = {
    send: async () => {},
    createAgent: async () => ({ id: "new-worker" }),
    createRouterAgent: async () => ref("new-router"),
    timeline: async () => ({ entries: [{ seqStart: 1, item: { type: "assistant_message", text: "work completed" } }] }),
    verdict: { decision: "reply", reply: "done" },
    patrolVerdict: { summary: "all good", actions: [] },
    isGit: true,
    instructionFiles: [],
    routerSessionId: null,
    routerTimeline: async () => ({ entries: [] }),
    /** worktree 创建后工作区 descriptor 报告的实际分支;null 表示未报告(退回请求名)。 */
    workspaceBranch: null,
    pendingPermissions: new Map(),
    sessionStatuses: new Map(),
    respond: async (id, { requestId }) => {
      controls.pendingPermissions.set(id, (controls.pendingPermissions.get(id) ?? []).filter((request) => request.id !== requestId));
    },
  };
  const finishes = [];
  const handles = new Map();
  const ref = (id) => {
    if (!handles.has(id)) handles.set(id, {
      id,
      refresh: async () => ({ agent: { status: controls.sessionStatuses.get(id) ?? (id === "router" || id.includes("watchdog") ? "idle" : "running"), archivedAt: null,
        pendingPermissions: controls.pendingPermissions.get(id) ?? [],
        persistence: id.includes("router") && controls.routerSessionId ? { sessionId: controls.routerSessionId } : null } }),
      current: () => ({ persistence: controls.routerSessionId ? { sessionId: controls.routerSessionId } : null }),
      send: async (text, options) => {
        calls.sends.push({ id, text, options });
        await controls.send(text, options);
      },
      respondToPermission: async (options) => {
        calls.permissionResponses.push({ id, ...options });
        await controls.respond(id, options);
      },
      run: async (prompt) => {
        if (id.includes("watchdog")) {
          calls.patrols.push(prompt);
          return { lastMessage: JSON.stringify(controls.patrolVerdict) };
        }
        calls.prompts.push(prompt);
        return { lastMessage: JSON.stringify(controls.verdict) };
      },
      waitForFinish: () => {
        calls.watches.push(id);
        const finish = deferred();
        finishes.push(finish);
        return finish.promise;
      },
      timeline: { refetch: () => id.includes("router") ? controls.routerTimeline() : controls.timeline() },
      archive: async () => { calls.archives.push(id); },
    });
    return handles.get(id);
  };
  // 伪 daemon 的 workspace 登记:创建/找回的工作区按 id 保存 descriptor,ref(id) 拿到的
  // 句柄可 refresh/archive;engine 用它复用「默认 workspace」与档位共享工作区。
  const daemonWorkspaces = new Map();
  const workspaceHandles = new Map();
  const workspaceHandle = (id) => {
    if (!workspaceHandles.has(id)) workspaceHandles.set(id, {
      id,
      current: () => daemonWorkspaces.get(id) ?? null,
      refresh: async () => daemonWorkspaces.get(id) ?? null,
      agents: {
        create: async (options) => {
          if (options.labels?.["superagent.role"] === "router") {
            calls.routerCreates.push(options);
            return controls.createRouterAgent(options);
          }
          if (options.labels?.["superagent.role"] === "watchdog") {
            calls.watchdogCreates.push(options);
            return ref("watchdog");
          }
          calls.workerCreates.push(options);
          return controls.createAgent(options);
        },
      },
      archive: async () => {
        calls.workspaceArchives.push(id);
        daemonWorkspaces.delete(id);
      },
    });
    return workspaceHandles.get(id);
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
      create: async (options) => {
        calls.creates++;
        calls.workspaceCreateOptions.push(options);
        const id = calls.creates === 1 ? "new-workspace" : `new-workspace-${calls.creates}`;
        daemonWorkspaces.set(id, {
          id,
          name: options.title ?? null,
          workspaceDirectory: options.source?.path ?? "/mock/repo",
          archivingAt: null,
          gitRuntime: { currentBranch: controls.workspaceBranch },
        });
        return workspaceHandle(id);
      },
      list: async () => ({ entries: [...daemonWorkspaces.values()] }),
      ref: (id) => workspaceHandle(id),
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
    subscribe: (listener) => { controls.settingsChanged = listener; }, read: async () => ({ status: "ready", values }),
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
  return { engine, state, calls, controls, finishes, ref, values, paseo, ticket: state.tickets[0], daemonWorkspaces };
}

function pendingTrigger(state) {
  state.triggers.push({
    id: "trigger", threadId: "thread", threadKey: "manual:test", kind: "manual", sender: "user",
    text: "stop", status: "pending", context: false, receivedAt: oldTime,
  });
}

async function evaluateRouter(f, text = "new event") {
  f.state.triggers.push({
    id: `event-${f.state.triggers.length}`, threadId: "thread", threadKey: "manual:test", kind: "manual", sender: "user",
    text, status: "pending", context: false, receivedAt: new Date().toISOString(),
  });
  await f.engine.runEval("thread");
  return f.calls.prompts.at(-1);
}

const toolRequest = { id: "permission-shell", provider: "codex", name: "shell", kind: "tool", input: { command: "git status" } };
const questionRequest = {
  id: "permission-question", provider: "codex", name: "request_user_input", kind: "question",
  input: { questions: [{ header: "Color", question: "Which color?", options: [{ label: "Blue" }, { label: "Green" }] }] },
};

test("Worker permissions are notified once with full details and the original reply destination", async t => {
  const f = fixture(t);
  const origin = { channel: "qq", chatId: "chat", senderId: "user" };
  f.state.triggers.push({ id: "original", threadId: "thread", threadKey: "manual:test", kind: "manual", sender: "user", text: "original task", origin, status: "delivered", receivedAt: oldTime });
  f.controls.pendingPermissions.set("worker", [toolRequest, questionRequest]);
  await Promise.all([f.engine.syncWorkerPermissions("worker"), f.engine.syncWorkerPermissions("worker")]);
  const notifications = f.state.triggers.filter(trigger => trigger.workerRequest);
  assert.equal(notifications.length, 2);
  assert.deepEqual(f.ticket.pendingRequests, [toolRequest, questionRequest]);
  assert.deepEqual(notifications[0].origin, origin);
  assert.match(notifications[0].text, /git status/);
  assert.match(notifications[1].text, /Which color\?[\s\S]*Green/);
  assert.deepEqual(f.calls.evals, ["thread"]);
});

test("a permission wait releases its watcher and a formal response reattaches it", async t => {
  const f = fixture(t);
  f.engine.watchTicket("ticket");
  f.controls.pendingPermissions.set("worker", [toolRequest]);
  f.finishes[0].resolve({ status: "permission" });
  await until(() => f.ticket.pendingRequests?.length === 1);
  assert.equal(f.engine.watchedTickets.has("ticket"), false);
  assert.equal(f.ticket.status, "running");
  f.controls.verdict = { actions: [{ action: "respond", ticketId: "ticket", requestId: toolRequest.id, response: { behavior: "allow" } }] };
  await f.engine.runEval("thread");
  assert.deepEqual(f.calls.permissionResponses, [{ id: "worker", requestId: toolRequest.id, response: { behavior: "allow" } }]);
  assert.equal(f.calls.sends.length, 0);
  assert.equal(f.state.pendingActions.length, 0);
  assert.equal(f.calls.watches.length, 2);
  f.finishes[1].resolve({ status: "idle" });
  await until(() => f.state.triggers.some(trigger => trigger.kind === "report"));
  assert.equal(f.ticket.report, "work completed");
});

test("question clarification goes to IM and the human answer is filled through respond", async t => {
  const f = fixture(t);
  const origin = { channel: "qq", chatId: "chat", senderId: "user" };
  f.state.triggers.push({ id: "original", threadId: "thread", threadKey: "manual:test", kind: "manual", sender: "user", text: "original task", origin, status: "delivered", receivedAt: oldTime });
  const sent = [];
  f.engine.setReplySink({ send: async (target, text) => { sent.push({ target, text }); } });
  f.controls.pendingPermissions.set("worker", [questionRequest]);
  await f.engine.syncWorkerPermissions("worker");
  f.controls.verdict = { actions: [{ action: "reply", reply: "请选择颜色：Blue 或 Green。" }] };
  await f.engine.runEval("thread");
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].target, origin);
  assert.match(sent[0].text, /Blue/);
  const result = await f.engine.dispatch({ threadId: "thread", task: "Green", origin });
  assert.equal(result.directDelivered, false);
  assert.equal(f.calls.sends.length, 0, "no plain message clears the pending question");
  const response = { behavior: "allow", updatedInput: { answers: { Color: "Green" } } };
  f.controls.verdict = { actions: [{ action: "respond", ticketId: "ticket", requestId: questionRequest.id, response }] };
  await f.engine.runEval("thread");
  assert.deepEqual(f.calls.permissionResponses[0].response, response);
  assert.match(f.calls.prompts.at(-1), /Pending Worker permissions\/questions[\s\S]*Which color/);
  assert.equal(f.ticket.pendingRequests.length, 0);
});

test("a pending question prevents reply fan-out to other Workers even when its hook was missed", async t => {
  const f = fixture(t);
  f.state.tickets.push({ ...f.ticket, id: "other-ticket", workerAgentId: "worker-b" });
  f.controls.pendingPermissions.set("worker", [questionRequest]);
  const result = await f.engine.dispatch({ threadId: "thread", task: "Green" });
  assert.equal(result.directDelivered, false);
  assert.equal(f.calls.sends.length, 0);
  assert.equal(f.state.triggers.find(trigger => trigger.id === result.triggerId).status, "pending");
});

test("permission notifications reach followed conversations with their own reply destinations", async t => {
  const f = fixture(t);
  f.state.threads.push({ ...f.state.threads[0], id: "followed", key: "manual:followed" });
  f.ticket.follows = ["followed"];
  f.state.triggers.push({ id: "original", threadId: "followed", kind: "agent", replyToAgentId: "caller", status: "delivered", receivedAt: oldTime });
  f.controls.pendingPermissions.set("worker", [questionRequest]);
  await f.engine.syncWorkerPermissions("worker");
  const trigger = f.state.triggers.find(trigger => trigger.workerRequest && trigger.threadId === "followed");
  assert.equal(trigger.replyToAgentId, "caller");
  const result = await f.engine.dispatch({ threadId: "followed", task: "Blue" });
  assert.equal(result.directDelivered, false);
  assert.equal(f.calls.sends.length, 0);
});

test("an idle session with a pending async question is neither completed nor timed out", async t => {
  const f = fixture(t);
  f.controls.sessionStatuses.set("worker", "idle");
  f.controls.pendingPermissions.set("worker", [questionRequest]);
  await f.engine.reconcile();
  assert.equal(f.ticket.status, "running");
  assert.equal(f.ticket.report, null);
  assert.equal(f.state.triggers.filter(trigger => trigger.workerRequest).length, 1);
  f.controls.sessionStatuses.set("worker", "running");
  await f.engine.reconcile();
  assert.equal(f.ticket.attempts, 1, "waiting for a human does not exhaust runtime or retries");
  assert.equal(f.calls.sends.length, 0);
});

test("manual resolution removes stale notifications, resets the deadline, and resumes observation", async t => {
  const f = fixture(t);
  f.controls.pendingPermissions.set("worker", [toolRequest]);
  await f.engine.syncWorkerPermissions("worker");
  f.controls.pendingPermissions.set("worker", []);
  await f.engine.workerPermissionResolved("worker");
  assert.equal(f.ticket.pendingRequests.length, 0);
  assert.equal(f.state.triggers[0].status, "filtered");
  assert.ok(Date.parse(f.ticket.startedAt) > Date.parse(oldTime));
  assert.deepEqual(f.calls.watches, ["worker"]);
  f.finishes[0].resolve({ status: "idle" });
  await until(() => f.ticket.status === "waiting");
});

test("restart recovers pending requests and retries a durable question response without duplicates", async t => {
  let f = fixture(t);
  f.controls.pendingPermissions.set("worker", [questionRequest]);
  await f.engine.syncWorkerPermissions("worker");
  const response = { behavior: "allow", updatedInput: { answers: { Color: "Blue" } } };
  f.controls.respond = async () => { throw new Error("connection lost"); };
  f.controls.verdict = { actions: [{ action: "respond", ticketId: "ticket", requestId: questionRequest.id, response }] };
  await f.engine.runEval("thread");
  assert.equal(f.state.pendingActions.length, 1);
  assert.deepEqual(SuperagentStateSchema.parse(f.state).pendingActions[0].response, response);
  const saved = SuperagentStateSchema.parse(JSON.parse(JSON.stringify(f.state)));
  f = fixture(t);
  Object.assign(f.state, saved);
  f.ticket = f.state.tickets[0];
  f.controls.pendingPermissions.set("worker", [questionRequest]);
  f.controls.respond = async () => { throw new Error("connection lost"); };
  const count = f.state.triggers.length;
  await f.engine.recover();
  await f.engine.actionChain;
  assert.equal(f.state.triggers.length, count, "restored requests are not announced again");
  f.controls.respond = async (id, { requestId }) => {
    f.controls.pendingPermissions.set(id, f.controls.pendingPermissions.get(id).filter(request => request.id !== requestId));
  };
  await f.engine.runPendingAction(f.state.pendingActions[0].id);
  assert.equal(f.state.pendingActions.length, 0);
  assert.equal(f.ticket.pendingRequests.length, 0);
});

test("exhausted permission responses return an error to the Router with the original IM destination", async t => {
  const f = fixture(t);
  const origin = { channel: "qq", chatId: "chat", senderId: "user" };
  f.state.triggers.push({ id: "original", threadId: "thread", threadKey: "manual:test", kind: "manual", sender: "user", text: "original task", origin, status: "delivered", receivedAt: oldTime });
  f.controls.pendingPermissions.set("worker", [toolRequest]);
  await f.engine.syncWorkerPermissions("worker");
  f.controls.respond = async () => { throw new Error("response rejected"); };
  f.controls.verdict = { actions: [{ action: "respond", ticketId: "ticket", requestId: toolRequest.id, response: { behavior: "allow" } }] };
  await f.engine.runEval("thread");
  const actionId = f.state.pendingActions[0].id;
  await f.engine.runPendingAction(actionId);
  await f.engine.runPendingAction(actionId);
  assert.equal(f.calls.permissionResponses.length, 3);
  assert.equal(f.state.pendingActions.length, 0);
  const failure = f.state.triggers.find(trigger => trigger.sender === "engine");
  assert.match(failure.text, /response rejected/);
  assert.deepEqual(failure.origin, origin);
  assert.equal(f.ticket.pendingRequests.length, 1);
});

test("replaying an already answered response never answers a different request", async t => {
  const f = fixture(t);
  f.controls.pendingPermissions.set("worker", [questionRequest]);
  f.state.pendingActions.push({ id: "respond-old", threadId: "thread", decisionId: "old", kind: "respond", ticketId: "ticket",
    workerAgentId: "worker", requestId: "already-answered", response: { behavior: "allow" }, attempts: 0, createdAt: oldTime });
  await f.engine.runPendingAction("respond-old");
  assert.equal(f.calls.permissionResponses.length, 0);
  assert.equal(f.state.pendingActions.length, 0);
  assert.equal(f.ticket.pendingRequests[0].id, questionRequest.id);
});

test("a persisted response is bound to the original Worker session", async t => {
  const f = fixture(t);
  f.state.pendingActions.push({ id: "respond-old", threadId: "thread", decisionId: "old", kind: "respond", ticketId: "ticket",
    workerAgentId: "retired-worker", requestId: toolRequest.id, response: { behavior: "allow" }, attempts: 0, createdAt: oldTime });
  f.controls.pendingPermissions.set("worker", [toolRequest]);
  await f.engine.runPendingAction("respond-old");
  assert.equal(f.calls.permissionResponses.length, 0);
  assert.equal(f.state.pendingActions[0].attempts, 1);
});

test("steer cannot implicitly dismiss a pending request and allow needs an actual question answer", async t => {
  const f = fixture(t);
  f.controls.pendingPermissions.set("worker", [questionRequest]);
  const result = await f.engine.applySteer("ticket", "continue", "steer");
  assert.equal(result.ok, false);
  assert.match(result.error, /use respond/);
  assert.equal(f.calls.sends.length, 0);
  f.controls.verdict = { actions: [{ action: "respond", ticketId: "ticket", requestId: questionRequest.id, response: { behavior: "allow" } }] };
  await f.engine.runEval("thread");
  assert.equal(f.calls.permissionResponses.length, 0);
  assert.equal(f.ticket.pendingRequests.length, 1);
});

test("Worker session-control tool permissions stay automatic and do not notify the Router", async t => {
  const f = fixture(t);
  f.controls.pendingPermissions.set("worker", [{ ...toolRequest, name: "mcp__superagent__superagent_handback" }]);
  assert.equal(await f.engine.syncWorkerPermissions("worker"), false);
  assert.equal(f.state.triggers.length, 0);
});

test("a denied permission reaches the exact request and leaves other concurrent requests pending", async t => {
  const f = fixture(t);
  f.controls.pendingPermissions.set("worker", [toolRequest, questionRequest]);
  await f.engine.syncWorkerPermissions("worker");
  const response = { behavior: "deny", message: "Do not run this command" };
  f.controls.verdict = { actions: [{ action: "respond", ticketId: "ticket", requestId: toolRequest.id, response }] };
  await f.engine.runEval("thread");
  assert.deepEqual(f.calls.permissionResponses, [{ id: "worker", requestId: toolRequest.id, response }]);
  assert.deepEqual(f.ticket.pendingRequests, [questionRequest]);
  assert.equal(f.calls.watches.length, 0, "one answered request does not spin on another pending request");
});

test("a malformed answer or selected action is held for correction without dismissing the request", async t => {
  for (const response of [
    { behavior: "allow", updatedInput: { answers: {} } },
    { behavior: "allow", updatedInput: { answers: { Color: " " } } },
    { behavior: "allow", updatedInput: { answers: { WrongHeader: "Blue" } } },
    { behavior: "allow", selectedActionId: "unknown", updatedInput: { answers: { Color: "Blue" } } },
  ]) {
    const f = fixture(t);
    f.controls.pendingPermissions.set("worker", [questionRequest]);
    await f.engine.syncWorkerPermissions("worker");
    f.controls.verdict = { actions: [{ action: "respond", ticketId: "ticket", requestId: questionRequest.id, response }] };
    await f.engine.runEval("thread");
    assert.equal(f.calls.permissionResponses.length, 0);
    assert.equal(f.ticket.pendingRequests.length, 1);
    assert.equal(f.state.pendingActions.length, 1);
  }
});

test("canceling a blocked Worker clears its pending input and cannot answer a future Worker", async t => {
  const f = fixture(t);
  f.controls.pendingPermissions.set("worker", [toolRequest]);
  await f.engine.syncWorkerPermissions("worker");
  await f.engine.cancelTicket("ticket");
  assert.equal(f.ticket.pendingRequests.length, 0);
  assert.equal(f.state.triggers.find(trigger => trigger.workerRequest).status, "filtered");
  const result = await f.engine.dispatch({ threadId: "thread", task: "new task" });
  assert.equal(result.directDelivered, false);
  assert.equal(f.calls.permissionResponses.length, 0);
});

test("ACP Router bootstraps once, then sends only new events without duplicate user text", async (t) => {
  const f = fixture(t, "waiting");
  f.state.kv.routerAgentId = null;
  f.values.routerProvider = "zcode-acp/builtin:plan\\GLM";
  f.controls.verdict = { actions: [{ action: "ignore" }] };
  const text = "这条用户消息不能在标题里再出现一次。";
  f.state.threads[0].title = text;
  f.state.threads[0].summary = text;
  const first = await evaluateRouter(f, text);
  assert.equal(f.calls.routerCreates[0].config.systemPrompt, undefined);
  assert.match(first, /do NOT call any\ntools/);
  assert.equal(first.split(text).length - 1, 1);
  const second = await evaluateRouter(f, "second event");
  assert.match(second, /second event/);
  assert.doesNotMatch(second, /Superagent Router instructions|"actions"|## Worker environment|Recent thread history|这条用户消息/);
  assert.equal(f.calls.routerCreates.length, 1);
});

test("a new native Router receives its rules as systemPrompt rather than repeating them in user turns", async (t) => {
  const f = fixture(t, "waiting");
  f.state.kv.routerAgentId = null;
  f.values.routerInstructions = "用中文回答。";
  const prompt = await evaluateRouter(f, "first event");
  const system = f.calls.routerCreates[0].config.systemPrompt;
  assert.match(system, /do NOT call any\ntools/);
  assert.match(system, /用中文回答/);
  assert.match(system, /"action":"dispatch"/);
  assert.doesNotMatch(prompt, /Superagent Router instructions|用中文回答|"actions"/);
  assert.match(prompt, /first event/);
});

test("configuration changes are sent once and temporary directory issues do not resend static rules", async (t) => {
  const f = fixture(t, "waiting");
  await evaluateRouter(f);
  assert.doesNotMatch(await evaluateRouter(f), /Superagent Router instructions/);
  f.controls.settingsChanged({ status: "ready", values: { ...f.values, routerInstructions: "报告先写结论。" } });
  assert.match(await evaluateRouter(f), /报告先写结论/);
  assert.doesNotMatch(await evaluateRouter(f), /报告先写结论|Superagent Router instructions/);
  f.controls.isGit = false;
  const unavailable = await evaluateRouter(f);
  assert.match(unavailable, /PROBLEM:/);
  assert.doesNotMatch(unavailable, /Superagent Router instructions/);
  f.controls.isGit = true;
  const ready = await evaluateRouter(f);
  assert.match(ready, /Worker environment: ready/);
  assert.doesNotMatch(ready, /PROBLEM:|Superagent Router instructions/);
});

test("restoring the same native session across engine restart reuses the persisted initialization cursor", async (t) => {
  const f = fixture(t, "waiting");
  f.controls.routerSessionId = "session-stable";
  await evaluateRouter(f);
  Object.assign(f.state, SuperagentStateSchema.parse(JSON.parse(JSON.stringify(f.state))));
  const restored = new SuperagentEngine(f.engine.store, {
    subscribe: () => {}, read: async () => ({ status: "ready", values: f.values }),
  });
  restored.paseo = f.engine.paseo;
  restored.workingDirProbe = f.engine.workingDirProbe;
  t.after(() => restored.stop());
  await setImmediate();
  const prompt = await evaluateRouter({ ...f, engine: restored }, "after restart");
  assert.match(prompt, /after restart/);
  assert.doesNotMatch(prompt, /Superagent Router instructions|Recent thread history/);
});

test("native session replacement and observed compaction restore rules and history once", async (t) => {
  const f = fixture(t, "waiting");
  f.controls.routerSessionId = "session-one";
  await evaluateRouter(f, "original event");
  f.controls.routerSessionId = "session-two";
  const replaced = await evaluateRouter(f, "session replaced");
  assert.match(replaced, /Superagent Router instructions/);
  assert.match(replaced, /original event/);
  assert.doesNotMatch(await evaluateRouter(f), /Superagent Router instructions/);
  f.controls.routerTimeline = async () => ({ entries: [{ seqStart: 20, item: { type: "compaction", status: "completed" } }] });
  assert.match(await evaluateRouter(f), /Superagent Router instructions/);
  assert.doesNotMatch(await evaluateRouter(f), /Superagent Router instructions/);
});

test("unseen direct-to-Worker context reaches Router exactly once without replaying old thread history", async (t) => {
  const f = fixture(t, "waiting");
  await evaluateRouter(f);
  f.state.triggers.push({ ...f.state.triggers[0], id: "direct-followup", status: "delivered", text: "追加要求：输出中文报告。" });
  const next = await evaluateRouter(f, "worker finished");
  assert.match(next, /already delivered directly to Workers \(do not dispatch again/);
  assert.equal(next.split("追加要求：输出中文报告。").length - 1, 1);
  assert.doesNotMatch(await evaluateRouter(f), /追加要求|Recent thread history/);
});

test("a new thread gets recovery context without resending the Router protocol", async (t) => {
  const f = fixture(t, "waiting");
  await evaluateRouter(f);
  f.state.threads.push({ ...f.state.threads[0], id: "thread-other", key: "manual:other", summary: "Other thread summary" });
  f.state.triggers.push({ ...f.state.triggers[0], id: "other-event", threadId: "thread-other", status: "pending", text: "Other thread request" });
  await f.engine.runEval("thread-other");
  const prompt = f.calls.prompts.at(-1);
  assert.match(prompt, /# Thread: thread-other/);
  assert.match(prompt, /Other thread summary/);
  assert.doesNotMatch(prompt, /Superagent Router instructions/);
});

test("invalid Router output does not mark a bootstrap as successfully applied", async (t) => {
  const f = fixture(t, "waiting");
  f.controls.verdict = { invalid: "result" };
  await evaluateRouter(f);
  assert.equal(f.state.kv.routerPromptState, undefined);
  f.controls.verdict = { actions: [{ action: "ignore" }] };
  assert.match(await evaluateRouter(f), /Superagent Router instructions/);
});

test("invalid continuation output triggers one context repair for an already initialized Router", async (t) => {
  const f = fixture(t, "waiting");
  await evaluateRouter(f);
  f.controls.verdict = { invalid: true };
  assert.doesNotMatch(await evaluateRouter(f), /Superagent Router instructions/);
  f.controls.verdict = { actions: [{ action: "ignore" }] };
  assert.match(await evaluateRouter(f), /Superagent Router instructions/);
  assert.doesNotMatch(await evaluateRouter(f), /Superagent Router instructions/);
});

test("direct context is bounded and older omitted messages do not leak into later evaluations", async (t) => {
  const f = fixture(t, "waiting");
  await evaluateRouter(f);
  for (let i = 0; i < 12; i++) f.state.triggers.push({ ...f.state.triggers[0], id: `direct-${i}`, status: "delivered",
    text: `context-${i}: ${"x".repeat(2000)}`, receivedAt: `2026-01-01T00:00:${String(i).padStart(2, "0")}Z` });
  const prompt = await evaluateRouter(f);
  assert.equal(prompt.match(/id: direct-/g).length, 8);
  assert.doesNotMatch(prompt, /context-0:/);
  assert.match(prompt, /context-11:/);
  assert.doesNotMatch(await evaluateRouter(f), /context-\d+:/);
});

test("uncertain compaction state causes a conservative bootstrap rather than silently dropping rules", async (t) => {
  const f = fixture(t, "waiting");
  await evaluateRouter(f);
  f.controls.routerTimeline = async () => { throw new Error("timeline unavailable"); };
  assert.match(await evaluateRouter(f), /Superagent Router instructions/);
  f.controls.routerTimeline = async () => ({ entries: [] });
  assert.doesNotMatch(await evaluateRouter(f), /Superagent Router instructions/);
});

test("IM sends the complete long reply sequentially and persists each acknowledged part", async (t) => {
  const f = fixture(t, "waiting");
  f.values.imReplyMaxChars = 100;
  pendingTrigger(f.state);
  const origin = { channel: "dingtalk", chatId: "chat", senderId: "user", replyRef: "private-webhook" };
  f.state.triggers[0].origin = origin;
  const text = "完整结果👩🏽‍💻\n\n".repeat(250);
  f.controls.verdict = { actions: [{ action: "reply", reply: text }, { action: "stop" }] };
  const sent = [];
  f.engine.setReplySink({ send: async (target, part) => {
    const delivery = f.state.imDeliveries[0];
    assert.deepEqual(target, origin);
    assert.equal(delivery.nextPart, sent.length, "progress advances only after the send resolves");
    assert.equal(delivery.parts[sent.length], part, "all parts are already durable before sending");
    sent.push(part);
  } });
  await f.engine.runEval("thread");
  assert.deepEqual(sent, splitImReply(text, 100));
  assert.equal(f.state.imDeliveries[0].status, "sent");
  assert.equal(f.state.imDeliveries[0].nextPart, sent.length);
  assert.equal(f.state.decisions[0].reply, text);
  assert.equal(f.state.threads[0].state, "closed");
  const snapshot = f.engine.snapshot();
  assert.equal(snapshot.imDeliveries[0].totalParts, sent.length);
  assert.equal(snapshot.imDeliveries[0].status, "sent");
  assert.doesNotMatch(JSON.stringify(snapshot.imDeliveries), /private-webhook|origin|parts"/);
});

test("a failed IM part pauses delivery and manual retry resumes without repeating acknowledged parts", async (t) => {
  const f = fixture(t, "waiting");
  f.values.imReplyMaxChars = 100;
  pendingTrigger(f.state);
  f.state.triggers[0].origin = { channel: "qq", chatId: "g:1", senderId: "user" };
  const text = "long reply ".repeat(60);
  f.controls.verdict = { actions: [{ action: "reply", reply: text }] };
  const expected = splitImReply(text, 100);
  const sent = [];
  let fail = true;
  f.engine.setReplySink({ send: async (_target, part) => {
    if (sent.length === 1 && fail) throw new Error("channel refused");
    sent.push(part);
  } });
  await f.engine.runEval("thread");
  const delivery = f.state.imDeliveries[0];
  assert.deepEqual(sent, [expected[0]]);
  assert.equal(delivery.status, "failed");
  assert.equal(delivery.nextPart, 1);
  await f.engine.reconcile();
  assert.deepEqual(sent, [expected[0]], "failed deliveries require explicit retry");
  fail = false;
  await f.engine.retryImDelivery(delivery.id);
  assert.deepEqual(sent, expected);
  assert.equal(delivery.status, "sent");
  await assert.rejects(f.engine.retryImDelivery(delivery.id), /只有发送失败/);
});

test("a restored pending IM delivery resumes at its durable offset and concurrent drains do not duplicate it", async (t) => {
  const f = fixture(t, "waiting");
  const delivery = { id: "saved-delivery", threadId: "thread", origin: { channel: "qq", chatId: "g:1", senderId: "user" },
    parts: ["[1/3] one", "[2/3] two", "[3/3] three"], nextPart: 1, status: "pending", createdAt: oldTime, updatedAt: oldTime };
  const restored = SuperagentStateSchema.parse({ ...f.state, imDeliveries: [delivery] });
  f.state.imDeliveries = restored.imDeliveries;
  const entered = deferred();
  const finish = deferred();
  const sent = [];
  f.engine.setReplySink({ send: async (_target, part) => {
    sent.push(part);
    if (sent.length === 1) { entered.resolve(); await finish.promise; }
  } });
  await f.engine.reconcile();
  await entered.promise;
  const duplicate = f.engine.sendImDelivery(delivery.id);
  finish.resolve();
  await duplicate;
  assert.deepEqual(sent, delivery.parts.slice(1));
  assert.equal(f.state.imDeliveries[0].status, "sent");
});

test("an unavailable IM sink retains the answer for later retry", async (t) => {
  const f = fixture(t, "waiting");
  pendingTrigger(f.state);
  f.state.triggers[0].origin = { channel: "qq", chatId: "g:1", senderId: "user" };
  await f.engine.runEval("thread");
  assert.equal(f.state.imDeliveries[0].status, "failed");
  assert.equal(f.state.imDeliveries[0].nextPart, 0);
});

test("IM recovery sends nothing while the durable outbox cannot be written", async (t) => {
  const f = fixture(t, "waiting");
  f.state.imDeliveries.push({ id: "unsaved", threadId: "thread", origin: { channel: "qq", chatId: "g:1", senderId: "user" },
    parts: ["answer"], nextPart: 0, status: "pending", createdAt: oldTime, updatedAt: oldTime });
  let sends = 0;
  f.engine.setReplySink({ send: async () => { sends++; } });
  f.engine.store.update = async () => { throw new Error("disk unavailable"); };
  await f.engine.sendImDelivery("unsaved");
  assert.equal(sends, 0);
  assert.equal(f.state.imDeliveries[0].nextPart, 0);
});

test("Router rules update on the next eval using the same agent and can be cleared", async (t) => {
  const f = fixture(t, "waiting");
  await setImmediate();
  for (const rules of ["中文汇报,列出验证情况。", "简洁答复,优先说明阻塞项。", ""]) {
    f.controls.settingsChanged({ status: "ready", values: { ...f.values, routerInstructions: rules } });
    pendingTrigger(f.state);
    await f.engine.runEval("thread");
    const prompt = f.calls.prompts.at(-1);
    if (rules) assert.ok(prompt.includes(rules));
    else assert.match(prompt, /No custom Router preferences are configured\. Use the built-in rules only/);
    f.state.triggers = [];
  }
  assert.equal(f.calls.prompts.length, 3);
  assert.equal(f.calls.routerCreates.length, 0, "the existing Router is reused");
  assert.equal(f.calls.workerCreates.length, 0);
});

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

test("chat tabs start from UI conversations, then restore exactly what the screen saved", async (t) => {
  const f = fixture(t);
  f.state.triggers.push({
    id: "first", threadId: "thread", threadKey: "manual:test", kind: "manual", sender: "user",
    text: "hi", status: "evaluated", context: false, receivedAt: oldTime,
  });
  assert.deepEqual(f.engine.snapshot().chatTabs, { open: [], last: null }, "conversations idle for over a day are not reopened");
  f.state.threads[0].updatedAt = new Date().toISOString();
  assert.deepEqual(f.engine.snapshot().chatTabs, { open: ["thread"], last: "thread" });
  await f.engine.saveChatTabs({ open: ["thread", "gone"], last: "gone" });
  assert.deepEqual(f.state.kv.chatTabs, { open: ["thread"], last: null }, "unknown threads are not persisted");
  await f.engine.saveChatTabs({ open: [], last: null });
  assert.deepEqual(f.engine.snapshot().chatTabs, { open: [], last: null }, "closing every tab is not undone by the defaults");
  assert.deepEqual(SuperagentStateSchema.parse(JSON.parse(JSON.stringify(f.state))).kv.chatTabs, { open: [], last: null });
});

test("the snapshot identifies the evaluating thread and clears it when evaluation settles", async (t) => {
  const f = fixture(t);
  const finish = deferred();
  f.engine.runEval = () => finish.promise;
  f.engine.evalQueued.add("thread");
  const evaluation = f.engine.drainEvalQueue();
  assert.equal(f.engine.snapshot().engine.evalInFlight, true);
  assert.equal(f.engine.snapshot().engine.currentEvalThreadId, "thread");
  finish.resolve();
  await evaluation;
  assert.equal(f.engine.snapshot().engine.evalInFlight, false);
  assert.equal(f.engine.snapshot().engine.currentEvalThreadId, null);
});

test("reply then stop retains both the Router conclusion and full Worker report before archiving", async (t) => {
  const f = fixture(t);
  const report = `${"Verified output. ".repeat(400)}End of original report`;
  f.controls.timeline = async () => ({ entries: [{ seqStart: 1, item: { type: "assistant_message", text: report } }] });
  await f.engine.settleTicketRun("ticket", null);
  assert.equal(f.ticket.report, report);
  assert.equal(f.state.threads[0].latestResult.text, report);
  assert.ok(f.state.triggers.find((trigger) => trigger.kind === "report").text.length < report.length);
  f.controls.verdict = { actions: [{ action: "reply", reply: "The work is complete; outputs and checks are ready." }, { action: "stop", rationale: "done" }] };
  const archive = f.ref("worker").archive;
  f.ref("worker").archive = async () => {
    assert.equal(f.state.threads[0].latestResult.kind, "router_reply");
    assert.equal(f.ticket.report, report);
    await archive();
  };
  await f.engine.runEval("thread");
  assert.deepEqual(f.calls.archives, ["worker"]);
  assert.equal(f.engine.snapshot().threads.length, 0);
  const result = f.engine.snapshot().recentResults[0];
  assert.equal(result.kind, "router_reply");
  assert.equal(result.text, "The work is complete; outputs and checks are ready.");
  assert.deepEqual(result.ticketIds, ["ticket"]);
  f.state.decisions = [];
  f.state.triggers = [];
  f.ref("worker").refresh = async () => null;
  assert.equal(f.engine.snapshot().recentResults[0].text, result.text);
  assert.equal(f.engine.snapshot({ includeClosed: true, threadId: "thread" }).tickets[0].report, report);
});

test("a stop without a Router reply still exposes the saved Worker report", async (t) => {
  const f = fixture(t);
  await f.engine.settleTicketRun("ticket", null);
  f.controls.verdict = { actions: [{ action: "stop", rationale: "done" }] };
  await f.engine.runEval("thread");
  assert.equal(f.engine.snapshot().recentResults[0].kind, "worker_report");
  assert.equal(f.engine.snapshot().recentResults[0].text, "work completed");
});

test("history includes closed threads without adding them to the live snapshot", (t) => {
  const f = fixture(t);
  f.state.threads.push({ ...f.state.threads[0], id: "closed", key: "manual:closed", state: "closed" });
  f.state.tickets.push({ ...f.ticket, id: "old-ticket", threadId: "closed", status: "completed" });
  assert.deepEqual(f.engine.snapshot().threads.map((thread) => thread.id), ["thread"]);
  const history = f.engine.snapshot({ includeClosed: true });
  assert.equal(history.threads.length, 2);
  assert.equal(history.tickets.find((ticket) => ticket.id === "old-ticket").status, "completed");
  assert.equal(f.state.threads[1].state, "closed");
});

test("thread history keeps its message window even when other threads have newer activity", (t) => {
  const f = fixture(t);
  pendingTrigger(f.state);
  f.state.decisions.push({ id: "decision", threadId: "thread", triggerIds: ["trigger"], outcome: "reply", createdAt: oldTime });
  f.state.threads.push({ ...f.state.threads[0], id: "busy", key: "manual:busy" });
  for (let index = 0; index < 125; index++) {
    f.state.triggers.push({ ...f.state.triggers[0], id: `other-${index}`, threadId: "busy", receivedAt: "2026-01-01T00:00:00Z" });
    f.state.decisions.push({ ...f.state.decisions[0], id: `other-${index}`, threadId: "busy", createdAt: "2026-01-01T00:00:00Z" });
  }
  assert.ok(!f.engine.snapshot().triggers.some((trigger) => trigger.id === "trigger"));
  const focused = f.engine.snapshot({ includeClosed: true, threadId: "thread" });
  assert.deepEqual(focused.threads.map((thread) => thread.id), ["thread"]);
  assert.deepEqual(focused.triggers.map((trigger) => trigger.id), ["trigger"]);
  assert.deepEqual(focused.decisions.map((decision) => decision.id), ["decision"]);
  assert.equal(f.engine.snapshot({ includeClosed: true, threadId: "missing" }).tickets.length, 0);
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

test("closing a thread also retires the leftover worker of a finished ticket", async (t) => {
  const f = fixture(t, "completed");
  await f.engine.closeThread("thread");
  assert.equal(f.ticket.status, "completed", "terminal statuses are not rewritten by closing");
  assert.equal(f.state.threads[0].state, "closed");
  assert.deepEqual(f.calls.archives, ["worker"]);
  assert.deepEqual(f.calls.workspaceArchives, ["workspace"]);
});

test("canceling a finished ticket keeps its status and retires the leftover worker", async (t) => {
  const f = fixture(t, "completed");
  await f.engine.cancelTicket("ticket");
  assert.equal(f.ticket.status, "completed");
  assert.deepEqual(f.calls.archives, ["worker"]);
  assert.deepEqual(f.calls.workspaceArchives, ["workspace"]);
});

test("canceling a failed ticket keeps its status and retires the leftover worker", async (t) => {
  const f = fixture(t, "failed");
  await f.engine.cancelTicket("ticket");
  assert.equal(f.ticket.status, "failed");
  assert.deepEqual(f.calls.archives, ["worker"]);
  assert.deepEqual(f.calls.workspaceArchives, ["workspace"]);
});

test("retry retires the previous worker and workspace before relaunching", async (t) => {
  const f = fixture(t, "failed");
  await f.engine.retryTicket("ticket");
  await until(() => f.ticket.status === "running");
  assert.equal(f.ticket.workerAgentId, "new-worker");
  assert.equal(f.calls.creates, 1, "the relaunched worker gets a fresh workspace");
  assert.deepEqual(f.calls.archives, ["worker"], "the previous worker is archived, not orphaned");
  assert.deepEqual(f.calls.workspaceArchives, ["workspace"]);
});

test("Router stop retires every worker on the thread, including unsubscribed, launching, and finished tickets", async (t) => {
  const f = fixture(t, "running", false);
  f.state.tickets.push({ ...f.ticket, id: "launching", status: "launching", workerAgentId: "starting-worker", workspaceId: "starting-workspace" });
  f.state.tickets.push({ ...f.ticket, id: "completed", status: "completed", workerAgentId: "finished-worker" });
  pendingTrigger(f.state);
  f.controls.verdict = { decision: "stop" };
  await f.engine.runEval("thread");
  assert.deepEqual(f.calls.archives.sort(), ["finished-worker", "starting-worker", "worker"]);
  assert.deepEqual(f.calls.workspaceArchives.sort(), ["starting-workspace", "workspace", "workspace"]);
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
  // 成功裁决保留截断的原始回复,事后可从决策审计 Router 实际输出。
  assert.ok(f.state.decisions[0].raw.includes("do the first thing"));
});

test("a placeholder dispatch mandate is recorded unparsed and the trigger stays pending", async (t) => {
  const f = fixture(t, "completed");
  pendingTrigger(f.state);
  f.controls.verdict = { actions: [{ action: "dispatch", title: "...", mandate: "..." }] };
  await f.engine.runEval("thread");
  const decision = f.state.decisions.at(-1);
  assert.equal(decision.outcome, "unparsed");
  assert.match(decision.rationale, /placeholder/);
  assert.ok(decision.raw.includes("mandate"));
  // 整批触发保留 pending 供 watchdog 重试;不产生空工单。
  assert.equal(f.state.triggers[0].status, "pending");
  assert.equal(f.state.tickets.filter((ticket) => ticket.title === "...").length, 0);
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

test("follow-ups on a thread with several subscribed tickets fan out to every worker", async (t) => {
  const f = fixture(t);
  f.state.tickets.push({
    ...f.ticket, id: "ticket2", workerAgentId: "worker2", workspaceId: "workspace2",
  });
  const result = await f.engine.dispatch({ threadId: "thread", task: "group follow-up" });
  assert.equal(result.directDelivered, true);
  assert.deepEqual(f.calls.sends.map((send) => send.id), ["worker", "worker2"]);
  assert.ok(f.calls.sends.every((send) => send.text.includes("group follow-up")));
  assert.equal(f.state.triggers[0].status, "delivered");
  assert.match(f.state.triggers[0].note, /direct → workers of ticket, ticket2/);
  assert.deepEqual(f.calls.evals, [], "no Router LLM call for the fan-out delivery");
});

test("a fan-out where one worker fails still delivers and records only the successes", async (t) => {
  const f = fixture(t);
  f.state.tickets.push({
    ...f.ticket, id: "ticket2", workerAgentId: "worker2", workspaceId: "workspace2",
  });
  // 失败注入:仅第二个 Worker 的会话发送报错。
  f.ref("worker2").send = async () => { throw new Error("worker2 offline"); };
  const result = await f.engine.dispatch({ threadId: "thread", task: "partial fan-out" });
  assert.equal(result.directDelivered, true);
  assert.equal(f.state.triggers[0].status, "delivered");
  assert.match(f.state.triggers[0].note, /direct → workers of ticket$/);
  assert.deepEqual(f.calls.evals, []);
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
  f.controls.createRouterAgent = async () => { throw new Error("Internal error"); };
  await assert.rejects(
    f.engine.runEval("thread"),
    /router agent creation failed \(provider "zcode-acp\/builtin:plan\\GLM"\): Internal error/,
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

test("default worker mode is applied before its initial prompt, while blank leaves Paseo in control", async (t) => {
  for (const modeId of ["", "full-access"]) {
    const f = fixture(t, "pending");
    f.values.workerModeId = modeId;
    await f.engine.startTicket("ticket");
    const options = f.calls.workerCreates[0];
    assert.ok(options.prompt, "mode and initial task are sent in the same create request");
    if (modeId) assert.equal(options.config.modeId, modeId);
    else assert.equal(Object.hasOwn(options.config, "modeId"), false);
  }
});

test("named profiles use only their own mode and retry picks up mode changes", async (t) => {
  const f = fixture(t, "pending");
  f.ticket.profile = "glm";
  f.values.workerModeId = "full-access";
  f.values.workerProfiles = [{ ...WORKER_PROFILES[0], modeId: "ask" }];
  await f.engine.startTicket("ticket");
  assert.equal(f.calls.workerCreates[0].config.modeId, "ask");
  f.values.workerProfiles = [{ ...WORKER_PROFILES[0], modeId: "agent" }];
  f.ticket.status = "failed";
  await f.engine.retryTicket("ticket");
  assert.equal(f.calls.workerCreates[1].config.modeId, "agent");
  f.values.workerProfiles = [{ ...WORKER_PROFILES[0], modeId: "" }];
  f.ticket.status = "failed";
  await f.engine.retryTicket("ticket");
  assert.equal(Object.hasOwn(f.calls.workerCreates[2].config, "modeId"), false, "blank profile mode does not inherit the default worker mode");
  f.values.workerProfiles = [];
  f.ticket.status = "failed";
  await f.engine.retryTicket("ticket");
  assert.equal(f.calls.workerCreates[3].config.provider, "codex/test");
  assert.equal(f.calls.workerCreates[3].config.modeId, "full-access");
});

test("unsupported worker modes remain pending with a useful error and create no workspace", async (t) => {
  const f = fixture(t, "pending");
  f.values.workerProfiles = [{ ...WORKER_PROFILES[0], modeId: "full-access" }];
  f.ticket.profile = "glm";
  await assert.rejects(f.engine.startTicket("ticket"), /worker profile "glm" mode setting is invalid: mode "full-access" is not offered by provider "zcode-acp"/);
  assert.equal(f.ticket.status, "pending");
  assert.match(f.ticket.lastError, /available: ask, agent/);
  assert.equal(f.calls.creates, 0);
  assert.equal(f.calls.workerCreates.length, 0);
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

test("the Router is created inside the shared 默认 workspace, which is remembered and reused", async (t) => {
  const f = fixture(t);
  f.state.kv.routerAgentId = null;
  f.controls.verdict = { actions: [{ action: "ignore" }] };
  await evaluateRouter(f);
  assert.equal(f.calls.creates, 1, "exactly one shared workspace is created for the Router");
  assert.equal(f.daemonWorkspaces.get("new-workspace").name, "默认 workspace");
  assert.equal(f.daemonWorkspaces.get("new-workspace").workspaceDirectory, "/mock/repo");
  assert.equal(f.calls.routerCreates.length, 1);
  assert.equal(f.calls.routerCreates[0].cwd, undefined, "the workspace, not the engine, supplies the cwd");
  assert.equal(f.state.kv.sharedWorkspaces["/mock/repo"], "new-workspace");

  // 引擎重启(缓存清空)后 Router 丢失:登记过的 workspace 直接复用,不再新建。
  f.state.kv.routerAgentId = null;
  const restarted = new SuperagentEngine(f.engine.store, {
    subscribe: () => {}, read: async () => ({ status: "ready", values: f.values }),
  });
  restarted.paseo = f.engine.paseo;
  restarted.workingDirProbe = f.engine.workingDirProbe;
  restarted.primed = true;
  t.after(() => restarted.stop());
  await setImmediate();
  pendingTrigger(f.state);
  await restarted.runEval("thread");
  assert.equal(f.calls.creates, 1, "the remembered 默认 workspace is reused after a restart");
  assert.equal(f.calls.routerCreates.length, 2);
});

test("shared workers join the 默认 workspace and retiring them never archives it", async (t) => {
  const f = fixture(t, "pending");
  f.values.workerIsolation = "shared";
  await f.engine.startTicket("ticket");
  assert.equal(f.ticket.workspaceId, "new-workspace");
  assert.equal(f.ticket.ownsWorkspace, false);
  assert.equal(f.daemonWorkspaces.get("new-workspace").name, "默认 workspace");
  await f.engine.cancelTicket("ticket");
  assert.deepEqual(f.calls.archives, ["new-worker"]);
  assert.deepEqual(f.calls.workspaceArchives, [], "the shared workspace is not ticket-owned and survives");
  assert.ok(f.daemonWorkspaces.has("new-workspace"));
});

test("a worktree profile with its own working directory branches from that directory", async (t) => {
  const f = fixture(t, "pending");
  f.values.workerProfiles = [{ ...WORKER_PROFILES[0], workingDir: "/other/repo" }];
  Object.assign(f.ticket, { profile: "glm" });
  await f.engine.startTicket("ticket");
  assert.equal(f.ticket.ownsWorkspace, true);
  assert.deepEqual(
    f.calls.workspaceCreateOptions[0].source,
    { kind: "worktree", cwd: "/other/repo", action: "branch-off", branchName: "superagent/test-ticket" },
    "the worktree branches off the profile's own directory",
  );
  const prompt = f.calls.workerCreates[0].prompt;
  assert.match(prompt, /ISOLATED worktree workspace: a fresh copy of the repository at \/other\/repo/);
});

test("a shared profile directory gets one persistent workspace named after the profile", async (t) => {
  const f = fixture(t, "completed");
  f.values.workerIsolation = "shared";
  f.values.workerProfiles = [{ ...WORKER_PROFILES[0], workingDir: "/other/repo" }];
  pendingTrigger(f.state);
  f.controls.verdict = {
    actions: [
      { action: "dispatch", title: "One", mandate: "first", profile: "glm" },
      { action: "dispatch", title: "Two", mandate: "second", profile: "glm" },
    ],
  };
  await f.engine.runEval("thread");
  await until(() => f.state.tickets.filter((ticket) => ticket.status === "running").length === 2);
  assert.equal(f.calls.creates, 1, "both tickets share one persistent workspace for the profile directory");
  assert.equal(f.daemonWorkspaces.get("new-workspace").name, "glm");
  assert.equal(f.daemonWorkspaces.get("new-workspace").workspaceDirectory, "/other/repo");
  const launched = f.state.tickets.filter((ticket) => ticket.title !== "test");
  assert.deepEqual(launched.map((ticket) => ticket.workspaceId), ["new-workspace", "new-workspace"]);
  assert.deepEqual(launched.map((ticket) => ticket.ownsWorkspace), [false, false]);
});

// ---------------------------------------------------- 跨线程指挥 / 回读 / Worker 工具

test("the eval prompt lists other active threads as steer targets", async (t) => {
  const f = fixture(t, "waiting");
  f.state.threads.push({ ...f.state.threads[0], id: "thread-b", key: "manual:b", title: "plan B" });
  f.state.tickets.push({
    ...f.state.tickets[0], id: "tkt-b", threadId: "thread-b", title: "Other work",
    status: "running", workerAgentId: "worker-b",
  });
  const prompt = await evaluateRouter(f, "plan A 在 IM 里,但 B 线程的工单要先改");
  assert.match(prompt, /## Other active threads/);
  assert.match(prompt, /- thread thread-b "plan B"/);
  assert.match(prompt, /  - \[tkt-b\] "Other work" status=running subscribed=true/);
});

test("a Router steer action can command a ticket on another thread", async (t) => {
  const f = fixture(t, "waiting");
  f.state.threads.push({ ...f.state.threads[0], id: "thread-b", key: "manual:b", title: "plan B" });
  f.state.tickets.push({
    ...f.state.tickets[0], id: "tkt-b", threadId: "thread-b", title: "Other work",
    status: "running", workerAgentId: "worker-b", workspaceId: "workspace-b",
  });
  pendingTrigger(f.state);
  f.controls.verdict = { actions: [{ action: "steer", ticketId: "tkt-b", text: "switch to plan B", mode: "interrupt" }] };
  await f.engine.runEval("thread");
  assert.equal(f.calls.sends.length, 1);
  assert.equal(f.calls.sends[0].id, "worker-b");
  assert.ok(f.calls.sends[0].text.includes("switch to plan B"));
  assert.equal(f.calls.sends[0].options.activeTurnBehavior, "interrupt");
  assert.equal(f.state.tickets.find((ticket) => ticket.id === "tkt-b").status, "running");
  // 裁决记录挂在本线程,票据指向跨线程目标。
  assert.equal(f.state.decisions[0].threadId, "thread");
  assert.equal(f.state.decisions[0].ticketId, "tkt-b");
  assert.equal(f.state.triggers[0].status, "evaluated");
});

test("a persisted cross-thread steer survives a restart and still reaches the other ticket", async (t) => {
  const f = fixture(t, "waiting");
  f.state.threads.push({ ...f.state.threads[0], id: "thread-b", key: "manual:b", title: "plan B" });
  f.state.tickets.push({
    ...f.state.tickets[0], id: "tkt-b", threadId: "thread-b", title: "Other work",
    status: "running", workerAgentId: "worker-b", startedAt: new Date().toISOString(),
  });
  f.state.pendingActions.push({
    id: "act_cross", threadId: "thread", decisionId: "dec_cross", kind: "steer",
    ticketId: "tkt-b", text: "focus on tests", mode: "steer", attempts: 0, createdAt: oldTime,
  });
  await f.engine.recover();
  await until(() => f.state.pendingActions.length === 0);
  assert.equal(f.calls.sends[0].id, "worker-b");
  assert.ok(f.calls.sends[0].text.includes("focus on tests"));
});

test("router and worker configs stay clean — orchestration tools arrive via session_open only", async (t) => {
  // daemon 侧两条硬校验决定了角色工具只能走 session_open 注入:保存配置里同名
  // mcpServer 与插件注入冲突会拒绝建会话;toolPolicy 预授权引用的 server 必须出现在
  // 同一个 agent 请求里(插件注入在合并之前,不满足)。这里回归护栏:创建配置两样都不带。
  const f = fixture(t, "pending");
  await f.engine.startTicket("ticket");
  const workerConfig = f.calls.workerCreates[0].config;
  assert.equal(workerConfig.mcpServers, undefined, "no MCP server is saved into the agent config");
  assert.equal(workerConfig.toolPolicy, undefined, "no MCP preapproval is saved either");

  const routerFixture = fixture(t, "waiting");
  routerFixture.state.kv.routerAgentId = null;
  await evaluateRouter(routerFixture, "first event");
  const routerConfig = routerFixture.calls.routerCreates[0].config;
  assert.equal(routerConfig.mcpServers, undefined);
  assert.equal(routerConfig.toolPolicy, undefined);
});

test("worker unsubscribe stops direct delivery and completes a waiting ticket", async (t) => {
  const f = fixture(t, "waiting");
  const outcome = await f.engine.workerUnsubscribe("ticket");
  assert.equal(outcome.ok, true);
  assert.match(outcome.note, /unsubscribed; the ticket is completed/);
  assert.equal(f.ticket.subscribed, false);
  assert.equal(f.ticket.status, "completed");
  const repeated = await f.engine.workerUnsubscribe("ticket");
  assert.equal(repeated.ok, false);
  assert.match(repeated.error, /only running\/waiting workers can unsubscribe/);
  const missing = await f.engine.workerUnsubscribe("tkt_missing");
  assert.equal(missing.ok, false);
  assert.match(missing.error, /does not exist/);
});

test("worker handback re-queues a misdelivered message with reply routing intact", async (t) => {
  const f = fixture(t, "waiting");
  f.state.triggers.push({
    id: "im-1", threadId: "thread", threadKey: "manual:test", kind: "feishu", sender: "alice",
    text: "原消息", status: "evaluated", context: false, receivedAt: "2021-01-01T00:00:00.000Z",
    origin: { channel: "feishu", chatId: "oc_1", senderId: "u_1" }, note: null, replyToAgentId: null,
  });
  const outcome = await f.engine.workerHandback("ticket", "这条消息与我的工单无关:帮忙订机票", { unsubscribe: true });
  assert.equal(outcome.ok, true);
  const handback = f.state.triggers.find((trigger) => trigger.kind === "engine");
  assert.equal(handback.status, "pending");
  assert.equal(handback.sender, "worker:ticket");
  assert.match(handback.text, /^\[handback\] /);
  assert.equal(handback.origin?.chatId, "oc_1");
  assert.equal(f.ticket.subscribed, false);
  assert.equal(f.ticket.status, "completed");
  assert.deepEqual(f.calls.evals, ["thread"]);
  // 空文本与关闭线程的转回被拒绝。
  assert.equal((await f.engine.workerHandback("ticket", "  ")).ok, false);
  await f.engine.closeThread("thread");
  const closed = await f.engine.workerHandback("ticket", "again");
  assert.equal(closed.ok, false);
  assert.match(closed.error, /thread of this ticket is closed/);
});

test("readRecord recalls full untruncated records by id prefix", async (t) => {
  const f = fixture(t, "running");
  const now = new Date().toISOString();
  f.state.triggers.push({
    id: "trg_full", threadId: "thread", threadKey: "manual:test", kind: "manual", sender: "user",
    text: "x".repeat(5000), status: "pending", context: false, receivedAt: now, note: null,
  });
  f.state.tickets.push({
    ...f.state.tickets[0], id: "tkt_full", threadId: "thr_full", mandate: "完整任务书", report: "R".repeat(25_000),
  });
  f.state.decisions.push({
    id: "dec_full", threadId: "thread", triggerIds: ["trg_full"], outcome: "reply",
    reply: "答复全文", rationale: null, ticketId: null, raw: null, createdAt: now,
  });
  f.state.threads.push({ ...f.state.threads[0], id: "thr_full", title: "带前缀的线程" });
  const trigger = await f.engine.readRecord("trg_full");
  assert.ok(trigger.includes("x".repeat(5000)), "trigger text comes back untruncated");
  const ticket = await f.engine.readRecord("tkt_full");
  assert.match(ticket, /## mandate\n完整任务书/);
  assert.ok(ticket.includes("R".repeat(19_999)), "reports come back at the recall cap");
  assert.ok(!ticket.includes("R".repeat(20_000)), "oversized reports are still bounded");
  const thread = await f.engine.readRecord("thr_full");
  assert.match(thread, /# thread thr_full/);
  assert.match(thread, /title: 带前缀的线程/);
  assert.match(thread, /- \[tkt_full\] "test" status=running/);
  assert.equal(await f.engine.readRecord("thread"), null, "ids without a known prefix are not recalled");
  const decision = await f.engine.readRecord("dec_full");
  assert.match(decision, /outcome: reply/);
  assert.match(decision, /reply: 答复全文/);
  assert.equal(await f.engine.readRecord("trg_nope"), null);
});

test("listThreads shows every active thread with its unfinished tickets", async (t) => {
  const f = fixture(t, "running");
  f.state.threads.push({ ...f.state.threads[0], id: "thread-b", key: "manual:b", title: "plan B" });
  f.state.tickets.push({
    ...f.state.tickets[0], id: "tkt_done", threadId: "thread-b", status: "completed", subscribed: false,
  });
  f.state.triggers.push({
    id: "trg_wait", threadId: "thread", threadKey: "manual:test", kind: "manual", sender: "user",
    text: "pending 事件", status: "pending", context: false, receivedAt: new Date().toISOString(),
  });
  const listing = await f.engine.listThreads();
  assert.match(listing, /- thread thread "test" pendingTriggers=1/);
  assert.match(listing, /- thread thread-b "plan B"/);
  assert.match(listing, /  - \[ticket\] "test" status=running subscribed=true/);
  assert.doesNotMatch(listing, /tkt_done/, "terminal tickets are omitted");
  assert.match(listing, /Find records by keyword with superagent_search/);
  assert.match(listing, /superagent_read <id>/);
  assert.doesNotMatch(listing, /more active threads not shown/, "no overflow note below the cap");
});

test("listThreads annotates truncation beyond its 10-thread and 8-ticket caps", async (t) => {
  const f = fixture(t, "running");
  // fixture 的 "thread"(updatedAt=oldTime)保持最新,11 个更旧的线程挤掉最末两个。
  for (let index = 0; index < 11; index++) {
    f.state.threads.push({
      ...f.state.threads[0], id: `thread-${index}`, key: `manual:${index}`, title: `topic ${index}`,
      updatedAt: new Date(Date.parse(oldTime) - (index + 1) * 1000).toISOString(),
    });
  }
  // 连 fixture 的 1 张共 10 张未完结票:8 张列出,+2 标注。
  for (let index = 1; index <= 9; index++) {
    f.state.tickets.push({ ...f.state.tickets[0], id: `tkt_x${index}`, title: `extra ${index}` });
  }
  const listing = await f.engine.listThreads();
  assert.match(listing, /\(\+2 more unfinished tickets not shown\)/);
  assert.match(listing, /\(2 more active threads not shown — find them by a topic keyword with superagent_search\)/);
  assert.doesNotMatch(listing, /thread-10\b/, "the oldest overflow thread is not listed");
  assert.doesNotMatch(listing, /thread-9\b/, "the second-oldest overflow thread is not listed");
  assert.match(listing, /- thread thread-0 "topic 0"/, "the boundary thread is still listed");
});

test("searchRecords matches keywords across record types, newest first, with bounded excerpts", async (t) => {
  const f = fixture(t, "running");
  const now = new Date().toISOString();
  f.state.triggers.push({
    id: "trg_hit", threadId: "thread", threadKey: "manual:test", kind: "manual", sender: "user",
    text: "检查 210 本机 caddy 是否在运行", status: "evaluated", context: false, receivedAt: now, note: null,
  });
  f.state.tickets.push({
    ...f.state.tickets[0], id: "tkt_reported", title: "caddy 核查",
    mandate: "只读核查 caddy", report: "结论:210 上没有安装 caddy,端口 80/443 空闲。", updatedAt: now,
  });
  f.state.decisions.push({
    id: "dec_hit", threadId: "thread", triggerIds: [], outcome: "reply",
    reply: "查完了:没有装 caddy。", rationale: null, ticketId: null, raw: null, createdAt: oldTime,
  });
  // AND 语义:两个词都出现才命中;分词命中跨字段(标题 + 报告)同样算。
  const both = await f.engine.searchRecords("caddy 210");
  assert.match(both, /# Search results for \[caddy 210\] — 2 match/);
  assert.match(both, /- \[trg_hit trigger manual evaluated\] user: /);
  assert.match(both, /- \[tkt_reported ticket running\] "caddy 核查": /);
  assert.match(both, /Read any record in full with superagent_read <id>/);
  // 单词命中线程标题与更早的裁决,按时间新→旧排序。
  const single = await f.engine.searchRecords("caddy");
  const order = [
    single.indexOf("[trg_hit"),
    single.indexOf("[tkt_reported"),
    single.indexOf("[dec_hit"),
  ];
  assert.ok(order[0] > 0 && order[1] > order[0] && order[2] > order[1], "newest matches come first");
  // 无命中、空白查询给出可读答复;大小写不敏感。
  assert.match(await f.engine.searchRecords("不存在的关键词"), /No records match all of/);
  assert.match(await f.engine.searchRecords("   "), /No usable keywords/);
  assert.match(await f.engine.searchRecords("CADDY"), /# Search results for \[caddy\]/);
  // 摘录有界:长文本命中时摘录不超 160 字符窗口。
  f.state.triggers.push({
    id: "trg_long", threadId: "thread", threadKey: "manual:test", kind: "manual", sender: "user",
    text: `${"前".repeat(500)}caddy${"后".repeat(500)}`, status: "evaluated", context: false,
    receivedAt: new Date(Date.now() + 1000).toISOString(), note: null,
  });
  const longHit = await f.engine.searchRecords("caddy");
  const excerpt = longHit.split("\n").find((line) => line.includes("trg_long"));
  assert.ok(excerpt.length < 220, `excerpt stays bounded, got ${excerpt.length} chars`);
  assert.ok(excerpt.startsWith("…") || excerpt.includes("…"), "mid-text hits carry an ellipsis");
});

test("worker reports truncated in the trigger text keep a recall pointer to the ticket", async (t) => {
  const f = fixture(t, "running");
  f.ticket.startedAt = new Date().toISOString();
  await f.engine.enqueueReport("thread", f.ticket, "A".repeat(3000));
  const report = f.state.triggers.find((trigger) => trigger.kind === "report");
  assert.ok(report.text.includes("A".repeat(1_999)));
  assert.match(report.text, /\[report truncated — full report: superagent_read ticket\]/);
  assert.equal(f.state.threads[0].latestResult.text.length, 3000, "thread result keeps the full report");
  await f.engine.enqueueReport("thread", f.ticket, "short one");
  const short = f.state.triggers.filter((trigger) => trigger.kind === "report").at(-1);
  assert.doesNotMatch(short.text, /report truncated/);
});

test("the eval batch window is armed once and not reset by later triggers", async (t) => {
  const f = fixture(t, "waiting");
  // 窗口留足余量:并行跑其他测试文件时,30ms 的间隔可能被负载拖过窄窗口造成假失败。
  f.values.evalBatchMs = 500;
  // fixture 把实例的 scheduleEval 换成了记录桩,这里测真实实现。
  const schedule = SuperagentEngine.prototype.scheduleEval;
  schedule.call(f.engine, "thread");
  const armed = f.engine.batchTimers.get("thread");
  assert.ok(armed, "window armed");
  await new Promise((resolve) => setTimeout(resolve, 30));
  schedule.call(f.engine, "thread");
  assert.equal(f.engine.batchTimers.get("thread"), armed, "later triggers do not reset the armed window");
  // 显式延时(0 = 立即)仍然替换定时器:handback/forceEval 需要插队。
  schedule.call(f.engine, "thread", 0);
  assert.notEqual(f.engine.batchTimers.get("thread"), armed);
  // 触发后定时器清空(线程无 pending 触发,runEval 立即返回)。按真实时间轮询:
  // 0ms 定时器在并行负载下可能晚于 50 轮 setImmediate 才触发。
  for (let waited = 0; f.engine.batchTimers.has("thread") && waited < 2000; waited += 5) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(f.engine.batchTimers.has("thread"), false);
});

test("filtered drops are recorded with a reason without eval, direct delivery, or reopening", async (t) => {
  const f = fixture(t, "running");  // running+subscribed:普通消息会直通,filtered 不允许
  const origin = { channel: "feishu", chatId: "oc_g", senderId: "ou_1" };
  await f.engine.dispatchFiltered(
    { title: "飞书群 闲聊", task: "群里闲聊,没有 @ 机器人", sender: "feishu:ou_1", origin, threadKey: "feishu:chat:oc_g" },
    "群消息未 @ 机器人",
  );
  const trigger = f.state.triggers.find((entry) => entry.status === "filtered");
  assert.ok(trigger, "filtered trigger stored");
  assert.equal(trigger.kind, "feishu");
  assert.equal(trigger.note, "群消息未 @ 机器人");
  assert.deepEqual(f.calls.evals, [], "no Router evaluation");
  assert.deepEqual(f.calls.sends, [], "no direct delivery to the subscribed worker");
  assert.ok(f.state.threads.some((thread) => thread.key === "feishu:chat:oc_g"), "thread attributed for the record");

  // 关闭的线程不被 filtered 重开;留痕有上限。
  await f.engine.dispatchFiltered(
    { title: "t", task: `overflow ${trigger.id}`, sender: "u", threadId: "thread" },
    "群消息未 @ 机器人",
  );
  const onThread = f.state.triggers.filter((entry) => entry.threadId === "thread" && entry.status === "filtered");
  assert.equal(onThread.length, 1);
  f.state.threads.find((thread) => thread.id === "thread").state = "closed";
  await f.engine.dispatchFiltered({ title: "t", task: "after close", sender: "u", threadId: "thread" }, "群消息未 @ 机器人");
  assert.equal(
    f.state.triggers.find((thread2) => thread2.id === "thread")?.state ?? f.state.threads.find((thread3) => thread3.id === "thread").state,
    "closed",
    "a filtered message does not reopen a closed thread",
  );
  for (let index = 0; index < 40; index++) {
    await f.engine.dispatchFiltered({ title: "t", task: `chatter ${index}`, sender: "u", threadId: "thread" }, "群消息未 @ 机器人");
  }
  const capped = f.state.triggers.filter((entry) => entry.threadId === "thread" && entry.status === "filtered").length;
  assert.equal(capped, 30, "filtered records are capped per thread");
});

test("transient eval errors keep requeueing well past the unparsed circuit breaker", async (t) => {
  const f = fixture(t, "waiting");
  // 异常计数:drainEvalQueue 捕获 runEval 抛错(目录未配置),计入 evalErrors 而非 evalFailures。
  f.values.workingDir = "";
  pendingTrigger(f.state);
  f.engine.evalQueued.add("thread");
  await f.engine.drainEvalQueue();
  assert.equal(f.engine.evalErrors.get("thread"), 1);
  assert.equal(f.engine.evalFailures.get("thread"), undefined);
  assert.equal(f.state.decisions.at(-1).outcome, "error");
  assert.equal(f.state.triggers[0].status, "pending", "触发保留待重试");

  // 看门狗重排门控:异常未达上限继续重排;unparsed 3 次与异常达上限都停。
  f.values.workingDir = "/mock/repo";
  f.engine.evalErrors.set("thread", 3);
  f.calls.evals.length = 0;
  await f.engine.reconcile();
  assert.deepEqual(f.calls.evals, ["thread"], "transient errors below the cap keep requeueing");
  f.engine.evalErrors.set("thread", 20);
  f.calls.evals.length = 0;
  await f.engine.reconcile();
  assert.deepEqual(f.calls.evals, [], "errors at the cap stop auto-requeueing");
  f.engine.evalErrors.delete("thread");
  f.engine.evalFailures.set("thread", 3);
  await f.engine.reconcile();
  assert.deepEqual(f.calls.evals, [], "unparsed circuit breaker still stops requeueing");
  // 成功评估与手动重评估都清两类计数。
  f.engine.evalFailures.set("thread", 1);
  f.engine.evalErrors.set("thread", 1);
  await f.engine.forceEval("thread");
  assert.equal(f.engine.evalFailures.get("thread"), undefined);
  assert.equal(f.engine.evalErrors.get("thread"), undefined);
});

// ---------------------------------------------------------------------------
// 《Super-agent》各模块的补齐:语义慢路径、引用归线程、相邻消息内联、多对多订阅、
// 投机执行、链式召回、LLM 看门狗、引擎启动前排队。

const otherThread = (id, title = "B 讨论") => ({
  id, key: `manual:${id}`, title, state: "active", summary: null, createdAt: oldTime, updatedAt: oldTime,
});

test("context-only messages on a subscribed thread go to the Router instead of the workers", async (t) => {
  const f = fixture(t, "waiting");
  const result = await f.engine.dispatch({ task: "群里闲聊一句", threadId: "thread", context: true });
  assert.equal(result.directDelivered, false);
  assert.equal(f.calls.sends.length, 0, "overheard chatter never steers a worker");
  assert.deepEqual(f.calls.evals, ["thread"]);
  const addressed = await f.engine.dispatch({ task: "正式的追问", threadId: "thread" });
  assert.equal(addressed.directDelivered, true, "addressed follow-ups still take the fast path");
});

test("an IM reply quoting a known message joins that message's thread and the Router sees the quote", async (t) => {
  const f = fixture(t, "completed");
  const chat = (messageId, senderId) => ({ channel: "feishu", chatId: "oc_g", messageId, senderId });
  f.state.triggers.push({
    id: "trg_m1", threadId: "thread", threadKey: "manual:test", kind: "feishu", sender: "feishu:ou_a",
    text: "登录页报 500", status: "evaluated", context: false, receivedAt: oldTime, origin: chat("m1", "ou_a"),
  });
  const result = await f.engine.dispatch({
    task: "还是不行", sender: "feishu:ou_b", origin: chat("m2", "ou_b"),
    threadKey: "feishu:chat:oc_g:root:m1", replyTo: ["m1"],
  });
  assert.equal(result.threadId, "thread", "the reply continues the quoted message's thread");
  const trigger = f.state.triggers.find((item) => item.id === result.triggerId);
  assert.equal(trigger.quote.triggerId, "trg_m1");
  await f.engine.runEval("thread");
  assert.match(f.calls.prompts.at(-1), /quoting: trg_m1 \(feishu:ou_a\): "登录页报 500"/);
});

test("quoting a Router reply finds its thread through the sent message id the channel returned", async (t) => {
  const f = fixture(t, "completed");
  pendingTrigger(f.state);
  f.state.triggers[0].origin = { channel: "qq", chatId: "g:1", messageId: "5", senderId: "u" };
  f.controls.verdict = { actions: [{ action: "reply", reply: "已修复,请重试" }] };
  f.engine.setReplySink({ send: async () => "901" });
  await f.engine.runEval("thread");
  assert.deepEqual(f.state.imDeliveries[0].sentMessageIds, ["901"]);
  const result = await f.engine.dispatch({
    task: "确认可以了", sender: "qq:u", origin: { channel: "qq", chatId: "g:1", messageId: "6", senderId: "u" },
    threadKey: "qq:group:elsewhere", replyTo: ["901"],
  });
  assert.equal(result.threadId, "thread");
  const trigger = f.state.triggers.find((item) => item.id === result.triggerId);
  assert.equal(trigger.quote.sender, "router");
  assert.equal(trigger.quote.text, "已修复,请重试");
});

test("filtered chatter rolls over and the latest unaddressed messages are inlined for the Router", async (t) => {
  const f = fixture(t, "completed");
  const origin = (messageId, senderId = "ou_x") => ({ channel: "feishu", chatId: "oc_g", messageId, senderId });
  for (let i = 0; i < 32; i++) {
    await f.engine.dispatchFiltered({ task: `闲聊 ${i}`, sender: "feishu:ou_x", origin: origin(`c${i}`), threadId: "thread" }, "群消息未 @ 机器人");
  }
  const filtered = f.state.triggers.filter((item) => item.status === "filtered");
  assert.equal(filtered.length, 30, "the record keeps a rolling window instead of freezing at the cap");
  assert.ok(!filtered.some((item) => item.text === "闲聊 0" || item.text === "闲聊 1"));
  await f.engine.dispatch({ task: "刚才说的问题帮看下", sender: "feishu:ou_y", origin: origin("q1", "ou_y"), threadId: "thread" });
  await f.engine.runEval("thread");
  const prompt = f.calls.prompts.at(-1);
  const section = prompt.split("## Recent unaddressed chat in this conversation (filtered at admission; context only)\n")[1]?.split("\n\n")[0];
  assert.ok(section, "the neighbouring chatter is inlined");
  assert.deepEqual(section.split("\n").map((line) => line.replace(/^- \[[^\]]+\] /, "")),
    [27, 28, 29, 30, 31].map((i) => `feishu:ou_x: 闲聊 ${i}`), "only the latest few neighbours, oldest first");
  assert.equal(prompt.split("闲聊 31").length - 1, 1, "inlined chatter is not repeated in the history stubs");
});

test("a Router subscribe makes another thread's worker follow this one: follow-ups fan out and reports return to both", async (t) => {
  const f = fixture(t, "running");
  f.state.threads.push(otherThread("thread-b"));
  f.state.triggers.push({
    id: "trg_b", threadId: "thread-b", threadKey: "manual:thread-b", kind: "manual", sender: "user",
    text: "这和 A 那边的修复是一回事", status: "pending", context: false, receivedAt: new Date().toISOString(),
  });
  f.controls.verdict = { actions: [{ action: "subscribe", ticketId: "ticket" }, { action: "steer", ticketId: "ticket", text: "B 线程也在等这个修复" }] };
  await f.engine.runEval("thread-b");
  assert.deepEqual(f.ticket.follows, ["thread-b"]);
  const subscribed = f.state.decisions.find((decision) => decision.outcome === "subscribe");
  assert.equal(subscribed.ticketId, "ticket");
  assert.match(subscribed.rationale, /also follows this thread \(home thread thread\)/);

  const follow = await f.engine.dispatch({ task: "B 这边补充了日志", threadId: "thread-b" });
  assert.equal(follow.directDelivered, true);
  assert.equal(f.calls.sends.at(-1).text, '[thread thread-b "B 讨论"] B 这边补充了日志');

  await f.engine.settleTicketRun("ticket", null);
  assert.equal(f.ticket.status, "waiting");
  const reports = f.state.triggers.filter((item) => item.kind === "report");
  assert.deepEqual(reports.map((item) => item.threadId).sort(), ["thread", "thread-b"]);

  f.controls.verdict = { actions: [{ action: "ignore" }] };
  await f.engine.runEval("thread-b");
  assert.match(f.calls.prompts.at(-1), /also follow this thread[^\n]*\n- \[ticket\] "test" status=waiting home-thread=thread/);
});

test("a subscribe for a finished or unknown ticket is recorded without changing anything", async (t) => {
  const f = fixture(t, "failed");
  f.state.threads.push(otherThread("thread-b"));
  f.state.triggers.push({
    id: "trg_b", threadId: "thread-b", threadKey: "manual:thread-b", kind: "manual", sender: "user",
    text: "接上", status: "pending", context: false, receivedAt: new Date().toISOString(),
  });
  f.controls.verdict = { actions: [{ action: "subscribe", ticketId: "ticket" }] };
  await f.engine.runEval("thread-b");
  assert.deepEqual(f.ticket.follows ?? [], []);
  assert.match(f.state.decisions.at(-1).rationale, /is failed; nothing subscribed/);
});

test("a worker can leave one followed thread, and closing a followed thread keeps the ticket", async (t) => {
  const f = fixture(t, "waiting");
  f.state.threads.push(otherThread("thread-b"), otherThread("thread-c", "C"));
  f.ticket.follows = ["thread-b", "thread-c"];
  const left = await f.engine.workerUnsubscribe("ticket", "thread-b");
  assert.equal(left.ok, true);
  assert.match(left.note, /from thread thread-b/);
  assert.deepEqual(f.ticket.follows, ["thread-c"]);
  assert.equal(f.ticket.subscribed, true);
  assert.equal(f.ticket.status, "waiting");
  const unknown = await f.engine.workerUnsubscribe("ticket", "thread-x");
  assert.equal(unknown.ok, false);
  await f.engine.closeThread("thread-c");
  assert.deepEqual(f.ticket.follows, []);
  assert.equal(f.ticket.status, "waiting");
  assert.equal(f.calls.archives.length, 0, "a followed thread closing does not retire the follower");
});

test("speculative dispatch is honored only when enabled, never subscribes, and is capped", async (t) => {
  const f = fixture(t, "completed");
  const spec = (title) => ({ action: "dispatch", title, mandate: `静默尝试:${title}`, speculative: true });
  f.controls.verdict = { actions: [spec("复现登录问题")] };
  await evaluateRouter(f, "群里有人说登录挂了");
  const plain = f.state.tickets.at(-1);
  assert.equal(plain.speculative, false, "the flag is ignored while the setting is off");
  assert.equal(plain.subscribed, true);
  assert.doesNotMatch(f.calls.prompts.at(-1), /Speculative execution/);

  f.values.speculativeEnabled = true;
  f.controls.verdict = { actions: [spec("一"), spec("二"), spec("三")] };
  await evaluateRouter(f, "又有人反馈");
  assert.match(f.calls.prompts.at(-1), /## Speculative execution \(enabled\)/);
  const speculative = f.state.tickets.filter((ticket) => ticket.speculative);
  assert.deepEqual(speculative.map((ticket) => ticket.title), ["一", "二"]);
  assert.ok(speculative.every((ticket) => ticket.subscribed === false));
  const dropped = f.state.decisions.filter((decision) => decision.outcome === "ignore" && /speculative dispatch "三" dropped/.test(decision.rationale ?? ""));
  assert.equal(dropped.length, 1);
  await until(() => f.calls.workerCreates.some((options) => options.title === "二"));
  assert.match(f.calls.workerCreates.find((options) => options.title === "二").prompt, /\[Speculative background attempt\][\s\S]*DISCARD:/);
});

test("a DISCARD speculative report is dropped silently with its worker retired; DELIVER reaches the Router", async (t) => {
  const discard = fixture(t, "running");
  Object.assign(discard.ticket, { speculative: true, subscribed: false });
  discard.controls.timeline = async () => ({ entries: [{ seqStart: 1, item: { type: "assistant_message", text: "DISCARD: 无法复现" } }] });
  await discard.engine.settleTicketRun("ticket", null);
  assert.equal(discard.ticket.status, "completed");
  const silent = discard.state.triggers.find((item) => item.kind === "report");
  assert.equal(silent.status, "evaluated");
  assert.equal(silent.note, "speculative attempt discarded");
  assert.ok(discard.calls.archives.includes("worker"));
  assert.equal(discard.calls.evals.length, 0, "nothing reaches the Router or the human");

  const deliver = fixture(t, "running");
  Object.assign(deliver.ticket, { speculative: true, subscribed: false });
  deliver.controls.timeline = async () => ({ entries: [{ seqStart: 1, item: { type: "assistant_message", text: "DELIVER: 已复现并修复,分支 superagent/fix" } }] });
  await deliver.engine.settleTicketRun("ticket", null);
  const report = deliver.state.triggers.find((item) => item.kind === "report");
  assert.equal(report.status, "pending");
  assert.match(report.text, /speculative background attempt[\s\S]*DELIVER: 已复现并修复/);
  assert.deepEqual(deliver.calls.evals, ["thread"]);
});

test("chain of recall: threads list their messages, decisions and followers; tickets their follows and session tail", async (t) => {
  const f = fixture(t, "running");
  f.state.threads[0].id = "thr_main";
  Object.assign(f.ticket, { id: "tkt_main", threadId: "thr_main", follows: ["thr_b"] });
  f.state.threads.push({ ...otherThread("thr_b"), title: "B 讨论" });
  f.state.triggers.push({
    id: "trg_1", threadId: "thr_main", threadKey: "manual:test", kind: "manual", sender: "user",
    text: "请修复登录", status: "evaluated", context: false, receivedAt: oldTime,
  });
  f.state.decisions.push({
    id: "dec_1", threadId: "thr_main", triggerIds: ["trg_1"], outcome: "dispatch", reply: null,
    rationale: null, ticketId: "tkt_main", raw: null, createdAt: oldTime,
  });
  const thread = await f.engine.readRecord("thr_main");
  assert.match(thread, /## recent messages \(1 of 1, oldest first\)\n- \[trg_1 manual evaluated\] user: 请修复登录/);
  assert.match(thread, /## recent router decisions \(1 of 1\)\n- \[dec_1 dispatch\] tkt_main/);
  const followed = await f.engine.readRecord("thr_b");
  assert.match(followed, /## tickets of other threads following this one \(1\)\n- \[tkt_main\] "test" status=running home-thread=thr_main/);
  const ticket = await f.engine.readRecord("tkt_main");
  assert.match(ticket, /also follows: thread thr_b "B 讨论" \(active\)/);
  assert.match(ticket, /## recent worker messages \(session tail, oldest first\)\n- work completed/);
});

test("the LLM watchdog patrols unfinished work, judges progress across patrols, and acts through its verdict", async (t) => {
  const f = fixture(t, "running");
  f.values.watchdogEnabled = true;
  f.controls.patrolVerdict = {
    summary: "ticket loops on the same failure",
    actions: [
      { action: "nudge", ticketId: "ticket", text: "先跑单测再改代码" },
      { action: "escalate", ticketId: "ticket", text: "需要人决定是否回滚" },
    ],
  };
  await f.engine.maybePatrol(true);
  assert.equal(f.calls.watchdogCreates.length, 1);
  const created = f.calls.watchdogCreates[0];
  assert.equal(created.labels["superagent.role"], "watchdog");
  assert.match(created.config.systemPrompt, /Superagent Watchdog instructions/);
  assert.deepEqual(created.config.options, { sandbox_mode: "read-only" }, "codex sessions get a read-only sandbox");
  assert.match(f.calls.patrols[0], /### ticket "test" — status=running/);
  assert.match(f.calls.patrols[0], /activity: first patrol for this ticket/);
  assert.match(f.calls.patrols[0], /latest worker message \(excerpt\):\n```text\nwork completed/);
  assert.ok(f.calls.sends.some((send) => send.id === "worker" && send.text === "[watchdog] 先跑单测再改代码"));
  const escalation = f.state.triggers.find((item) => item.sender === "watchdog");
  assert.equal(escalation.status, "pending");
  assert.match(escalation.text, /需要人决定是否回滚/);
  assert.ok(f.calls.evals.includes("thread"), "the Router tells the human");
  assert.equal(f.state.decisions.filter((decision) => decision.outcome === "watchdog").length, 2);
  assert.equal(f.state.kv.watchdog.lastSummary, "ticket loops on the same failure");

  f.controls.patrolVerdict = { summary: "steady", actions: [] };
  await f.engine.maybePatrol(true);
  assert.equal(f.calls.watchdogCreates.length, 1, "the watchdog session is reused");
  assert.match(f.calls.patrols[1], /activity since last patrol: NONE/);
  assert.doesNotMatch(f.calls.patrols[1], /Superagent Watchdog instructions/, "rules are not resent to the same session");
  assert.equal(f.engine.snapshot().engine.patrol.lastSummary, "steady");
});

test("the LLM watchdog stays off by default and skips the model when there is nothing to patrol", async (t) => {
  const off = fixture(t, "running");
  await off.engine.maybePatrol(true);
  assert.equal(off.calls.patrols.length, 0);
  assert.equal(off.state.kv.watchdog, undefined);

  const idle = fixture(t, "completed");
  idle.values.watchdogEnabled = true;
  await idle.engine.maybePatrol(true);
  assert.equal(idle.calls.patrols.length, 0);
  assert.equal(idle.calls.watchdogCreates.length, 0);
  assert.equal(idle.state.kv.watchdog.lastSummary, "nothing to patrol");
});

test("an unparsable watchdog reply is recorded and the rules are resent next time", async (t) => {
  const f = fixture(t, "running");
  f.values.watchdogEnabled = true;
  f.values.routerProvider = "zcode-acp/builtin:plan\\GLM";
  f.controls.patrolVerdict = "not json";
  await f.engine.maybePatrol(true);
  assert.match(f.calls.patrols[0], /Superagent Watchdog instructions/, "ACP sessions receive the rules in the first turn");
  assert.match(f.state.kv.watchdog.lastError, /^unparsed/);
  f.controls.patrolVerdict = { summary: "ok", actions: [] };
  await f.engine.maybePatrol(true);
  assert.match(f.calls.patrols[1], /Superagent Watchdog instructions/);
  assert.equal(f.state.kv.watchdog.lastError, null);
});

test("messages that arrive before the engine starts are kept and delivered once it starts", async (t) => {
  const f = fixture(t, "waiting");
  f.engine.paseo = null;
  const queued = await f.engine.dispatch({ task: "引擎启动前的消息", threadId: "thread" });
  assert.equal(queued.directDelivered, false);
  assert.equal(f.calls.sends.length, 0);
  assert.equal(f.calls.evals.length, 0);
  f.engine.paseo = f.paseo;
  await f.engine.flushQueuedBeforeStart();
  assert.equal(f.calls.sends[0].text, "引擎启动前的消息");
  const trigger = f.state.triggers.find((item) => item.id === queued.triggerId);
  assert.equal(trigger.status, "delivered");
  assert.equal(f.engine.orchestrationRole("worker"), "worker");
  assert.equal(f.engine.orchestrationRole("router"), "router");
  assert.equal(f.engine.orchestrationRole("someone-else"), null);
});

test("a new codex Router is created with a read-only sandbox", async (t) => {
  const f = fixture(t, "waiting");
  f.state.kv.routerAgentId = null;
  await evaluateRouter(f, "first event");
  assert.deepEqual(f.calls.routerCreates[0].config.options, { sandbox_mode: "read-only" });
});
