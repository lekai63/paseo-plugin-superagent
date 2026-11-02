import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { findInstructionFiles, inspectWorkingDir } from "../server/workdir.ts";

const probe = (isDirectory, isGitWorkTree) => ({
  isDirectory: async () => isDirectory,
  isGitWorkTree: async () => isGitWorkTree,
});

test("configuration problems are described with the directory", async () => {
  assert.match(await inspectWorkingDir("", "worktree", probe(true, true)), /not configured/);
  assert.match(await inspectWorkingDir("rel/dir", "worktree", probe(true, true)), /rel\/dir is not an absolute path/);
  assert.match(await inspectWorkingDir("/missing", "shared", probe(false, null)), /\/missing does not exist/);
});

test("worktree isolation needs a git work tree; shared isolation does not", async () => {
  assert.match(
    await inspectWorkingDir("/plain", "worktree", probe(true, false)),
    /\/plain is not a git repository, but workerIsolation=worktree/,
  );
  assert.equal(await inspectWorkingDir("/plain", "shared", probe(true, false)), null);
  assert.equal(await inspectWorkingDir("/repo", "worktree", probe(true, true)), null);
  // git 无法判定时不拦截,交给 daemon。
  assert.equal(await inspectWorkingDir("/repo", "worktree", probe(true, null)), null);
});

test("the default probe checks the real filesystem and git", async (t) => {
  const plain = await mkdtemp(join(tmpdir(), "superagent-workdir-"));
  t.after(() => rm(plain, { recursive: true, force: true }));
  assert.match(await inspectWorkingDir(plain, "worktree"), /is not a git repository/);
  assert.equal(await inspectWorkingDir(plain, "shared"), null);
  const repo = fileURLToPath(new URL("..", import.meta.url));
  assert.equal(await inspectWorkingDir(repo, "worktree"), null);
});

test("instruction files are found at the base directory root", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "superagent-instructions-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.deepEqual(await findInstructionFiles(dir), []);
  await writeFile(join(dir, "AGENTS.md"), "# rules\n");
  assert.deepEqual(await findInstructionFiles(dir), ["AGENTS.md"]);
  assert.deepEqual(await findInstructionFiles(""), []);
});
