import type { ExecutionAgent } from "./execution";
import type { SuperagentSnapshot, Ticket } from "./model";

export type SidebarStatus = "running" | "needs_input" | "failed" | "idle" | "unknown";
export const SIDEBAR_STATUS_LABELS: Record<SidebarStatus, string> = {
  running: "运行中", needs_input: "等待输入", failed: "异常", idle: "待命", unknown: "状态不可用",
};

/** 左侧图标只反映 Router,Worker 与 IM 投递不会改变它。 */
export function routerSidebarStatus(snapshot: SuperagentSnapshot | undefined, agent: ExecutionAgent | null | undefined, unavailable = false): SidebarStatus {
  if (!snapshot || unavailable) return "unknown";
  if (agent && !agent.archivedAt && agent.status !== "closed") {
    if (agent.pendingPermissions?.length || (agent.requiresAttention && agent.attentionReason === "permission")) return "needs_input";
    if (agent.status === "error" || agent.providerUnavailable || (agent.requiresAttention && agent.attentionReason === "error")) return "failed";
    if (["running", "initializing"].includes(agent.status)) return "running";
  }
  if (snapshot.engine.evalInFlight) return "running";
  if (snapshot.routerAgentId && (agent === null || agent?.archivedAt || agent?.status === "closed")) return "unknown";
  return "idle";
}

/** 按当前 Worker 会话计数,已清理的会话不累计为历史完成数量。 */
export function sidebarWorkerCounts(tickets: Ticket[], agents: Record<string, ExecutionAgent | null | undefined>) {
  const seen = new Set<string>();
  let running = 0, done = 0;
  for (const ticket of tickets) {
    const id = ticket.workerAgentId;
    if (!id || seen.has(id) || !["launching", "running", "waiting", "completed"].includes(ticket.status)) continue;
    seen.add(id);
    const agent = agents[id];
    if (agent === null || agent?.archivedAt || agent?.status === "closed" || agent?.status === "error" || agent?.providerUnavailable) continue;
    if (agent?.status === "idle") done++;
    else if (agent?.status === "running" || agent?.status === "initializing"
      || (!agent && ["launching", "running"].includes(ticket.status))) running++;
  }
  return { running, done };
}
