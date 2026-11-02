import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

/**
 * Worker 基础目录(settings.workingDir)的可用性检查。
 *
 * worktree 隔离要求它位于 git 工作树内(与 daemon 的 "Create worktree requires a git
 * repository" 判定一致);否则每次派发都会在建工作区一步失败。提前检查并把目录与隔离方式
 * 写进错误,Router 与配置卡都能看到确切原因,而不是只拿到一句不带路径的 daemon 报错。
 */

export type WorkerIsolation = "worktree" | "shared";

export interface WorkingDirProbe {
  isDirectory(path: string): Promise<boolean>;
  isFile(path: string): Promise<boolean>;
  /** true/false = 是否在 git 工作树内;null = 无法判定(如找不到 git)。 */
  isGitWorkTree(path: string): Promise<boolean | null>;
}

export const nodeWorkingDirProbe: WorkingDirProbe = {
  async isDirectory(path) {
    try {
      return (await stat(path)).isDirectory();
    } catch {
      return false;
    }
  },
  async isFile(path) {
    try {
      return (await stat(path)).isFile();
    } catch {
      return false;
    }
  },
  isGitWorkTree(path) {
    return new Promise((resolve) => {
      execFile(
        "git",
        ["-C", path, "rev-parse", "--is-inside-work-tree"],
        { timeout: 10_000 },
        (error, stdout) => {
          if (!error) return resolve(stdout.trim() === "true");
          const code = (error as NodeJS.ErrnoException).code;
          // 找不到 git / 超时等无法判定时不拦截,交给 daemon 自己报错。
          if (code === "ENOENT" || error.killed) return resolve(null);
          resolve(false);
        },
      );
    });
  },
};

/** 返回人类可读的问题描述;目录可用时返回 null。 */
export async function inspectWorkingDir(
  workingDir: string,
  isolation: WorkerIsolation,
  probe: WorkingDirProbe = nodeWorkingDirProbe,
): Promise<string | null> {
  if (!workingDir) return "worker working directory is not configured";
  if (!isAbsolute(workingDir)) return `worker working directory ${workingDir} is not an absolute path`;
  if (!(await probe.isDirectory(workingDir))) {
    return `worker working directory ${workingDir} does not exist or is not a directory`;
  }
  if (isolation === "worktree" && (await probe.isGitWorkTree(workingDir)) === false) {
    return (
      `worker working directory ${workingDir} is not a git repository, but workerIsolation=worktree ` +
      "needs one to create per-ticket worktrees; point the working directory at a git repository " +
      "or switch Worker isolation to shared"
    );
  }
  return null;
}

/** 工作目录自带的项目说明文件(agent 会自动加载;其中可能规定产出的归档位置)。 */
export const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"] as const;

/** 返回 workingDir 根下存在的项目说明文件名(按 INSTRUCTION_FILES 顺序)。 */
export async function findInstructionFiles(
  workingDir: string,
  probe: WorkingDirProbe = nodeWorkingDirProbe,
): Promise<string[]> {
  if (!workingDir) return [];
  const found: string[] = [];
  for (const name of INSTRUCTION_FILES) {
    if (await probe.isFile(join(workingDir, name))) found.push(name);
  }
  return found;
}
