import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { clearTimeout, setTimeout } from "node:timers";
import { beijingDate, type TriggerOrigin } from "../shared/model";
import { formatSize, inspectArchive } from "./archive";
import { resolveImInboxDir } from "./im";
import { t } from "./i18n";

/**
 * IM 附件的通用落盘:各通道只负责"怎么下载",这里负责命名、存放、压缩包清单和
 * 写进触发正文的那一行。
 *
 *   <IM 收件目录>/<通道>/<北京时间日期>/<消息 id>/<原文件名>
 *
 * 触发正文里每个附件一行:`[飞书文件] a.pdf(1.2 MB)已保存到本机:<路径>`,压缩包再跟清单;
 * 下载失败也写一行原因,让 Router 知道要请用户重发,而不是让附件无声消失。
 */

/** 与各平台机器人入站文件的常见上限一致。 */
export const IM_ATTACHMENT_MAX_BYTES = 100 * 1024 * 1024;
export const IM_DOWNLOAD_TIMEOUT_MS = 120_000;
/** 文件名上限按字节算(ext4 单个文件名 255 字节,中文每字 3 字节)。 */
const FILE_NAME_MAX_BYTES = 200;

export type AttachmentKind = "image" | "file" | "video" | "audio";
type Channel = TriggerOrigin["channel"];

const kindLabel = (kind: AttachmentKind): string => t(`server.attachment.kind.${kind}`);
/** 通道名随当前语言;调用时才取值。 */
export const channelLabel = (channel: Channel): string => t(`server.attachment.channel.${channel}`);

/** 待下载的附件:各通道给出下载方法,下载时可顺带给出服务端的文件名(响应头)。 */
export interface PendingAttachment {
  kind: AttachmentKind;
  /** 消息里带的文件名(可能没有)。 */
  fileName?: string;
  /** 取自被引用的消息(当前消息本身不带附件)。 */
  quoted: boolean;
  download: (signal?: AbortSignal) => Promise<{ data: Buffer; fileName?: string }>;
}

export interface SavedAttachment {
  kind: AttachmentKind;
  quoted: boolean;
  /** 落盘后的文件名;失败时为消息里给的名字(可能没有)。 */
  name: string | null;
  path: string | null;
  bytes: number | null;
  error: string | null;
  /** 接在附件行后面的缩进行(压缩包清单)。 */
  details: string[];
}

class DownloadError extends Error {}

function tooLarge(bytes: number): DownloadError {
  return new DownloadError(t("server.attachment.tooLarge", { limit: formatSize(IM_ATTACHMENT_MAX_BYTES), size: formatSize(bytes) }));
}

// ---- 下载 ----

async function collectWebStream(body: ReadableStream<Uint8Array>, maxBytes: number): Promise<Buffer> {
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooLarge(size);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * GET/POST 一个下载地址并读完响应体:整体超时、外部取消、边读边卡大小上限。
 * label 拼在 HTTP 错误前面(如 "CDN " → "CDN 下载失败:HTTP 404")。
 */
export async function downloadBuffer(
  url: string,
  options: { init?: RequestInit; signal?: AbortSignal; label?: string; timeoutMs?: number; maxBytes?: number } = {},
): Promise<{ data: Buffer; headers: Headers | null }> {
  const timeoutMs = options.timeoutMs ?? IM_DOWNLOAD_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? IM_ATTACHMENT_MAX_BYTES;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  const external = options.signal;
  const onAbort = () => controller.abort();
  if (external?.aborted) controller.abort();
  external?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetch(url, { ...options.init, signal: controller.signal });
    if (!response.ok) throw new DownloadError(t("server.attachment.httpFailed", { label: options.label ?? "", status: response.status }));
    const headers = response.headers ?? null;
    const declared = Number(headers?.get("content-length"));
    if (declared > maxBytes) throw tooLarge(declared);
    const data =
      response.body && typeof response.body.getReader === "function"
        ? await collectWebStream(response.body, maxBytes)
        : Buffer.from(await response.arrayBuffer());
    if (data.length > maxBytes) throw tooLarge(data.length);
    return { data, headers };
  } catch (error) {
    if (error instanceof DownloadError) throw error;
    if (controller.signal.aborted) throw new Error(external?.aborted ? t("server.attachment.cancelled") : t("server.attachment.timeout", { seconds: timeoutMs / 1000 }));
    throw error;
  } finally {
    clearTimeout(timer);
    external?.removeEventListener("abort", onAbort);
  }
}

