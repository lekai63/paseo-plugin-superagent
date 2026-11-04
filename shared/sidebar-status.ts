import type { ExecutionAgent } from "./execution";
import type { Ticket } from "./model";

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

/** Router 状态点的五态;closed/归档不显示(返回 null)。 */
export type RouterMarkKind = "permission" | "error" | "running" | "finished" | "idle";
export interface RouterStatusMark {
  kind: RouterMarkKind;
  /** 处于该状态的 Router 会话数;仅 1 个时界面不显示数字。 */
  count: number;
}

/** 状态点的无障碍/悬浮文案,与设计里的五态一一对应。 */
export const routerStatusLabels: Record<RouterMarkKind, string> = {
  running: "运行中",
  finished: "运行完毕,等待查看",
  permission: "等待权限输入",
  error: "出错",
  idle: "空闲",
};

/** 多个 Router 会话并存(状态重置后残留)时取最需要关注的一种;优先级沿用宿主 agent 状态序。 */
const ROUTER_MARK_PRIORITY: Record<RouterMarkKind, number> = { permission: 0, error: 1, running: 2, finished: 3, idle: 4 };

function routerMarkKind(agent: ExecutionAgent): RouterMarkKind | null {
  if (agent.archivedAt || agent.status === "closed") return null;
  if (agent.pendingPermissions?.length || (agent.requiresAttention && agent.attentionReason === "permission")) return "permission";
  if (agent.status === "error" || agent.providerUnavailable
    || (agent.requiresAttention && agent.attentionReason === "error")) return "error";
  if (agent.status === "running" || agent.status === "initializing") return "running";
  // 其余 requiresAttention(finished 及未来新增原因)都按「运行完毕待查看」处理。
  if (agent.requiresAttention) return "finished";
  return "idle";
}

/**
 * 没有 Worker 在运行/待命时,侧栏行改显 Router 会话的状态点:
 * 蓝(旋转环)= 运行、绿 = 完成待查看、琥珀 = 等权限、红 = 出错、灰 = 空闲;
 * closed/归档/缺失的会话不显示。多个 Router 会话时按 ROUTER_MARK_PRIORITY
 * 取最紧急的状态,count 为处于该状态的会话数(1 个时界面不显示数字)。
 */
export function routerStatusMark(agents: ReadonlyArray<ExecutionAgent | null | undefined>): RouterStatusMark | null {
  const counts = new Map<RouterMarkKind, number>();
  for (const agent of agents) {
    if (!agent) continue;
    const kind = routerMarkKind(agent);
    if (kind) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  let winner: RouterMarkKind | null = null;
  for (const kind of counts.keys()) {
    if (winner === null || ROUTER_MARK_PRIORITY[kind] < ROUTER_MARK_PRIORITY[winner]) winner = kind;
  }
  return winner ? { kind: winner, count: counts.get(winner) ?? 1 } : null;
}
