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
    ownsWorkspace: hasWorker ? true : null,
    startedAt: oldTime, attempts: status === "pending" ? 0 : 1, subscribed,
    report: null, lastError: null, createdAt: oldTime, updatedAt: oldTime,
  });
  const calls = {
    sends: [], watches: [], archives: [], workspaceArchives: [], creates: 0, workspaceCreateOptions: [], evals: [],
    routerCreates: [], workerCreates: [], prompts: [],
  };
  const controls = {
    send: async () => {},
    createAgent: async () => ({ id: "new-worker" }),
    createRouterAgent: async () => ref("new-router"),
    timeline: async () => ({ entries: [{ seqStart: 1, item: { type: "assistant_message", text: "work completed" } }] }),
    verdict: { decision: "reply", reply: "done" },
    isGit: true,
    instructionFiles: [],
    routerSessionId: null,
    routerTimeline: async () => ({ entries: [] }),
    /** worktree 创建后工作区 descriptor 报告的实际分支;null 表示未报告(退回请求名)。 */
    workspaceBranch: null,
  };
  const finishes = [];
  const handles = new Map();
  const ref = (id) => {
    if (!handles.has(id)) handles.set(id, {
      id,
      refresh: async () => ({ agent: { status: id === "router" ? "idle" : "running", archivedAt: null,
        persistence: id.includes("router") && controls.routerSessionId ? { sessionId: controls.routerSessionId } : null } }),
      current: () => ({ persistence: controls.routerSessionId ? { sessionId: controls.routerSessionId } : null }),
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
  return { engine, state, calls, controls, finishes, ref, values, ticket: state.tickets[0], daemonWorkspaces };
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
  assert.match(first, /do NOT call any tools/);
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
  assert.match(system, /do NOT call any tools/);
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
  assert.match(listing, /superagent_read <id>/);
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