/** 读完一个 Node 流(SDK 返回的下载流):超时、取消与大小上限同上。 */
export function readStream(
  stream: Readable,
  options: { signal?: AbortSignal; timeoutMs?: number; maxBytes?: number } = {},
): Promise<Buffer> {
  const timeoutMs = options.timeoutMs ?? IM_DOWNLOAD_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? IM_ATTACHMENT_MAX_BYTES;
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (error) {
        stream.destroy();
        reject(error);
      } else {
        resolve(Buffer.concat(chunks));
      }
    };
    const timer = setTimeout(() => finish(new Error(t("server.attachment.timeout", { seconds: timeoutMs / 1000 }))), timeoutMs);
    timer.unref?.();
    const onAbort = () => finish(new Error(t("server.attachment.cancelled")));
    if (options.signal?.aborted) return onAbort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    stream.on("data", (chunk: Buffer | string) => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += buffer.length;
      if (size > maxBytes) return finish(tooLarge(size));
      chunks.push(buffer);
    });
    stream.on("end", () => finish());
    stream.on("error", (error) => finish(error instanceof Error ? error : new Error(String(error))));
  });
}

/** 整体超时包一层(SDK 请求无法传取消信号时用):超时只是不再等它。 */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number = IM_DOWNLOAD_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(t("server.attachment.timeout", { seconds: timeoutMs / 1000 }))), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Content-Disposition 里的文件名:优先 RFC 5987 的 filename*=UTF-8''…。 */
export function fileNameFromDisposition(header: string | null | undefined): string | undefined {
  if (!header) return undefined;
  const extended = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header);
  const plain = /filename\s*=\s*"([^"]*)"|filename\s*=\s*([^;\s]+)/.exec(header);
  const raw = extended?.[1] ?? plain?.[1] ?? plain?.[2];
  if (!raw) return undefined;
  try {
    return decodeURIComponent(raw.trim());
  } catch {
    return raw.trim();
  }
}

// ---- 命名与落盘 ----

/** 按字节截断但保留扩展名,不切断多字节字符。 */
function fitBytes(name: string, max: number): string {
  if (Buffer.byteLength(name) <= max) return name;
  const ext = path.extname(name);
  const keepExt = ext && Buffer.byteLength(ext) <= 20 ? ext : "";
  const stem = Array.from(keepExt ? name.slice(0, -ext.length) : name);
  while (stem.length > 0 && Buffer.byteLength(stem.join("") + keepExt) > max) stem.pop();
  return stem.join("") + keepExt;
}

/** 消息里给的文件名只取最后一段,去掉控制字符与开头的点(不落成隐藏文件或 `..`)。 */
export function safeFileName(raw: string | undefined): string | null {
  const base = (raw ?? "").replace(/\\/g, "/").split("/").pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim().replace(/^[.\s]+/, "");
  return cleaned ? fitBytes(cleaned, FILE_NAME_MAX_BYTES) : null;
}

/** 没有文件名时按内容猜扩展名。 */
function sniffExtension(kind: AttachmentKind, data: Buffer): string {
  const ascii = (start: number, end: number) => data.subarray(start, end).toString("latin1");
  if (data[0] === 0xff && data[1] === 0xd8) return ".jpg";
  if (data.subarray(0, 4).toString("hex") === "89504e47") return ".png";
  if (ascii(0, 3) === "GIF") return ".gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return ".webp";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return ".wav";
  if (ascii(0, 4) === "OggS") return ".ogg";
  if (ascii(0, 5) === "#!AMR") return ".amr";
  if (ascii(0, 6) === "#!SILK" || ascii(1, 7) === "#!SILK") return ".silk";
  if (ascii(0, 3) === "ID3") return ".mp3";
  if (ascii(4, 8) === "ftyp") return kind === "audio" ? ".m4a" : ".mp4";
  if (ascii(0, 4) === "%PDF") return ".pdf";
  if (kind === "image") return ".jpg";
  if (kind === "video") return ".mp4";
  return ".bin";
}

