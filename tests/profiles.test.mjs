import assert from "node:assert/strict";
import test from "node:test";
import { matchWorkerProfile } from "../server/providers.ts";
import { composeEvalPrompt, parseVerdict } from "../server/router.ts";
import { emptyState } from "../shared/model.ts";
import { SETTINGS_DEFAULTS, superagentSettings } from "../shared/settings.ts";

const PROFILES = [
  { name: "code", provider: "codex/gpt", description: "write and fix code, run tests" },
  { name: "research", provider: "zcode-acp/builtin:plan\\GLM", description: "Chinese reports and research" },
];

const thread = { id: "t", key: "k", title: "t", state: "active", summary: null, createdAt: "", updatedAt: "" };
const trigger = { id: "g", threadId: "t", threadKey: "k", kind: "manual", sender: "u", text: "x", status: "pending", context: false, receivedAt: "" };

test("matchWorkerProfile maps names onto the configured list and falls back to the default", () => {
  assert.deepEqual(matchWorkerProfile("code", PROFILES), { profile: "code", note: null });
  assert.deepEqual(matchWorkerProfile(" Research ", PROFILES), { profile: "research", note: null });
  assert.deepEqual(matchWorkerProfile(undefined, PROFILES), { profile: null, note: null });
  assert.deepEqual(matchWorkerProfile(null, PROFILES), { profile: null, note: null });
  assert.deepEqual(matchWorkerProfile("default", PROFILES), { profile: null, note: null });
  const unknown = matchWorkerProfile("codex/gpt-5.5", PROFILES);
  assert.equal(unknown.profile, null, "a raw provider id is not a profile");
  assert.match(unknown.note, /unknown worker profile "codex\/gpt-5\.5" \(configured: code, research\); used the default worker/);
  assert.match(matchWorkerProfile("code", []).note, /configured: none/);
});

test("settings default to no profiles and validate profile names, uniqueness and required fields", () => {
  assert.deepEqual(SETTINGS_DEFAULTS.workerProfiles, []);
  assert.equal(SETTINGS_DEFAULTS.workerDescription, "");
  // v4 settings (no profile fields) still parse.
  const legacy = superagentSettings.schema.parse({ workerProvider: "codex/gpt", workingDir: "/repo" });
  assert.deepEqual(legacy.workerProfiles, []);

  assert.equal(superagentSettings.schema.safeParse({ workerProfiles: PROFILES }).success, true);
  const issues = (workerProfiles) =>
    superagentSettings.schema.safeParse({ workerProfiles }).error?.issues.map((issue) => issue.path.join("."));
  assert.deepEqual(issues([PROFILES[0], { ...PROFILES[1], name: "code" }]), ["workerProfiles.1.name"]);
  assert.deepEqual(issues([{ ...PROFILES[0], name: "default" }]), ["workerProfiles.0.name"]);
  assert.deepEqual(issues([{ ...PROFILES[0], name: "Code" }]), ["workerProfiles.0.name"]);
  assert.deepEqual(issues([{ ...PROFILES[0], provider: " " }]), ["workerProfiles.0.provider"]);
  assert.deepEqual(issues([{ ...PROFILES[0], description: "" }]), ["workerProfiles.0.description"]);
  const tooMany = Array.from({ length: 9 }, (_, index) => ({ ...PROFILES[0], name: `p${index}` }));
  assert.deepEqual(issues(tooMany), ["workerProfiles"]);
});

