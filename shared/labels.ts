import type { Decision, Ticket, Trigger } from "./model";

/** 展示层中文标签与状态推导(client/server 共用;纯函数无运行时依赖)。 */

/** 状态色调:映射到宿主 theme 的 status token;default = 前景色,muted = 次要色。 */
export type Tone = "default" | "success" | "danger" | "warning" | "muted";

export interface StatusLabel {
  label: string;
  tone: Tone;
}

export function outcomeLabel(outcome: Decision["outcome"]): string {
  switch (outcome) {
    case "dispatch":
      return "派发";
    case "steer":
      return "转向";
    case "cancel":
      return "取消";
    case "retry":
      return "重试";
    case "reply":
      return "答复";
    case "ignore":
      return "忽略";
    case "stop":
      return "终止";
    case "unparsed":
      return "未解析";
    case "error":
      return "错误";
  }
}

export function outcomeTone(outcome: Decision["outcome"]): Tone {
  switch (outcome) {
    case "dispatch":
    case "steer":
    case "retry":
    case "reply":
      return "default";
    case "cancel":
    case "stop":
      return "warning";
    case "ignore":
      return "muted";
    case "unparsed":
    case "error":
      return "danger";
  }
}

export function ticketStatusLabel(status: Ticket["status"]): string {
  switch (status) {
    case "pending":
      return "待启动";
    case "launching":
      return "启动中";
    case "running":
      return "运行中";
    case "waiting":
      return "待命";
    case "completed":
      return "已完成";
    case "failed":
      return "失败";
    case "canceled":
      return "已取消";
  }
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

export function triggerStatusLabel(status: Trigger["status"]): string {
  switch (status) {
    case "pending":
      return "待评估";
    case "filtered":
      return "已过滤";
    case "evaluated":
      return "已评估";
    case "delivered":
      return "已直通";
    case "failed":
      return "失败";
  }
}

export function triggerKindLabel(kind: Trigger["kind"]): string {
  switch (kind) {
    case "manual":
      return "手动";
    case "agent":
      return "Agent 委派";
    case "report":
      return "Worker 汇报";
    case "engine":
      return "引擎";
    case "feishu":
      return "飞书";
    case "qq":
      return "QQ";
    case "dingtalk":
      return "钉钉";
    case "wecom":
      return "企业微信";
  }
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
  if (colon > 0 && ["feishu", "qq", "dingtalk", "wecom"].includes(sender.slice(0, colon))) {
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
): StatusLabel {
  if (thread.state === "closed") return { label: "已关闭", tone: "muted" };
  if (tickets.some((t) => ACTIVE_TICKET_STATUSES.includes(t.status))) return { label: "运行中", tone: "warning" };
  if (thread.pendingTriggers > 0) return { label: "待评估", tone: "warning" };

  const latestTicket = latestBy(tickets, (t) => t.updatedAt);
  const latestDecision = latestBy(decisions, (d) => d.createdAt);
  const decisionFailed = latestDecision && (latestDecision.outcome === "unparsed" || latestDecision.outcome === "error");
  if (decisionFailed && (!latestTicket || latestDecision.createdAt > latestTicket.updatedAt)) {
    return { label: "评估失败", tone: "danger" };
  }
  if (latestTicket) return { label: ticketStatusLabel(latestTicket.status), tone: ticketStatusTone(latestTicket.status) };
  switch (latestDecision?.outcome) {
    case "reply":
      return { label: "已答复", tone: "success" };
    case "ignore":
      return { label: "已忽略", tone: "muted" };
    case "stop":
      return { label: "已终止", tone: "muted" };
    default:
      return { label: "空闲", tone: "muted" };
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
export function watchdogNoteLabel(note: string | null | undefined): string {
  if (!note) return "一切正常";
  const match = /reconciled (\d+)/.exec(note);
  return match ? `已自动修复 ${match[1]} 项` : note;
}

/** 相对时间:刚刚 / N 分钟前 / N 小时前 / N 天前 / M月D日(跨年带年份)。 */
export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "";
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "";
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 45) return "刚刚";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} 天前`;
  const date = new Date(time);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  const monthDay = `${date.getMonth() + 1}月${date.getDate()}日`;
  return sameYear ? monthDay : `${date.getFullYear()}年${monthDay}`;
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