function fallbackName(kind: AttachmentKind, index: number, data: Buffer): string {
  return `${kind}-${index}${sniffExtension(kind, data)}`;
}

/** 同一条消息里重名的附件加序号:a.pdf → a (2).pdf。 */
function uniqueName(name: string, used: Set<string>): string {
  let candidate = name;
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let n = 2; used.has(candidate); n += 1) candidate = `${stem} (${n})${ext}`;
  used.add(candidate);
  return candidate;
}

/** 逐个下载落盘;单个失败只记在该附件上,不影响其余附件与消息本身。 */
export async function saveAttachments(
  channel: Channel,
  messageId: string | null,
  pending: PendingAttachment[],
  options: { signal?: AbortSignal; now?: Date; inboxDir?: string } = {},
): Promise<SavedAttachment[]> {
  const folder = (messageId ?? "").replace(/[^0-9A-Za-z_-]/g, "") || randomUUID();
  const root = options.inboxDir ?? resolveImInboxDir("");
  const dir = path.join(root, channel, beijingDate(options.now ?? new Date()), folder);
  const used = new Set<string>();
  const results: SavedAttachment[] = [];
  for (const [index, item] of pending.entries()) {
    const wanted = safeFileName(item.fileName);
    try {
      const { data, fileName } = await item.download(options.signal);
      // 服务端给的名字没有扩展名时补上按内容猜的,免得落成无法识别的文件。
      const served = safeFileName(fileName);
      const named = served && !path.extname(served) ? `${served}${sniffExtension(item.kind, data)}` : served;
      const name = uniqueName(wanted ?? named ?? fallbackName(item.kind, index + 1, data), used);
      const file = path.join(dir, name);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(file, data, { mode: 0o600 });
      const details = item.kind === "file" ? await inspectArchive(file, data, name) : [];
      results.push({ kind: item.kind, quoted: item.quoted, name, path: file, bytes: data.length, error: null, details });
      console.log(`[superagent] ${channel} ${item.kind} saved: ${file} (${data.length} bytes)`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ kind: item.kind, quoted: item.quoted, name: wanted, path: null, bytes: null, error: message, details: [] });
      console.warn(`[superagent] ${channel} ${item.kind} ${wanted ?? ""} download failed: ${message}`);
    }
  }
  return results;
}

// ---- 写进触发正文 ----

function label(channel: Channel, kind: AttachmentKind, quoted: boolean): string {
  return t(quoted ? "server.attachment.quotedLabel" : "server.attachment.label", { channel: channelLabel(channel), kind: kindLabel(kind) });
}

/** 附件一行(压缩包再跟清单):Router 据此写 mandate,失败时知道要请用户重发。 */
export function describeSavedAttachment(channel: Channel, attachment: SavedAttachment): string {
  const head = label(channel, attachment.kind, attachment.quoted);
  if (attachment.path) {
    const line = t("server.attachment.saved", { head, name: attachment.name ?? "", size: formatSize(attachment.bytes ?? 0), path: attachment.path });
    return [line, ...attachment.details].join("\n");
  }
  const name = attachment.name ? ` ${attachment.name}` : "";
  return t("server.attachment.failed", { head, name, error: attachment.error ?? "" });
}

/** 不下载时的简短描述(群消息留痕、观察模式上下文、标题);文件名同样先清理。 */
export function describePendingAttachment(
  channel: Channel,
  attachment: { kind: AttachmentKind; fileName?: string; quoted?: boolean },
): string {
  const name = safeFileName(attachment.fileName);
  return `${label(channel, attachment.kind, attachment.quoted ?? false)}${name ? ` ${name}` : ""}`;
}

/** 非空段落按行拼接。 */
export function joinLines(parts: Array<string | null | undefined>): string {
  return parts.filter((part): part is string => Boolean(part && part.trim())).join("\n").trim();
}

/**
 * 入站消息串行处理:下载附件需要时间,但同一通道的消息仍按到达顺序交给引擎;
 * 事件回调本身立即返回(飞书长连接要求 3 秒内处理完,否则重推)。
 */
export class InboundQueue {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly channel: Channel) {}

  push(task: () => Promise<void>): Promise<void> {
    const run = this.tail.then(task).catch((error) => {
      console.error(`[superagent] ${this.channel} inbound message handling failed`, error);
    });
    this.tail = run;
    return run;
  }
}