test("the Router prompt lists worker profiles only when some are configured", () => {
  const state = emptyState();
  const single = composeEvalPrompt({
    thread, batch: [trigger], state,
    worker: { workingDir: "/repo", isolation: "worktree", issue: null, profiles: [] },
  });
  assert.doesNotMatch(single, /Worker profiles|"profile"/);

  const multi = composeEvalPrompt({
    thread, batch: [trigger], state,
    worker: {
      workingDir: "/repo", isolation: "worktree", issue: null,
      defaultWorker: { provider: "zcode-acp/builtin:plan\\GLM", description: "" },
      profiles: PROFILES,
    },
  });
  assert.match(multi, /## Worker profiles\nEach dispatch runs on one worker profile\. Set "profile"/);
  assert.match(multi, /- default \(zcode-acp\/builtin:plan\\GLM\): general work that fits no other profile/);
  assert.match(multi, /- code \(codex\/gpt\): write and fix code, run tests/);
  assert.match(multi, /- research \(zcode-acp\/builtin:plan\\GLM\): Chinese reports and research/);
  assert.match(multi, /"action":"dispatch","title":"\.\.\.","mandate":"\.\.\.","profile":"<profile name, optional>"/);
  assert.ok(multi.indexOf("## Worker profiles") < multi.indexOf("# Thread: t"), "profiles are part of the instructions");

  const unresolved = composeEvalPrompt({
    thread, batch: [trigger], state,
    worker: { workingDir: "/repo", isolation: "worktree", issue: null, defaultWorker: { provider: null, description: "general" }, profiles: PROFILES },
  });
  assert.match(unresolved, /- default \(auto-selected\): general/);
});

test("a profile with its own working directory is listed with it; others stay on the base directory", () => {
  const state = emptyState();
  const prompt = composeEvalPrompt({
    thread, batch: [trigger], state,
    worker: {
      workingDir: "/repo", isolation: "worktree", issue: null,
      defaultWorker: { provider: "codex/gpt", description: "general" },
      profiles: [
        { ...PROFILES[0], workingDir: "/srv/other" },
        { ...PROFILES[1], workingDir: "  " },
      ],
    },
  });
  assert.match(prompt, /- code \(codex\/gpt; base directory \/srv\/other\): write and fix code, run tests/);
  assert.match(prompt, /- research \(zcode-acp\/builtin:plan\\GLM\): Chinese reports and research/);
  assert.match(prompt, /A profile that lists its own base directory runs there instead of the default base directory/);
});

test("v6 profiles without a working directory parse with an empty default", () => {
  const parsed = superagentSettings.schema.parse({
    workerProfiles: [{ name: "code", provider: "codex/gpt", description: "write code" }],
  });
  assert.equal(parsed.workerProfiles[0].workingDir, "");
  const explicit = superagentSettings.schema.parse({
    workerProfiles: [{ name: "code", provider: "codex/gpt", description: "write code", workingDir: " /srv/other " }],
  });
  assert.equal(explicit.workerProfiles[0].workingDir, "/srv/other");
});

test("v9 settings keep Paseo defaults and explicit provider modes round-trip", () => {
  const legacy = superagentSettings.schema.parse({ workerProfiles: PROFILES });
  assert.equal(legacy.workerModeId, "");
  assert.deepEqual(legacy.workerProfiles.map((profile) => profile.modeId), ["", ""]);
  const configured = superagentSettings.schema.parse({
    workerModeId: " full-access ",
    workerProfiles: [{ ...PROFILES[0], modeId: " ask " }],
  });
  assert.equal(configured.workerModeId, "full-access");
  assert.equal(configured.workerProfiles[0].modeId, "ask");
  assert.deepEqual(superagentSettings.schema.parse(configured), configured);
});

test("ticket lines name a non-default profile so the Router can steer and retry knowingly", () => {
  const state = emptyState();
  const ticket = (id, status, profile) => ({
    id, threadId: "t", title: id, mandate: "m", status, workerAgentId: "ag", workspaceId: "ws",
    branchName: null, profile, provider: null, startedAt: null, attempts: 1, subscribed: true,
    report: null, lastError: null, createdAt: "", updatedAt: "2026-01-01T00:00:00.000Z",
  });
  state.tickets.push(ticket("tkt_code", "running", "code"), ticket("tkt_plain", "running", null), ticket("tkt_old", "failed", "research"));
  const prompt = composeEvalPrompt({
    thread, batch: [trigger], state,
    worker: { workingDir: "/repo", isolation: "worktree", issue: null, profiles: PROFILES },
  });
  assert.match(prompt, /- \[tkt_code\] "tkt_code" status=running subscribed=true profile=code\n/);
  assert.match(prompt, /- \[tkt_plain\] "tkt_plain" status=running subscribed=true\n/);
  assert.match(prompt, /- \[tkt_old\] "tkt_old" status=failed profile=research/);
});

test("parseVerdict keeps an optional dispatch profile", () => {
  const parsed = parseVerdict('{"actions":[{"action":"dispatch","title":"A","mandate":"m","profile":"code"},{"action":"dispatch","title":"B","mandate":"m","profile":null}]}');
  assert.equal(parsed.verdict.actions[0].profile, "code");
  assert.equal(parsed.verdict.actions[1].profile, null);
});
