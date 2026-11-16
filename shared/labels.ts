import type { Translate } from "./i18n";
import type { Decision, Ticket, Trigger } from "./model";

/** 展示层标签与状态推导(client/server 共用;纯函数无运行时依赖,文字经传入的 t 翻译)。 */

/** 状态色调:映射到宿主 theme 的 status token;default = 前景色,muted = 次要色。 */
export type Tone = "default" | "success" | "danger" | "warning" | "muted";

export interface StatusLabel {
  label: string;
  tone: Tone;
}

export function outcomeLabel(outcome: Decision["outcome"], t: Translate): string {
  return t(`labels.outcome.${outcome}`);
}

export function ticketStatusLabel(status: Ticket["status"], t: Translate): string {
  return t(`labels.ticketStatus.${status}`);
}

export function ticketStatusTone(status: Ticket["status"]): Tone {
  switch (status) {
    case "running":
    case "launching":
      return "warning";
    case "completed":
      return "success";
    case "failed":
      return "danger";
    default:
      return "muted";
  }
}

export function triggerKindLabel(kind: Trigger["kind"], t: Translate): string {
  return t(`labels.triggerKind.${kind}`);
}

/**
 * 触发者的可读名:IM 优先用昵称;`user`(界面手动)与 `worker:`(汇报)不重复显示,
 * 因为来源类型已经说明了一切。
 */
export function triggerSenderLabel(trigger: Pick<Trigger, "sender" | "origin">): string | null {
  const name = trigger.origin?.senderName?.trim();
  if (name) return name;
  const sender = trigger.sender;
  if (sender === "user" || sender === "agent" || sender.startsWith("worker:")) return null;
  if (sender.startsWith("agent:")) return `Agent ${sender.slice("agent:".length, "agent:".length + 8)}`;
  const colon = sender.indexOf(":");
  if (colon > 0 && ["feishu", "qq", "dingtalk", "wecom", "weixin"].includes(sender.slice(0, colon))) {
    return sender.slice(colon + 1);
  }
  return sender;
}

export const ACTIVE_TICKET_STATUSES: readonly Ticket["status"][] = ["launching", "running"];

/**
 * 线程的一句话状态(按"最需要知道的事"排序):
 * 已关闭 > 运行中 > 待评估 > 评估失败(比最近的 Ticket 更新) > 最近 Ticket 的状态 > 最近裁决。
 * tickets/decisions 只传本线程的,顺序不限。
 */
export function threadStatus(
  thread: { state: "active" | "closed"; pendingTriggers: number },
  tickets: readonly Pick<Ticket, "status" | "updatedAt">[],
  decisions: readonly Pick<Decision, "outcome" | "createdAt">[],
  t: Translate,
): StatusLabel {
  if (thread.state === "closed") return { label: t("labels.threadStatus.closed"), tone: "muted" };
  if (tickets.some((ticket) => ACTIVE_TICKET_STATUSES.includes(ticket.status))) return { label: t("labels.threadStatus.running"), tone: "warning" };
  if (thread.pendingTriggers > 0) return { label: t("labels.threadStatus.pendingEval"), tone: "warning" };

  const latestTicket = latestBy(tickets, (ticket) => ticket.updatedAt);
  const latestDecision = latestBy(decisions, (d) => d.createdAt);
  const decisionFailed = latestDecision && (latestDecision.outcome === "unparsed" || latestDecision.outcome === "error");
  if (decisionFailed && (!latestTicket || latestDecision.createdAt > latestTicket.updatedAt)) {
    return { label: t("labels.threadStatus.evalFailed"), tone: "danger" };
  }
  if (latestTicket) return { label: ticketStatusLabel(latestTicket.status, t), tone: ticketStatusTone(latestTicket.status) };
  switch (latestDecision?.outcome) {
    case "reply":
      return { label: t("labels.threadStatus.replied"), tone: "success" };
    case "ignore":
      return { label: t("labels.threadStatus.ignored"), tone: "muted" };
    case "stop":
      return { label: t("labels.threadStatus.stopped"), tone: "muted" };
    default:
      return { label: t("labels.threadStatus.idle"), tone: "muted" };
  }
}

function latestBy<T>(items: readonly T[], key: (item: T) => string): T | undefined {
  let best: T | undefined;
  for (const item of items) {
    if (!best || key(item) > key(best)) best = item;
  }
  return best;
}

/** 看门狗备注(引擎原文为英文 `reconciled N item(s)`)。 */
export function watchdogNoteLabel(note: string | null | undefined, t: Translate): string {
  if (!note) return t("labels.watchdogNote.allClear");
  const match = /reconciled (\d+)/.exec(note);
  return match ? t("labels.watchdogNote.reconciled", { count: Number(match[1]) }) : note;
}

/** LLM 巡检结论:引擎写入的固定英文说明按界面语言改写,模型给出的摘要原样显示。 */
export function patrolSummaryLabel(summary: string | null | undefined, t: Translate): string {
  if (!summary) return t("labels.patrolSummary.none");
  if (summary === "nothing to patrol") return t("labels.patrolSummary.nothingToPatrol");
  const parked = /^nothing to patrol: (\d+) parked waiting ticket/.exec(summary);
  if (parked) return t("labels.patrolSummary.parked", { count: Number(parked[1]) });
  if (summary.startsWith("skipped: the watchdog session is busy")) return t("labels.patrolSummary.busy");
  return summary;
}

/** 月日(中文「3月5日」,英文「Mar 5」);跨年时带年份。 */
function monthDayLabel(date: Date, withYear: boolean, t: Translate): string {
  const month = t(`labels.time.months.m${(date.getMonth() + 1) as MonthNumber}`);
  const monthDay = t("labels.time.monthDay", { month, day: date.getDate() });
  return withYear ? t("labels.time.withYear", { date: monthDay, year: date.getFullYear() }) : monthDay;
}

type MonthNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;

/** 相对时间:刚刚 / N 分钟前 / N 小时前 / N 天前 / M月D日(跨年带年份)。 */
export function relativeTime(iso: string | null | undefined, t: Translate, now: number = Date.now()): string {
  if (!iso) return "";
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "";
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 45) return t("labels.time.justNow");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t("labels.time.minutesAgo", { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t("labels.time.hoursAgo", { count: hours });
  const days = Math.round(hours / 24);
  if (days < 7) return t("labels.time.daysAgo", { count: days });
  const date = new Date(time);
  return monthDayLabel(date, date.getFullYear() !== new Date(now).getFullYear(), t);
}

/**
 * Markdown 的折叠预览:去掉标题井号、强调符、行内代码与围栏,保留列表与文字,
 * 让截断后的几行读起来是正文而不是语法。
 */
export function markdownPreview(text: string): string {
  return text
    .replace(/^```[^\n]*$/gm, "")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 时:分:秒(看门狗等需要精确时刻的地方)。 */
export function clockTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * 对话里的时间戳(better-paseo 页脚同款):今天只写「时:分」,今年其他日子「M月D日 时:分」,
 * 往年再加年份。24 小时制、两位数字,同一列的时间等宽对齐。
 */
export function stampTime(iso: string | null | undefined, t: Translate, now: number = Date.now()): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date(now);
  const pad = (value: number) => String(value).padStart(2, "0");
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate()) {
    return clock;
  }
  return t("labels.time.withClock", { date: monthDayLabel(date, date.getFullYear() !== today.getFullYear(), t), clock });
}

/** 完整时刻(无障碍标签、悬停说明):YYYY-MM-DD 时:分:秒。 */
export function fullStamp(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clockTime(iso)}`;
}
