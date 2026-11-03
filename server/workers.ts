import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { SuperagentSettingsValues } from "../shared/settings";
import { slugify, truncate, type Ticket } from "../shared/model";
import { ROUTER_LABEL, ROUTER_LABEL_VALUE, TICKET_LABEL } from "./router";

/**
 * Worker 层:每个 Ticket 一个独立隔离的 Paseo agent。
 * worktree 隔离时每个 Ticket 一个独立工作区;parent 指向 Router,
 * 因此全部 Worker 出现在 Router 会话的 Subagents track 里,可随时人工介入。
 */

/**
 * Worker 角色与汇报要求。systemPrompt 之外也放进首条 prompt:ACP 系 provider 不会把
 * systemPrompt 交给模型,否则 Worker 不知道最终消息就是交给编排层的汇报。
 */
const WORKER_ROLE = [
  "You are a Worker agent executing one ticket of a super-agent orchestration layer.",
  "Do the work described in the mandate.",
  "When the work is done, your final message is the REPORT for the orchestrator:",
  "state what was done, key changes, verification (tests/commands run), and remaining risks.",
  "Keep the report under 300 words. If you are blocked, say precisely what you need.",
];

const WORKER_SYSTEM_PROMPT = [
  ...WORKER_ROLE,
  "You execute inside your OWN isolated workspace; your current working directory is the",
  "authoritative copy of the repository for this ticket.",
  "When the mandate names an absolute path from the base repository, that file means the SAME",
  "file inside YOUR working directory — never edit the original checkout outside it.",
].join("\n");

/**
 * shared 隔离下每个 Ticket 的兜底子目录:`<workingDir>/tasks/<YYYYMMDD>-<标题>-<id 尾号>`(本地日期)。
 * 由插件确定(Router 派发时还不知道 Ticket id),在 Worker 首条 prompt 里明确告知。
 * 工作目录自带 AGENTS.md/CLAUDE.md 时,以其归档规则为准,本目录仅在规则未覆盖时使用。
 */
export function taskDirectory(workingDir: string, ticket: Pick<Ticket, "id" | "title" | "createdAt">): string {
  const created = new Date(ticket.createdAt || Date.now());
  const pad = (value: number) => String(value).padStart(2, "0");
  const date = `${created.getFullYear()}${pad(created.getMonth() + 1)}${pad(created.getDate())}`;
  return join(workingDir, "tasks", `${date}-${slugify(ticket.title, 24)}-${ticket.id.slice(-6)}`);
}

/** shared 隔离的执行环境说明:目录自带项目说明时优先遵循其归档规则,否则用 Ticket 专属目录。 */
function sharedEnvironment(
  ticket: Pick<Ticket, "id" | "title" | "createdAt">,
  workingDir: string,
  instructionFiles: string[],
): string {
  const taskDir = taskDirectory(workingDir, ticket);
  const lines = [
    `[Execution environment] You are working in the shared directory ${workingDir}; other workers use it concurrently.`,
  ];
  if (instructionFiles.length > 0) {
    const files = instructionFiles.map((name) => join(workingDir, name)).join(", ");
    lines.push(
      `This directory has its own project instructions: ${files}. Read them if they are not already in your context.`,
      "Their rules on where outputs go take priority: file everything you create, download or generate the way they prescribe, and make any index or registry updates they require.",
      `Only if they do not say where this ticket's outputs belong, use ${taskDir} (create it if it does not exist).`,
      "Do not modify unrelated existing files.",
    );
  } else {
    lines.push(
      `Your task directory is ${taskDir} — create it if it does not exist and put every file you create, download or generate for this ticket inside it.`,
      "You may read anything you need elsewhere, but only modify files outside your task directory when the mandate explicitly names them.",
    );
  }
  lines.push("In your final report, state where you put the outputs.");
  return lines.join("\n");
}

/** Worker 首条 prompt:角色与汇报要求 + 执行环境说明 + 任务书。 */
export function composeWorkerPrompt(
  ticket: Pick<Ticket, "id" | "title" | "mandate" | "createdAt">,
  workingDir: string,
  isolation: "worktree" | "shared",
  instructionFiles: string[] = [],
): string {
  const environment =
    isolation === "worktree"
      ? [
          `[Execution environment] You are in an ISOLATED worktree workspace: a fresh copy of the repository at ${workingDir}, on its own branch.`,
          `Your current working directory IS that copy. Absolute paths into ${workingDir} in the mandate refer to the same file INSIDE your working directory.`,
          `Do not edit the original checkout at ${workingDir}.`,
        ].join("\n")
      : sharedEnvironment(ticket, workingDir, instructionFiles);
  const role = `[Worker instructions]\n${WORKER_ROLE.join("\n")}`;
  return `${role}\n\n${environment}\n\n# Ticket: ${ticket.title}\n\n${ticket.mandate}`;
}

export interface WorkerLaunch {
  agentId: string;
  workspaceId: string | null;
  /** worktree 隔离的 Worker 实际分支名(创建后读回);shared 隔离没有分支。 */
  branchName: string | null;
}

type WorkspaceHandle = Awaited<ReturnType<PaseoApi["workspaces"]["create"]>>;

