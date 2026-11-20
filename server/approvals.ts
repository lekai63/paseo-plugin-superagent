import { createHash } from "node:crypto";

/**
 * Worker 请求的批准策略。
 *
 * 只有 Worker 的提问(kind=question)可以由 Router 依据上下文代答;工具、计划、模式等
 * 授权类请求必须由人针对具体请求确认:Router 只能拒绝或转告,不能批准。人通过
 * 对话页的权限卡片、`/approve <code>` / `/deny <code>`(对话页、`/superagent` 斜杠命令、
 * 白名单 IM 发送者)或 Paseo 的 Worker 原生会话来处理。
 */

interface RequestLike {
  id: string;
  name: string;
  kind: string;
  [key: string]: unknown;
}

/** 提问以外的请求(tool/plan/mode/other)都需要人确认。 */
export function needsHumanApproval(request: { kind: string }): boolean {
  return request.kind !== "question";
}

/** Router 的 respond 是否放行:提问可答可拒;授权类请求只允许拒绝。 */
export function routerMayRespond(request: { kind: string }, response: { behavior: string }): boolean {
  return !needsHumanApproval(request) || response.behavior === "deny";
}

const APPROVAL_CODE_LENGTH = 6;

/**
 * 批准码:由票据与请求 id 派生,稳定、短到能在 IM 里手输。它不是密钥(发送者白名单
 * 才是授权边界),作用是把人的确认绑定到一个具体请求,避免一句「好」被套到别的请求上。
 */
export function approvalCode(ticketId: string, requestId: string): string {
  return createHash("sha256").update(`${ticketId}\0${requestId}`).digest("hex").slice(0, APPROVAL_CODE_LENGTH);
}

export interface ApprovalCommand {
  behavior: "allow" | "deny";
  /** 小写批准码;缺省或格式不对时为空字符串(回复用法与待批清单)。 */
  code: string;
  /** /deny 的附带原因。 */
  message: string | null;
}

// 群聊里平台可能保留开头的 @提及;只认消息开头的命令,正文里提到 /approve 不算。
const COMMAND = /^(?:@\S+\s+)*[/／](approve|deny)(?=\s|$)\s*(\S*)\s*([\s\S]*)$/i;
const CODE = new RegExp(`^[0-9a-f]{${APPROVAL_CODE_LENGTH}}$`);

export function parseApprovalCommand(text: string): ApprovalCommand | null {
  const match = COMMAND.exec(text.trim());
  if (!match) return null;
  const code = match[2].toLowerCase();
  const valid = CODE.test(code);
  const rest = [valid ? "" : match[2], match[3]].join(" ").trim();
  return {
    behavior: match[1].toLowerCase() === "approve" ? "allow" : "deny",
    code: valid ? code : "",
    message: rest || null,
  };
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** 给人看的请求说明:类型与名称、标题/描述,以及原始输入摘录(原样,不经模型转述)。 */
export function describeRequest(request: RequestLike): string {
  const title = typeof request.title === "string" && request.title.trim() ? request.title.trim() : "";
  const description = typeof request.description === "string" ? request.description.trim() : "";
  const lines = [`${request.kind} · ${request.name}${title && title !== request.name ? ` — ${clip(title, 160)}` : ""}`];
  if (description && description !== title) lines.push(clip(description, 300));
  if (request.input !== undefined && request.input !== null) {
    let input: string;
    try {
      input = JSON.stringify(request.input);
    } catch {
      input = String(request.input);
    }
    if (input && input !== "{}") lines.push(clip(input, 600));
  }
  return lines.join("\n");
}
