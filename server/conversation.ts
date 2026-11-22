import { imConversationKey } from "../shared/im-threads";
import { followsOf } from "../shared/execution";
import type { SuperagentState, Thread, Ticket, Trigger, TriggerOrigin } from "../shared/model";

export type ConversationRecords = Pick<SuperagentState, "threads" | "tickets" | "triggers" | "decisions">;

/** A daily IM thread shares a conversation with other days of the same identified bot and chat. */
export function sameConversation(first: Thread | undefined, second: Thread | undefined): boolean {
  if (!first || !second) return false;
  if (first.id === second.id) return true;
  const key = first.imConversationKey;
  if (!key || key !== second.imConversationKey) return false;
  try {
    const parts: unknown = JSON.parse(key);
    return Array.isArray(parts) && parts.length === 3 && parts.every((part) => typeof part === "string" && part.length > 0);
  } catch {
    return false;
  }
}

export function matchesConversation(thread: Thread | undefined, origin: TriggerOrigin): boolean {
  return Boolean(thread && thread.imConversationKey === imConversationKey(origin));
}

/** Existing generated text has no reliable conversation provenance. Keep it for the host. */
export function migrateConversationIsolation(state: SuperagentState): void {
  if (state.kv.conversationIsolation) return;
  for (const record of [...state.triggers, ...state.tickets, ...state.decisions, ...state.pendingActions, ...state.imDeliveries]) {
    record.preConversationIsolation = true;
  }
  for (const thread of state.threads) {
    if (thread.summary) thread.summaryHostOnly = true;
    if (thread.routerMemory) thread.routerMemoryHostOnly = true;
    if (thread.latestResult) thread.latestResult.preConversationIsolation = true;
  }
  state.kv.conversationIsolation = true;
}

export function ticketInConversation(state: SuperagentState, ticket: Ticket, threadId: string): boolean {
  return !ticket.preConversationIsolation && sameConversation(
    state.threads.find((thread) => thread.id === ticket.threadId),
    state.threads.find((thread) => thread.id === threadId),
  );
}

export function conversationFollows(state: SuperagentState, ticket: Ticket): string[] {
  return followsOf(ticket).filter((threadId) => ticketInConversation(state, ticket, threadId));
}

/** Project records before rendering a prompt, matching search terms, or expanding a reference. */
export function conversationView(state: SuperagentState, threadId: string): ConversationRecords {
  const current = state.threads.find((thread) => thread.id === threadId);
  const threads = state.threads.filter((thread) => sameConversation(current, thread));
  const threadIds = new Set(threads.map((thread) => thread.id));
  const tickets = state.tickets.filter((ticket) => threadIds.has(ticket.threadId) && !ticket.preConversationIsolation);
  const ticketIds = new Set(tickets.map((ticket) => ticket.id));
  const threadById = new Map(threads.map((thread) => [thread.id, thread]));
  const triggers: Trigger[] = [];
  for (const trigger of state.triggers) {
    const thread = threadById.get(trigger.threadId ?? "");
    if (!thread || (trigger.origin && !matchesConversation(thread, trigger.origin))) continue;
    const sourceTicket = trigger.workerRequest?.ticketId ?? (trigger.sender.startsWith("worker:") &&
      (trigger.kind === "report" || trigger.kind === "engine") ? trigger.sender.slice("worker:".length) : null);
    if (sourceTicket && !ticketIds.has(sourceTicket)) continue;
    if (!trigger.preConversationIsolation) {
      triggers.push(trigger);
    } else if (trigger.kind !== "report" && trigger.kind !== "engine") {
      // The ingress text is scoped. Notes and quotations may include generated output.
      triggers.push({ ...trigger, note: null, quote: null });
    }
  }
  return {
    threads: threads.map((thread) => ({
      ...thread,
      summary: thread.summaryHostOnly ? null : thread.summary,
      routerMemory: thread.routerMemoryHostOnly ? undefined : thread.routerMemory,
      latestResult: thread.latestResult?.preConversationIsolation ? null : thread.latestResult,
    })),
    triggers,
    tickets: tickets.map((ticket) => ({ ...ticket, follows: followsOf(ticket).filter((id) => threadIds.has(id)) })),
    decisions: state.decisions.filter((decision) => threadIds.has(decision.threadId)
      && (!decision.ticketId || ticketIds.has(decision.ticketId))
      && decision.outcome !== "watchdog" && !decision.preConversationIsolation),
  };
}
