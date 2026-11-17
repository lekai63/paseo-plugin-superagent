import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  normalizePiPermissionModes,
  PI_PERMISSION_MODES_PACKAGE,
  UNAVAILABLE_PI_PERMISSION_MODES,
  type PiPermissionModes,
} from "../shared/pi-modes";

/**
 * daemon 侧读取 pi-permission-modes 的安装状态与模式清单。
 * 路径与 Paseo 启动 pi 时一致:`PI_CODING_AGENT_DIR`(默认 `~/.pi/agent`)。
 */

/** pi 的 agent 目录;与 Paseo pi provider 的 resolvePiAgentDir 保持同一种解释。 */
export function resolvePiAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PI_CODING_AGENT_DIR?.trim();
  if (!configured) return join(homedir(), ".pi", "agent");
  if (configured === "~") return homedir();
  if (configured.startsWith("~/")) return resolve(homedir(), configured.slice(2));
  return resolve(configured);
}

export function piPermissionModesPath(agentDir: string): string {
  return join(agentDir, "permission-mode", "permission-mode.json");
}

function packageSource(entry: unknown): string {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object") {
    const source = (entry as { source?: unknown }).source;
    if (typeof source === "string") return source;
  }
  return "";
}

/**
 * pi 只加载 settings.json `packages` 里列出的 npm 包;包体落在 agent 目录的
 * npm/node_modules 下。两者任一命中即视为已安装(settings.json 缺失时看包体)。
 */
export function piPermissionModesInstalled(agentDir: string): boolean {
  try {
    const settings = JSON.parse(
      readFileSync(join(agentDir, "settings.json"), "utf8"),
    ) as { packages?: unknown };
    if (
      Array.isArray(settings.packages) &&
      settings.packages.some((entry) => packageSource(entry).includes(PI_PERMISSION_MODES_PACKAGE))
    ) {
      return true;
    }
  } catch {
    // 没有 settings.json 或无法解析:按包体判断。
  }
  return (
    existsSync(join(agentDir, "npm", "node_modules", PI_PERMISSION_MODES_PACKAGE, "package.json")) ||
    existsSync(join(agentDir, "node_modules", PI_PERMISSION_MODES_PACKAGE, "package.json"))
  );
}

const warnedConfigs = new Set<string>();

/**
 * 读取 Worker 模式候选。扩展未安装 → unavailable(设置页回退「Paseo 默认」);
 * 已安装但配置缺失/损坏 → 扩展自带的四个内置模式。
 */
export function readPiPermissionModes(options: { agentDir?: string } = {}): PiPermissionModes {
  const agentDir = options.agentDir ?? resolvePiAgentDir();
  if (!piPermissionModesInstalled(agentDir)) return { ...UNAVAILABLE_PI_PERMISSION_MODES };

  const path = piPermissionModesPath(agentDir);
  let config: unknown;
  try {
    config = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (existsSync(path) && !warnedConfigs.has(path)) {
      warnedConfigs.add(path);
      console.warn(`[superagent] could not read pi permission modes at ${path}; using stock modes`, error);
    }
    config = undefined;
  }
  return { available: true, ...normalizePiPermissionModes(config) };
}
