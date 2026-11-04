import type { Decision, Ticket, Trigger } from "./model";
import { outcomeLabel, triggerKindLabel, triggerSenderLabel, type Tone } from "./labels";

/**
 * 把一个线程的触发与裁决排成对话:人发的消息是右侧气泡,Router 的答复是正文,
 * 派发、汇报、转向等编排动作是可展开的紧凑行(对应 Paseo 会话里的工具调用行)。
 * 纯函数,client 渲染与测试共用。
 */

export type ChatEntry =
  | {
      kind: "user";
      id: string;
      at: string;
      text: string;
      /** 非本人手动发送时的来源(IM 昵称、委派的 agent);手动发送为空。 */
      source: string | null;
      status: Trigger["status"];
      note: string | null;
    }
  | { kind: "reply"; id: string; at: string; text: string }
  | {
      kind: "event";
      id: string;
      at: string;
      icon: string;
      tone: Tone;
      label: string;
      /** 行内的次要说明,通常是 Ticket 标题。 */
      detail: string | null;
      /** 展开后显示的正文;为空时这一行不可展开。 */
      text: string | null;
      markdown: boolean;
      ticketId: string | null;
      /** 派发行跟随 Ticket 的实时状态,并可打开 Worker 会话。 */
      live: boolean;
    };

const USER_KINDS: readonly Trigger["kind"][] = ["manual", "agent", "feishu", "qq", "dingtalk", "wecom"];

const DECISION_ICONS: Record<Decision["outcome"], string> = {
  dispatch: "Bot",
  steer: "CornerDownRight",
  cancel: "CircleSlash",
  retry: "RotateCcw",
  reply: "MessageSquare",
  ignore: "EyeOff",
  stop: "OctagonX",
  unparsed: "CircleAlert",
  error: "CircleAlert",
};

const DECISION_LABELS: Partial<Record<Decision["outcome"], string>> = {
  dispatch: "派发 Worker",
  steer: "转向 Worker",
  cancel: "取消任务",
  retry: "重试任务",
  ignore: "Router 忽略了这条消息",
  stop: "Router 结束了线程",
  unparsed: "Router 的裁决无法解析",
  error: "Router 评估出错",
};

const DECISION_TONES: Partial<Record<Decision["outcome"], Tone>> = {
  cancel: "warning",
  stop: "warning",
  unparsed: "danger",
  error: "danger",
};

/** 引擎写入的汇报触发带英文前缀与截断;能找到 Ticket 时用其完整汇报。 */
function reportText(trigger: Trigger, ticket: Ticket | undefined): string {
  if (ticket?.report?.trim()) return ticket.report;
  return trigger.text.replace(/^Worker report for "[^\n]*":\n/, "");
}

function userSource(trigger: Trigger): string | null {
  if (trigger.kind === "manual") return null;
  const sender = triggerSenderLabel(trigger);
  if (trigger.kind === "agent") return sender ? `${sender} 委派` : "Agent 委派";
  return [triggerKindLabel(trigger.kind), sender].filter(Boolean).join(" · ");
}

export function buildChatEntries(triggers: readonly Trigger[], decisions: readonly Decision[], tickets: readonly Ticket[]): ChatEntry[] {
  const ticketById = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  const entries: ChatEntry[] = [];
  for (const trigger of triggers) {
    if (USER_KINDS.includes(trigger.kind)) {
      entries.push({ kind: "user", id: trigger.id, at: trigger.receivedAt, text: trigger.text,
        source: userSource(trigger), status: trigger.status, note: trigger.note ?? null });
    } else if (trigger.kind === "report") {
      const ticketId = trigger.sender.startsWith("worker:") ? trigger.sender.slice("worker:".length) : null;
      const ticket = ticketId ? ticketById.get(ticketId) : undefined;
      entries.push({ kind: "event", id: trigger.id, at: trigger.receivedAt, icon: "FileCheck", tone: "default",
        label: "Worker 汇报", detail: ticket?.title ?? null, text: reportText(trigger, ticket), markdown: true,
        ticketId: ticket ? ticket.id : null, live: false });
    } else {
      entries.push({ kind: "event", id: trigger.id, at: trigger.receivedAt, icon: "Cog",
        tone: trigger.status === "failed" ? "danger" : "warning", label: triggerKindLabel(trigger.kind),
        detail: trigger.note ?? null, text: trigger.text, markdown: false, ticketId: null, live: false });
    }
  }
  for (const decision of decisions) {
    if (decision.outcome === "reply") {
      if (decision.reply?.trim()) entries.push({ kind: "reply", id: decision.id, at: decision.createdAt, text: decision.reply });
      continue;
    }
    const ticket = decision.ticketId ? ticketById.get(decision.ticketId) : undefined;
    const profile = decision.outcome === "dispatch" && ticket?.profile ? ` · ${ticket.profile}` : "";
    const text = decision.outcome === "unparsed" ? decision.raw ?? decision.rationale ?? null : decision.rationale ?? null;
    entries.push({
      kind: "event",
      id: decision.id,
      at: decision.createdAt,
      icon: DECISION_ICONS[decision.outcome],
      tone: DECISION_TONES[decision.outcome] ?? "default",
      label: DECISION_LABELS[decision.outcome] ?? `Router ${outcomeLabel(decision.outcome)}`,
      detail: ticket ? `${ticket.title}${profile}` : null,
      text: text?.trim() ? text : null,
      markdown: false,
      ticketId: decision.ticketId ?? null,
      live: decision.outcome === "dispatch" && Boolean(ticket),
    });
  }
  // 时间正序;同一时刻保持触发在前、裁决按写入顺序(稳定排序)。
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => a.entry.at.localeCompare(b.entry.at) || a.index - b.index)
    .map(({ entry }) => entry);
}

/** 气泡下方的投递状态;已评估是常态,不额外提示。 */
export function userStatusLabel(entry: Extract<ChatEntry, { kind: "user" }>): { label: string; tone: Tone } | null {
  switch (entry.status) {
    case "pending":
      return { label: "等待 Router", tone: "warning" };
    case "delivered":
      return { label: "已直通 Worker", tone: "muted" };
    case "filtered":
      return { label: entry.note ? `已过滤 · ${entry.note}` : "已过滤", tone: "muted" };
    case "failed":
      return { label: entry.note ? `失败 · ${entry.note}` : "失败", tone: "danger" };
    default:
      return null;
  }
}
