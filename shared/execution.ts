import type { Ticket } from "./model";
import { SUBSCRIBED_STATUSES } from "./model";
import type { Translate } from "./i18n";
import type { StatusLabel } from "./labels";

/** Ticket 额外订阅的线程(旧状态与测试替身可能没有该字段)。 */
export function followsOf(ticket: Pick<Ticket, "follows">): string[] {
  return ticket.follows ?? [];
}

/** Ticket 是否订阅了某个线程:本线程看 subscribed,其他线程看 follows(多对多)。 */
export function subscribesTo(ticket: Pick<Ticket, "threadId" | "subscribed" | "follows">, threadId: string): boolean {
  return ticket.threadId === threadId ? ticket.subscribed : followsOf(ticket).includes(threadId);
}

/**
 * 直通目标:全部仍有会话的活跃订阅票。≥1 即 fan-out 直通(每个订阅 Worker 都收到),
 * 一个都没有(无订阅,或订阅尚无会话)才交 Router 评估;引擎与追加输入框共用此判定。
 * 给出 threadId 时按该线程判定订阅(含跟随该线程的其他线程票据)。
 */
export function directTickets(tickets: readonly Ticket[], threadId?: string): Ticket[] {
  return tickets.filter((ticket) => (threadId ? subscribesTo(ticket, threadId) : ticket.subscribed)
    && SUBSCRIBED_STATUSES.includes(ticket.status) && ticket.workerAgentId);
}

/** 仅描述会话,不从 idle 推断 Ticket 完成。 */
export interface ExecutionAgent {
  id: string;
  status: string;
  model?: string | null;
  provider?: string;
  workspaceId?: string | null;
  archivedAt?: string | null;
  providerUnavailable?: boolean;
  requiresAttention?: boolean;
  attentionReason?: string | null;
  pendingPermissions?: readonly unknown[];
  lastError?: string | null;
}

export function agentStatus(agent: ExecutionAgent | null | undefined, t: Translate): StatusLabel {
  if (!agent) return { label: t("labels.agentStatus.missing"), tone: "muted" };
  if (agent.archivedAt || agent.status === "closed") return { label: t("labels.agentStatus.closed"), tone: "muted" };
  if (agent.pendingPermissions?.length || (agent.requiresAttention && agent.attentionReason === "permission")) {
    return { label: t("labels.agentStatus.permission"), tone: "warning" };
  }
  if (agent.status === "error" || (agent.requiresAttention && agent.attentionReason === "error")) {
    return { label: t("labels.agentStatus.error"), tone: "danger" };
  }
  if (agent.providerUnavailable) return { label: t("labels.agentStatus.providerUnavailable"), tone: "danger" };
  if (agent.status === "running") return { label: t("labels.agentStatus.running"), tone: "warning" };
  if (agent.status === "initializing") return { label: t("labels.agentStatus.initializing"), tone: "warning" };
  return { label: t("labels.agentStatus.idle"), tone: "muted" };
}

/** 调用图只保留当前工作;终态任务及其消息由历史页面承载。 */
export function currentTickets(tickets: readonly Ticket[]): Ticket[] {
  return tickets.filter((ticket) => ["pending", "launching", "running", "waiting"].includes(ticket.status));
}

/** 权限、错误最先展示,随后是启动/执行、排队、待命、完成;同类保持稳定顺序。 */
export function ticketPriority(ticket: Ticket, agent?: ExecutionAgent | null): number {
  const attention = agent && !agent.archivedAt && agent.status !== "closed" && (
    agent.pendingPermissions?.length || agent.status === "error" || agent.providerUnavailable
    || (agent.requiresAttention && (agent.attentionReason === "permission" || agent.attentionReason === "error"))
  );
  if (ticket.status === "failed" || attention) return 0;
  if (ticket.status === "running" || ticket.status === "launching") return 1;
  if (ticket.status === "pending") return 2;
  if (ticket.status === "waiting") return 3;
  return 4;
}

export function elapsedTime(startedAt: string, t: Translate, now = Date.now()): string {
  const elapsed = now - Date.parse(startedAt);
  if (!Number.isFinite(elapsed)) return "";
  const seconds = Math.max(0, Math.floor(elapsed / 1000));
  if (seconds < 60) return t("labels.time.elapsedSeconds", { count: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t("labels.time.elapsedMinutes", { count: minutes });
  return t("labels.time.elapsedHours", { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
}
