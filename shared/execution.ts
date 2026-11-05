import type { Ticket } from "./model";
import { SUBSCRIBED_STATUSES } from "./model";
import type { StatusLabel } from "./labels";

/**
 * 直通目标:全部仍有会话的活跃订阅票。≥1 即 fan-out 直通(每个订阅 Worker 都收到),
 * 一个都没有(无订阅,或订阅尚无会话)才交 Router 评估;引擎与追加输入框共用此判定。
 */
export function directTickets(tickets: readonly Ticket[]): Ticket[] {
  return tickets.filter((ticket) => ticket.subscribed && SUBSCRIBED_STATUSES.includes(ticket.status) && ticket.workerAgentId);
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

export function agentStatus(agent: ExecutionAgent | null | undefined): StatusLabel {
  if (!agent) return { label: "会话不存在", tone: "muted" };
  if (agent.archivedAt || agent.status === "closed") return { label: "会话已关闭", tone: "muted" };
  if (agent.pendingPermissions?.length || (agent.requiresAttention && agent.attentionReason === "permission")) {
    return { label: "等待权限", tone: "warning" };
  }
  if (agent.status === "error" || (agent.requiresAttention && agent.attentionReason === "error")) {
    return { label: "会话异常", tone: "danger" };
  }
  if (agent.providerUnavailable) return { label: "Provider 不可用", tone: "danger" };
  if (agent.status === "running") return { label: "会话执行中", tone: "warning" };
  if (agent.status === "initializing") return { label: "会话初始化", tone: "warning" };
  return { label: "会话空闲", tone: "muted" };
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

export function elapsedTime(startedAt: string, now = Date.now()): string {
  const elapsed = now - Date.parse(startedAt);
  if (!Number.isFinite(elapsed)) return "";
  const seconds = Math.max(0, Math.floor(elapsed / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}
