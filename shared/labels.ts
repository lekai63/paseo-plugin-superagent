import type { Decision, Ticket, Trigger } from "./model";

/** 展示层中文标签(client/server 共用;纯函数无运行时依赖)。 */

export function outcomeLabel(outcome: Decision["outcome"]): string {
  switch (outcome) {
    case "dispatch":
      return "派发";
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

export function ticketStatusLabel(status: Ticket["status"]): string {
  switch (status) {
    case "pending":
      return "待启动";
    case "launching":
      return "启动中";
    case "running":
      return "运行中";
    case "waiting":
      return "待跟进";
    case "completed":
      return "已完成";
    case "failed":
      return "失败";
    case "canceled":
      return "已取消";
  }
}

export function ticketStatusTone(status: Ticket["status"]): "success" | "danger" | "warning" | "muted" {
  switch (status) {
    case "running":
    case "launching":
      return "warning";
    case "waiting":
      return "muted";
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
