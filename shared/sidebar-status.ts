import type { ExecutionAgent } from "./execution";
import type { SuperagentSnapshot } from "./model";

export type SidebarStatus = "running" | "done" | "needs_input" | "failed" | "idle" | "unknown";
export const SIDEBAR_STATUS_LABELS: Record<SidebarStatus, string> = {
  running: "运行中", done: "已完成", needs_input: "等待输入", failed: "异常", idle: "待命", unknown: "状态不可用",
};

/** Router 待命时仍需反映 Worker 的执行状态;最近结果不盖过当前运行或权限请求。 */
export function sidebarStatus(snapshot: SuperagentSnapshot | undefined, agents: (ExecutionAgent | null | undefined)[], unavailable = false): SidebarStatus {
  if (!snapshot || unavailable) return "unknown";
  const live = agents.filter((agent): agent is ExecutionAgent => Boolean(agent && !agent.archivedAt && agent.status !== "closed"));
  if (live.some((agent) => agent.pendingPermissions?.length || (agent.requiresAttention && agent.attentionReason === "permission"))) return "needs_input";
  if (live.some((agent) => agent.status === "error" || agent.providerUnavailable || (agent.requiresAttention && agent.attentionReason === "error"))) return "failed";
  if (snapshot.engine.evalInFlight || snapshot.threads.some((thread) => thread.pendingTriggers > 0)
    || snapshot.tickets.some((ticket) => ["pending", "launching", "running"].includes(ticket.status))
    || live.some((agent) => ["running", "initializing"].includes(agent.status))) return "running";
  if (snapshot.imDeliveries?.some((item) => item.status === "failed")) return "failed";
  if (snapshot.imDeliveries?.some((item) => item.status === "pending")) return "running";
  const latestResultAt = snapshot.recentResults?.[0]?.createdAt ?? "";
  if (snapshot.tickets.some((ticket) => ticket.status === "failed" && ticket.updatedAt >= latestResultAt)) return "failed";
  return latestResultAt ? "done" : "idle";
}
