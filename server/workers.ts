import { join } from "node:path";
import { bounded } from "./deadline";
import type { PaseoApi, PaseoWorkspaceHandle } from "@getpaseo/client";
import type { Ticket } from "../shared/model";
import { beijingDate, slugify, WATCHDOG_AGENT_LABEL_VALUE } from "../shared/model";
import { isPiProviderSelection, PI_PERMISSION_MODE_ENV } from "../shared/pi-modes";
import { ROUTER_LABEL, ROUTER_LABEL_VALUE, TICKET_LABEL } from "./router";

/**
 * Worker 层:每个 Ticket 一个独立隔离的 Paseo agent。
 * worktree 隔离时每个 Ticket 一个独立 worktree 工作区;shared 隔离时 Worker
 * 落在该目录的持久共享工作区里，Superagent 按 Ticket 展示并打开 Worker 会话。
 */

/**
 * Worker 角色与汇报要求。systemPrompt 之外也放进首条 prompt:ACP 系 provider 不会把
 * systemPrompt 交给模型,否则 Worker 不知道最终消息就是交给编排层的汇报。
 * 会话控制工具(退订/转回)只在 provider 支持 MCP 注入时存在,故注明"缺失时跳过"。
 */
const WORKER_ROLE = [
  "You are a Worker agent executing one ticket of a super-agent orchestration layer.",
  "Do the work described in the mandate.",
  "When the work is done, your final message is the REPORT for the orchestrator:",
  "state what was done, key changes, verification (tests/commands run), and remaining risks.",
  "The report's FIRST LINE must be one self-contained conclusion sentence: the verdict plus its",
  "key entities (paths, ids, commands) — only the beginning of the report reaches the Router as",
  "a stub, and that first line is what its keyword recall matches on.",
  "Keep the report under 300 words. If you are blocked, say precisely what you need.",
  "Permission requests and structured questions are forwarded to the Router, which can answer",
  "from existing authorization/context or relay them to the human. Wait for the response; do not",
  "repeat the request or treat an unrelated follow-up as approval.",
  "Follow-up messages may arrive while you work. One prefixed \"[thread thr_…]\" comes from another",
  "conversation the Router asked you to follow as well; your report reaches that conversation too.",
  "Your session may provide two orchestration tools (skip them if they are absent):",
  "- superagent_unsubscribe — stop routing future follow-up messages directly to you; the Router",
  "  evaluates them instead. Call it when later messages are no longer yours to answer (for",
  "  example a one-shot task once its report is delivered). Pass `threadId` to leave only one",
  "  followed conversation.",
  "- superagent_handback — return a message you received to the Router because it belongs",
  "  elsewhere (off-topic for your ticket, another worker's domain, or needs a human-facing",
  "  reply); quote or summarize it in `text` and set `unsubscribe` to also stop future",
  "  direct deliveries. After a handback, continue with your own ticket.",
];

const WORKER_SYSTEM_PROMPT = [
  ...WORKER_ROLE,
  "You execute inside your OWN isolated workspace; your current working directory is the",
  "authoritative copy of the repository for this ticket.",
  "When the mandate names an absolute path from the base repository, that file means the SAME",
  "file inside YOUR working directory — never edit the original checkout outside it.",
].join("\n");

/**
 * shared 隔离下每个 Ticket 的兜底子目录:`<workingDir>/tasks/<YYYYMMDD>-<标题>-<id 尾号>`
 * (Ticket 创建时的北京时间日期,与 daemon 主机时区无关)。
 * 由插件确定(Router 派发时还不知道 Ticket id),在 Worker 首条 prompt 里明确告知。
 * 工作目录自带 AGENTS.md/CLAUDE.md 时,以其归档规则为准,本目录仅在规则未覆盖时使用。
 */
