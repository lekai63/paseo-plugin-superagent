import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { defineTranslations } from "@getpaseo/plugin/client";
import { PluginTranslationRuntime } from "@getpaseo/plugin/client/host";
import { allTranslations, resolveLanguage, translate, translator } from "../shared/i18n.ts";
import { en } from "../shared/locales/en/index.ts";
import { zhCN } from "../shared/locales/zh-CN/index.ts";
import { relativeTime, stampTime, threadStatus, watchdogNoteLabel, patrolSummaryLabel } from "../shared/labels.ts";
import { elapsedTime } from "../shared/execution.ts";
import { settingsIssueText, superagentSettings } from "../shared/settings.ts";
import { serverLanguage, setServerLanguage, t as serverT } from "../server/i18n.ts";
import { workspaceTitles } from "../server/workspace.ts";

const english = translator("en");
const chinese = translator("zh-CN");

function leaves(tree, prefix = "") {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === "string" ? [[prefix + key, value]] : leaves(value, `${prefix}${key}.`));
}
const placeholders = (value) => [...value.matchAll(/{{-?\s*([^},\s]+)[^}]*}}/g)].map((match) => match[1]).sort().join(",");

test("Simplified Chinese app languages select Chinese; everything else is English", () => {
  for (const locale of ["zh-CN", "zh-cn", "zh_CN", "zh", "zh-Hans", "zh-Hans-CN"]) assert.equal(resolveLanguage(locale), "zh-CN", locale);
  for (const locale of ["en", "en-US", "ja", "fr", "zh-TW", "zh-Hant", "pt-BR", "", null, undefined]) {
    assert.equal(resolveLanguage(locale), "en", String(locale));
  }
});

test("Chinese resources translate every English key with the same placeholders", () => {
  const source = new Map(leaves(en));
  const target = new Map(leaves(zhCN));
  const base = (key) => key.replace(/_(zero|one|two|few|many|other)$/, "");
  for (const [key, value] of source) {
    if (/_(zero|one|two|few|many)$/.test(key)) continue;
    assert.ok(target.has(key), `missing zh-CN translation: ${key}`);
    assert.equal(placeholders(target.get(key)), placeholders(value), `placeholders differ: ${key}`);
  }
  for (const key of target.keys()) {
    assert.ok(source.has(key) || source.has(`${base(key)}_other`), `zh-CN key not in English: ${key}`);
  }
  for (const [key, value] of [...source, ...target]) {
    assert.ok(value.trim(), `empty message: ${key}`);
    assert.ok(!value.includes("$t("), `i18next nesting is not supported: ${key}`);
  }
});

test("the host resolves registered labels in the app language and falls back to English", () => {
  const messages = defineTranslations({ resources: { en, "zh-CN": zhCN } });
  const resolveIn = (locale) => {
    const runtime = new PluginTranslationRuntime({ getLocale: () => locale, subscribe: () => () => {} });
    try {
      return runtime.resolve(messages.message("host.commandStatus"));
    } finally {
      runtime.dispose();
    }
  };
  assert.equal(resolveIn("zh-CN"), "Superagent 运行状态");
  assert.equal(resolveIn("en"), "Superagent status");
  assert.equal(resolveIn("ja"), "Superagent status");
});

test("translate interpolates, picks English plural forms and reports unknown keys by name", () => {
  assert.equal(english("labels.watchdogNote.reconciled", { count: 1 }), "Auto-fixed 1 item");
  assert.equal(english("labels.watchdogNote.reconciled", { count: 3 }), "Auto-fixed 3 items");
  assert.equal(chinese("labels.watchdogNote.reconciled", { count: 1 }), "已自动修复 1 项");
  assert.equal(english("labels.chatEvent.delegatedBy", { sender: "Agent 1234" }), "Delegated by Agent 1234");
  assert.equal(translate("zh-CN", "no.such.key"), "no.such.key");
  assert.equal(english.lang, "en");
  assert.equal(translator("zh-CN"), chinese, "translators are cached per language");
});

