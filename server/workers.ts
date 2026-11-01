import type { PaseoApi } from "@getpaseo/client";
import type { SuperagentSettingsValues } from "../shared/settings";
import { slugify, truncate, type SuperagentState, type Ticket } from "../shared/model";
import { ROUTER_LABEL, ROUTER_LABEL_VALUE, TICKET_LABEL } from "./router";

/**
 * Worker 层:每个 Ticket 一个独立隔离的 Paseo agent。
 * worktree 隔离时每个 Ticket 一个独立工作区;parent 指向 Router,
 * 因此全部 Worker 出现在 Router 会话的 Subagents track 里,可随时人工介入。
 */

const WORKER_SYSTEM_PROMPT = [
  "You are a Worker agent executing one ticket of a super-agent orchestration layer.",
  "You execute inside your OWN isolated workspace; your current working directory is the",
  "authoritative copy of the repository for this ticket. Do the work described in the mandate.",
  "When the mandate names an absolute path from the base repository, that file means the SAME",
  "file inside YOUR working directory — never edit the original checkout outside it.",
  "When the work is done, your final message is the REPORT for the orchestrator:",
  "state what was done, key changes, verification (tests/commands run), and remaining risks.",
  "Keep the report under 300 words. If you are blocked, say precisely what you need.",
].join("\n");

/** Worker 首条 prompt:执行环境说明 + 任务书。 */
export function composeWorkerPrompt(
  ticket: Ticket,
  workingDir: string,
  isolation: "worktree" | "shared",
): string {
  const environment =
    isolation === "worktree"
      ? [
          `[Execution environment] You are in an ISOLATED worktree workspace: a fresh copy of the repository at ${workingDir}, on its own branch.`,
          `Your current working directory IS that copy. Absolute paths into ${workingDir} in the mandate refer to the same file INSIDE your working directory.`,
          `Do not edit the original checkout at ${workingDir}.`,
        ].join("\n")
      : `[Execution environment] You are working in the shared checkout at ${workingDir}. Coordinate with any concurrent work there.`;
  return `${environment}\n\n# Ticket: ${ticket.title}\n\n${ticket.mandate}`;
}

export interface WorkerLaunch {
  agentId: string;
  workspaceId: string | null;
}

/** 为 Ticket 启动 Worker:先建工作区(worktree/shared),再在其中创建 agent。 */
export async function launchWorker(
  paseo: PaseoApi,
  settings: SuperagentSettingsValues,
  state: SuperagentState,
  ticket: Ticket,
  routerAgentId: string | null,
): Promise<WorkerLaunch> {
  const provider = state.kv.workerProvider;
  if (!provider) throw new Error("worker provider is not configured");
  if (!settings.workingDir) throw new Error("working directory is not configured");

  const branchName = `superagent/${slugify(ticket.title, 24)}-${ticket.id.slice(-6)}`;
  const workspace =
    settings.workerIsolation === "worktree"
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

  try {
    const agent = await workspace.agents.create({
      config: {
        provider,
        systemPrompt: WORKER_SYSTEM_PROMPT,
      },
      title: ticket.title,
      prompt: composeWorkerPrompt(ticket, settings.workingDir, settings.workerIsolation),
      labels: { [TICKET_LABEL]: ticket.id },
      ...(routerAgentId ? { parent: routerAgentId } : {}),
    });
    return { agentId: agent.id, workspaceId: workspace.id };
  } catch (error) {
    // Agent 创建失败时还没有可落盘的 Worker ID,先回收已创建的工作区。
    try {
      await workspace.archive();
    } catch (cleanupError) {
      console.error("[superagent] failed launch workspace archive failed", cleanupError);
    }
    throw error;
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