export function taskDirectory(workingDir: string, ticket: Pick<Ticket, "id" | "title" | "createdAt">): string {
  const date = beijingDate(new Date(ticket.createdAt || Date.now())).replace(/-/g, "");
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

/**
 * 投机执行(§3.4)说明:没人提出的后台试探,静默完成;汇报首行以 DELIVER:/DISCARD: 开头,
 * DISCARD 由引擎静默丢弃,DELIVER 才交 Router 转述。
 */
const SPECULATIVE_NOTICE = [
  "[Speculative background attempt]",
  "Nobody asked for this ticket: the orchestrator started it on its own initiative to save the humans",
  "time. Work silently — do not message, mention, or notify anyone, and do not push, open pull",
  "requests, or change shared systems unless the mandate explicitly allows it; keep changes inside your",
  "workspace. Your report's FIRST LINE must start with exactly one of:",
  "  DELIVER: <conclusion> — you confirmed the problem/opportunity and have a simple, verified result",
  "           worth a human's attention (say where the fix or output is);",
  "  DISCARD: <reason> — you could not confirm it, found no simple result, or it is not worth",
  "           interrupting anyone. Discarded results are dropped silently.",
  "When in doubt, DISCARD.",
].join("\n");

/** Worker 首条 prompt:角色与汇报要求 + 执行环境说明 + 任务书。 */
export function composeWorkerPrompt(
  ticket: Pick<Ticket, "id" | "title" | "mandate" | "createdAt"> & { speculative?: boolean | null },
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
  const speculative = ticket.speculative ? `\n\n${SPECULATIVE_NOTICE}` : "";
  return `${role}\n\n${environment}${speculative}\n\n# Ticket: ${ticket.title}\n\n${ticket.mandate}`;
}

export interface WorkerLaunch {
  agentId: string;
  workspaceId: string | null;
  /** worktree 隔离的 Worker 实际分支名(创建后读回);shared 隔离没有分支。 */
  branchName: string | null;
  /** Ticket 是否独占该工作区:worktree = true;shared 的持久工作区 = false,回收时不得归档。 */
  ownsWorkspace: boolean;
}

/** Ticket 的执行环境:引擎按档位解析基础目录后传入,launchWorker 不再读全局设置。 */
export interface WorkerLaunchEnv {
  /**
   * 显式选择的模式;省略时由 Paseo 决定。其它 provider 走创建参数的 `modeId`;
   * pi 家族走 pi-permission-modes 的 `PI_PERMISSION_MODE` 环境变量。
   */
  modeId?: string;
  /** 显式选择的 thinking 档位;省略时回落 provider 默认(如 pi 的 defaultThinkingLevel)。 */
  thinkingOptionId?: string;
  /** 该 Ticket 的基础目录(档位专属目录已覆盖全局 workingDir)。 */
  workingDir: string;
  isolation: "worktree" | "shared";
  /** 基础目录根下的项目说明文件(shared 隔离时其归档规则优先)。 */
  instructionFiles: string[];
  /** shared 隔离时 Worker 落座的持久共享工作区;worktree 隔离为 null。 */
  sharedWorkspace: PaseoWorkspaceHandle | null;
  /**
   * 建成后台 agent(Paseo 0.16):不进标签页、默认列表、父会话的 Subagents 轨道与通知,
   * 仍可按 id 打开;worktree 隔离时 Ticket 独占的工作区一并建成后台工作区。
   * 总是显式传给 daemon:省略时子 agent 会继承父会话(Router)自身的后台标志。
   */
  background: boolean;
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
 * 为 Ticket 启动 Worker:worktree 隔离先建 Ticket 专属工作区;shared 隔离直接在
 * 该目录的共享工作区里建 agent。provider 由引擎按 Ticket 的档位解析后传入
 * (不同 Ticket 可以跑在不同模型上)。
 */
export async function launchWorker(
  paseo: PaseoApi,
  provider: string,
  ticket: Ticket,
  env: WorkerLaunchEnv,
): Promise<WorkerLaunch> {
  if (!provider) throw new Error("worker provider is not configured");
  if (!env.workingDir) throw new Error("working directory is not configured");

  const branchName =
    env.isolation === "worktree"
      ? `superagent/${slugify(ticket.title, 24)}-${ticket.id.slice(-6)}`
      : null;
  let workspace: WorkspaceHandle;
  let ownsWorkspace: boolean;
  try {
    if (env.isolation === "worktree" && branchName) {
      workspace = await paseo.workspaces.create({
        title: ticket.title,
        background: env.background,
        source: {
          kind: "worktree",
          cwd: env.workingDir,
          action: "branch-off",
          branchName,
        },
      });
      ownsWorkspace = true;
    } else if (env.sharedWorkspace) {
      workspace = env.sharedWorkspace;
      ownsWorkspace = false;
    } else {
      throw new Error("shared isolation requires a shared workspace");
    }
  } catch (error) {
    // daemon 的报错不带路径(如 "Create worktree requires a git repository"),补上基础目录与隔离方式。
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `worker workspace creation failed (base ${env.workingDir}, isolation ${env.isolation}): ${message}`,
      { cause: error },
    );
  }

  try {
    // pi 的可选模式来自 pi-permission-modes 扩展,不是 Paseo 的 modeId(pi provider
    // 不上报模式,传 modeId 会被创建参数校验直接拒绝):经扩展自己读取的
    // PI_PERMISSION_MODE 环境变量传入,随 launchEnv 在恢复会话时沿用。
    const piMode = isPiProviderSelection(provider) ? env.modeId : undefined;
    const agent = await workspace.agents.create({
      config: {
        provider,
        ...(env.modeId && !piMode ? { modeId: env.modeId } : {}),
        ...(env.thinkingOptionId ? { thinkingOptionId: env.thinkingOptionId } : {}),
        systemPrompt: WORKER_SYSTEM_PROMPT,
      },
      ...(piMode ? { env: { [PI_PERMISSION_MODE_ENV]: piMode } } : {}),
      title: ticket.title,
      prompt: composeWorkerPrompt(ticket, env.workingDir, env.isolation, env.instructionFiles),
      labels: { [TICKET_LABEL]: ticket.id },
      background: env.background,
    });
    const actualBranch = branchName ? await resolveActualBranch(workspace, branchName) : null;
    return { agentId: agent.id, workspaceId: workspace.id, branchName: actualBranch, ownsWorkspace };
  } catch (error) {
    // Agent 创建失败时还没有可落盘的 Worker ID;Ticket 专属的工作区先回收,共享工作区保留。
    if (ownsWorkspace) {
      try {
        await workspace.archive();
      } catch (cleanupError) {
        console.error("[superagent] failed launch workspace archive failed", cleanupError);
      }
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
      // 原文留给人查看;Router 的上下文预算在 enqueueReport/composeEvalPrompt 中控制。
      if (text) return text;
    }
    return null;
  } catch (error) {
    console.error("[superagent] harvest report failed", error);
    return null;
  }
}

/** 停掉一个 Worker(soft):归档 agent;仅 Ticket 独占的工作区(worktree)一并归档。 */
export async function retireWorker(
  paseo: PaseoApi,
  ticket: Ticket,
  includeWorkspace: boolean,
): Promise<void> {
  if (ticket.workerAgentId) {
    try {
      const agentId = ticket.workerAgentId;
      await bounded(() => paseo.agents.ref(agentId).archive(), "Worker archive");
    } catch (error) {
      console.error("[superagent] worker archive failed", error);
    }
  }
  // 共享工作区(默认 workspace / 档位工作区)由多个 Ticket 共用,永不归档。
  if (includeWorkspace && ticket.workspaceId && ticket.ownsWorkspace) {
    try {
      const workspaceId = ticket.workspaceId;
      await bounded(() => paseo.workspaces.ref(workspaceId).archive(), "Worker workspace archive");
    } catch (error) {
      console.error("[superagent] workspace archive failed", error);
    }
  }
}

/** 编排自身 agent 的标签判断(Router/看门狗/Worker;避免再注入派发工具)。 */
export function isOrchestrationAgent(labels: Record<string, string> | undefined): boolean {
  if (!labels) return false;
  return labels[ROUTER_LABEL] === ROUTER_LABEL_VALUE || labels[ROUTER_LABEL] === WATCHDOG_AGENT_LABEL_VALUE
    || Boolean(labels[TICKET_LABEL]);
}