test("shared labels render in English", () => {
  const now = Date.parse("2026-03-10T12:00:00.000Z");
  assert.equal(relativeTime("2026-03-10T11:59:30.000Z", english, now), "just now");
  assert.equal(relativeTime("2026-03-10T11:55:00.000Z", english, now), "5m ago");
  assert.equal(relativeTime("2026-03-08T12:00:00.000Z", english, now), "2d ago");
  assert.equal(relativeTime("2026-01-02T12:00:00.000Z", english, now), "Jan 2");
  assert.equal(relativeTime("2025-01-02T12:00:00.000Z", english, now), "Jan 2, 2025");
  const local = new Date(2026, 10, 6, 12).getTime();
  assert.equal(stampTime(new Date(2026, 9, 31, 23, 59).toISOString(), english, local), "Oct 31 23:59");
  assert.equal(stampTime(new Date(2025, 0, 2, 7, 0).toISOString(), english, local), "Jan 2, 2025 07:00");
  assert.deepEqual(threadStatus({ state: "active", pendingTriggers: 1 }, [], [], english), { label: "Awaiting evaluation", tone: "warning" });
  assert.equal(watchdogNoteLabel(null, english), "All clear");
  assert.equal(patrolSummaryLabel("nothing to patrol: 1 parked waiting ticket(s)", english),
    "Only 1 standby task with no new activity; the model was not called");
  assert.equal(elapsedTime("2026-03-10T10:57:00.000Z", english, now), "1h 3m");
});

test("settings validation messages are message keys translated by the settings screen", () => {
  const parsed = superagentSettings.schema.safeParse({
    workerProfiles: [
      { name: "code", provider: "codex", description: "write code" },
      { name: "code", provider: "codex", description: "again" },
    ],
  });
  assert.equal(parsed.success, false);
  const issue = parsed.error.issues.find((item) => item.path.join(".") === "workerProfiles.1.name");
  assert.equal(settingsIssueText(issue, english), 'Profile name "code" is used more than once');
  assert.equal(settingsIssueText(issue, chinese), '档位名 "code" 重复');
  assert.equal(settingsIssueText({ code: "invalid_type", message: "Expected string" }, chinese), "Expected string");
});

test("daemon text follows the last reported language; plugin workspaces are recognized in either language", () => {
  assert.equal(serverLanguage(), "en");
  assert.equal(serverT("labels.workspace.default"), "Default workspace");
  assert.deepEqual(workspaceTitles("labels.workspace.default"), ["Default workspace", "默认 workspace"]);
  setServerLanguage("zh-CN");
  try {
    assert.equal(serverT.lang, "zh-CN");
    assert.deepEqual(workspaceTitles("labels.workspace.background"), ["Superagent 后台", "Superagent background"]);
  } finally {
    setServerLanguage("en");
  }
  assert.deepEqual(allTranslations("labels.workspace.background").sort(), ["Superagent background", "Superagent 后台"].sort());
});

/**
 * 界面文字只写在 shared/locales 里:源码中不应再有中文字符串字面量(注释不算)。
 * 下面是有意保留的中文字面量,每一项都说明原因。
 */
const ALLOWED_CJK_LITERALS = new Set([
  // 命令中心搜索关键词:不随语言切换,中英文都收。
  "历史", "消息", "线程", "对话", "状态", "看门狗", "设置",
]);
const SOURCE_DIRS = ["client", "server", "shared"];
const CJK = /[　-〿一-鿿＀-￯]/;

function sourceFiles() {
  const files = ["index.client.tsx", "index.server.ts"];
  for (const dir of SOURCE_DIRS) {
    for (const name of readdirSync(new URL(`../${dir}/`, import.meta.url))) {
      if (/\.(ts|tsx)$/.test(name)) files.push(`${dir}/${name}`);
    }
  }
  return files;
}

test("no Chinese string literals remain outside shared/locales", () => {
  const offenders = [];
  for (const file of sourceFiles()) {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (node) => {
      if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node) || ts.isJsxText(node)) {
        const value = ts.isJsxText(node) ? node.getText(source).trim() : node.text;
        if (CJK.test(value) && !ALLOWED_CJK_LITERALS.has(value)) {
          offenders.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: ${value.slice(0, 60)}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.deepEqual(offenders, [], `move these strings into shared/locales:\n${offenders.join("\n")}`);
});
