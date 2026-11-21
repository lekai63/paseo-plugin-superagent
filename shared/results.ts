import type { SuperagentState, Thread, ThreadResult } from "./model";

/** 旧状态没有 latestResult 时,从保留的裁决与汇报还原,无需迁移或重跑 Worker。 */
export function threadResult(thread: Thread, state: SuperagentState): ThreadResult | null {
  if (thread.latestResult) return thread.latestResult;
  const reports = state.triggers.filter((trigger) => trigger.threadId === thread.id && trigger.kind === "report")
    .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  const reply = state.decisions.filter((decision) => decision.threadId === thread.id && decision.outcome === "reply"
    && !decision.workerApprovalNotice && decision.reply?.trim())
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const report = reports[0];
  if (reply?.reply && (!report || reply.createdAt >= report.receivedAt)) {
    return { id: reply.id, kind: "router_reply", text: reply.reply, createdAt: reply.createdAt,
      ticketIds: reports.filter((trigger) => reply.triggerIds.includes(trigger.id))
        .map((trigger) => trigger.sender.slice("worker:".length)) };
  }
  const ticket = state.tickets.filter((item) => item.threadId === thread.id && item.report?.trim())
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  if (report) {
    const source = state.tickets.find((item) => item.id === report.sender.slice("worker:".length) && item.threadId === thread.id);
    return { id: report.id, kind: "worker_report", text: source?.report || report.text,
      createdAt: report.receivedAt, ticketIds: source ? [source.id] : [] };
  }
  return ticket?.report ? { id: `report:${ticket.id}`, kind: "worker_report", text: ticket.report,
    createdAt: ticket.updatedAt, ticketIds: [ticket.id] } : null;
}

export function recentResults(state: SuperagentState, threadId?: string) {
  return state.threads.filter((thread) => !threadId || thread.id === threadId).flatMap((thread) => {
    const result = threadResult(thread, state);
    return result ? [{ ...result, threadId: thread.id, title: thread.title,
      workspaceIds: [...new Set(state.tickets.filter((ticket) => ticket.threadId === thread.id && ticket.workspaceId)
        .map((ticket) => ticket.workspaceId!))] }] : [];
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5);
}