/**
 * 读回工作区的实际分支:分支名冲突时 Paseo 会自动换名(resolveUniqueLocalBranchName),
 * 直接使用请求名会让 UI 与 Router 指向不存在的分支。descriptor 未带分支时退回请求名。
 */
async function resolveActualBranch(workspace: WorkspaceHandle, requested: string): Promise<string> {
  const read = (descriptor: Awaited<ReturnType<WorkspaceHandle["refresh"]>>): string | null =>
    descriptor?.gitRuntime?.currentBranch?.trim() || null;
  try {
    return read(workspace.current()) ?? read(await workspace.refresh()) ?? requested;
  } catch {
    return requested;
  }
}

/**
 * 为 Ticket 启动 Worker:先建工作区(worktree/shared),再在其中创建 agent。
 * provider 由引擎按 Ticket 的档位解析后传入(不同 Ticket 可以跑在不同模型上)。
 */
export async function launchWorker(
  paseo: PaseoApi,
  settings: SuperagentSettingsValues,
  provider: string,
  ticket: Ticket,
  routerAgentId: string | null,
  instructionFiles: string[] = [],
): Promise<WorkerLaunch> {
  if (!provider) throw new Error("worker provider is not configured");
  if (!settings.workingDir) throw new Error("working directory is not configured");

  const branchName =
    settings.workerIsolation === "worktree"
      ? `superagent/${slugify(ticket.title, 24)}-${ticket.id.slice(-6)}`
      : null;
  let workspace: WorkspaceHandle;
  try {
    workspace =
      settings.workerIsolation === "worktree" && branchName
        ? await paseo.workspaces.create({
            title: ticket.title,
            source: {
              kind: "worktree",
              cwd: settings.workingDir,
              action: "branch-off",
              branchName,
            },
          })
        : await paseo.workspaces.create({
            title: ticket.title,
            source: { kind: "directory", path: settings.workingDir },
          });
  } catch (error) {
    // daemon 的报错不带路径(如 "Create worktree requires a git repository"),补上基础目录与隔离方式。
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `worker workspace creation failed (base ${settings.workingDir}, isolation ${settings.workerIsolation}): ${message}`,
      { cause: error },
    );
  }

  try {
    const agent = await workspace.agents.create({
      config: {
        provider,
        systemPrompt: WORKER_SYSTEM_PROMPT,
      },
      title: ticket.title,
      prompt: composeWorkerPrompt(ticket, settings.workingDir, settings.workerIsolation, instructionFiles),
      labels: { [TICKET_LABEL]: ticket.id },
      ...(routerAgentId ? { parent: routerAgentId } : {}),
    });
    const actualBranch = branchName ? await resolveActualBranch(workspace, branchName) : null;
    return { agentId: agent.id, workspaceId: workspace.id, branchName: actualBranch };
  } catch (error) {
    // Agent 创建失败时还没有可落盘的 Worker ID,先回收已创建的工作区。
    try {
      await workspace.archive();
    } catch (cleanupError) {
      console.error("[superagent] failed launch workspace archive failed", cleanupError);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`worker agent creation failed (provider "${provider}"): ${message}`, { cause: error });
  }
}

/** 判定 Worker 当前轮次结果(由 engine 的 watcher/watchdog 调用)。 */
export interface WorkerSettlement {
  ok: boolean;
  report: string | null;
  error: string | null;
}

/** 从 Worker 时间线抓最终汇报:末尾最后一条 assistant 消息。 */
export async function harvestReport(paseo: PaseoApi, agentId: string): Promise<string | null> {
  try {
    const payload = await paseo.agents.ref(agentId).timeline.refetch({
      direction: "tail",
      limit: 60,
    });
    const messages = payload.entries
      .filter((entry) => entry.item.type === "assistant_message")
      .sort((a, b) => b.seqStart - a.seqStart);
    for (const entry of messages) {
      if (entry.item.type !== "assistant_message") continue;
      const text = entry.item.text?.trim();
      if (text) return truncate(text, 4000);
    }
    return null;
  } catch (error) {
    console.error("[superagent] harvest report failed", error);
    return null;
  }
}

/** 停掉一个 Worker(soft):归档 agent;worktree 工作区一并归档。 */
export async function retireWorker(
  paseo: PaseoApi,
  ticket: Ticket,
  includeWorkspace: boolean,
): Promise<void> {
  if (ticket.workerAgentId) {
    try {
      await paseo.agents.ref(ticket.workerAgentId).archive();
    } catch (error) {
      console.error("[superagent] worker archive failed", error);
    }
  }
  if (includeWorkspace && ticket.workspaceId) {
    try {
      await paseo.workspaces.ref(ticket.workspaceId).archive();
    } catch (error) {
      console.error("[superagent] workspace archive failed", error);
    }
  }
}

/** Router 标签判断(避免把本插件自己的 agent 再注入派发工具)。 */
export function isOrchestrationAgent(labels: Record<string, string> | undefined): boolean {
  if (!labels) return false;
  return labels[ROUTER_LABEL] === ROUTER_LABEL_VALUE || Boolean(labels[TICKET_LABEL]);
}
