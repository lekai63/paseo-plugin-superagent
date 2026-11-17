import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizePiPermissionModes,
  STOCK_PI_PERMISSION_MODES,
} from "../shared/pi-modes.ts";
import {
  piPermissionModesInstalled,
  readPiPermissionModes,
  resolvePiAgentDir,
} from "../server/pi-modes.ts";

function agentDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "superagent-pi-modes-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function installPackage(dir) {
  const packageDir = join(dir, "npm", "node_modules", "pi-permission-modes");
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: "pi-permission-modes" }));
}

function writeConfig(dir, config) {
  mkdirSync(join(dir, "permission-mode"), { recursive: true });
  writeFileSync(join(dir, "permission-mode", "permission-mode.json"), JSON.stringify(config));
}

test("stock modes are used until the user config overrides labels, order and default", () => {
  assert.deepEqual(
    normalizePiPermissionModes(undefined).modes.map((mode) => mode.id),
    STOCK_PI_PERMISSION_MODES.map((mode) => mode.id),
  );

  const merged = normalizePiPermissionModes({
    defaultMode: "yolo",
    cycleOrder: ["yolo", "default"],
    modes: {
      default: { label: "Ops Gate" },
      yolo: { label: "YOLO" },
      review: { label: "Review" },
    },
  });
  assert.deepEqual(merged.modes.map((mode) => mode.id), ["yolo", "default", "plan", "build", "review"]);
  assert.equal(merged.modes.find((mode) => mode.id === "default").label, "Ops Gate");
  assert.equal(merged.defaultModeId, "yolo");
});

test("an unknown defaultMode falls back to the first mode; unusable ids are dropped", () => {
  const normalized = normalizePiPermissionModes({
    defaultMode: "missing",
    cycleOrder: ["bad id", "review"],
    modes: {
      "bad id": { label: "Bad" },
      ["__proto__"]: { label: "Prototype" },
      review: {},
    },
  });
  assert.equal(normalized.defaultModeId, "review");
  assert.ok(!normalized.modes.some((mode) => mode.id === "bad id"));
  assert.equal(normalized.modes.find((mode) => mode.id === "review").label, "review");
});

test("an agent dir without the extension is unavailable", (t) => {
  const dir = agentDir(t);
  assert.equal(piPermissionModesInstalled(dir), false);
  assert.deepEqual(readPiPermissionModes({ agentDir: dir }), {
    available: false,
    modes: [],
    defaultModeId: null,
  });
});

test("an installed extension without a config file reports the stock modes", (t) => {
  const dir = agentDir(t);
  installPackage(dir);
  const modes = readPiPermissionModes({ agentDir: dir });
  assert.equal(modes.available, true);
  assert.deepEqual(modes.modes.map((mode) => mode.id), ["default", "plan", "build", "yolo"]);
  assert.equal(modes.defaultModeId, "default");
});

test("settings.json packages also mark the extension as installed; the config is merged in", (t) => {
  const dir = agentDir(t);
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({ packages: ["npm:pi-web-access", "npm:pi-permission-modes@2.7.2"] }),
  );
  writeConfig(dir, {
    defaultMode: "build",
    cycleOrder: ["default", "build", "yolo"],
    modes: { default: { label: "Default" }, build: { label: "Build" }, yolo: { label: "YOLO" } },
  });
  const modes = readPiPermissionModes({ agentDir: dir });
  assert.equal(modes.available, true);
  assert.deepEqual(modes.modes.map((mode) => mode.id), ["default", "build", "yolo", "plan"]);
  assert.equal(modes.defaultModeId, "build");
});

test("a corrupt config degrades to the stock modes instead of failing", (t) => {
  const dir = agentDir(t);
  installPackage(dir);
  mkdirSync(join(dir, "permission-mode"), { recursive: true });
  writeFileSync(join(dir, "permission-mode", "permission-mode.json"), "{ not json");
  const modes = readPiPermissionModes({ agentDir: dir });
  assert.equal(modes.available, true);
  assert.deepEqual(modes.modes.map((mode) => mode.id), ["default", "plan", "build", "yolo"]);
});

test("the agent directory follows PI_CODING_AGENT_DIR like Paseo's pi provider", () => {
  assert.equal(resolvePiAgentDir({}), join(homedir(), ".pi", "agent"));
  assert.equal(resolvePiAgentDir({ PI_CODING_AGENT_DIR: "~/pi-agent" }), join(homedir(), "pi-agent"));
  assert.equal(resolvePiAgentDir({ PI_CODING_AGENT_DIR: "/srv/pi" }), "/srv/pi");
});
