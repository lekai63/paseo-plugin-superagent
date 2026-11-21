import type { ExecutionAgent } from "./execution";
import type { Translate } from "./i18n";
import type { SuperagentSnapshot, Ticket } from "./model";

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

export interface RouterStatusMark {
  kind: "error" | "running";
  count: number;
}

export function routerStatusLabel(kind: RouterStatusMark["kind"], t: Translate): string {
  return t(`labels.routerMark.${kind}`);
}

export function routerStatusMark(snapshot: Pick<SuperagentSnapshot, "engine" | "threads"> | undefined): RouterStatusMark | null {
  if (!snapshot) return null;
  if (snapshot.engine.evalInFlight) return { kind: "running", count: 1 };
  const count = snapshot.threads.filter((thread) => thread.state === "active" && (thread.pendingTriggers ?? 0) > 0 &&
    (thread.lastDecision?.outcome === "error" || thread.lastDecision?.outcome === "unparsed")).length;
  return count > 0 ? { kind: "error", count } : null;
}
