import { createDecipheriv, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import { formatSize, inspectArchive } from "./archive";
import { resolveImInboxDir } from "./im";
import { WeixinItemType, type WeixinCdnMedia, type WeixinMessageItem } from "./weixin-api";

/**
 * 微信入站附件(图片/文件/视频):从微信 CDN 下载,用 AES-128-ECB 解密后落盘,
 * 再把本机路径写进触发正文交给 Router;压缩包另附清单(见 archive.ts)。协议依据
 * Tencent/openclaw-weixin 的 src/cdn/pic-decrypt.ts 与 src/media/media-download.ts。
 *
 *   <IM 收件目录>/weixin/<本地日期>/<消息 id>/<原文件名>
 *   收件目录默认 $PASEO_HOME/plugin-data/superagent/inbox,设置 imInboxDir 可改。
 */

export const WEIXIN_CDN_BASE = "https://novac2c.cdn.weixin.qq.com/c2c";
/** 与官方插件的入站媒体上限一致。 */
export const WEIXIN_MEDIA_MAX_BYTES = 100 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120_000;
/** 文件名上限按字节算(ext4 单个文件名 255 字节,中文每字 3 字节)。 */
const FILE_NAME_MAX_BYTES = 200;

export type WeixinMediaKind = "image" | "file" | "video";

const KIND_LABEL: Record<WeixinMediaKind, string> = { image: "图片", file: "文件", video: "视频" };

export interface WeixinMediaRef {
  kind: WeixinMediaKind;
  media: WeixinCdnMedia;
  /** base64 密钥;缺省时只有图片允许按明文下载。 */
  aesKey?: string;
  fileName?: string;
  /** 发送端声明的明文字节数。 */
  declaredBytes?: number;
  /** 取自被引用的消息(当前消息本身不带媒体)。 */
  quoted: boolean;
}

export interface WeixinAttachment {
  kind: WeixinMediaKind;
  quoted: boolean;
  /** 落盘后的文件名;失败时为发送端给的名字(可能没有)。 */
  name: string | null;
  path: string | null;
  bytes: number | null;
  error: string | null;
  /** 接在附件行后面的缩进行(压缩包清单)。 */
  details: string[];
}

function mediaRefOf(item: WeixinMessageItem, quoted: boolean): WeixinMediaRef | null {
  if (item.type === WeixinItemType.IMAGE) {
    const image = item.image_item ?? {};
    const aesKey = image.aeskey ? Buffer.from(image.aeskey, "hex").toString("base64") : image.media?.aes_key;
    return { kind: "image", media: image.media ?? {}, aesKey: aesKey || undefined, quoted };
  }
  if (item.type === WeixinItemType.FILE) {
    const file = item.file_item ?? {};
    const declared = Number.parseInt(file.len ?? "", 10);
    return {
      kind: "file",
      media: file.media ?? {},
      aesKey: file.media?.aes_key || undefined,
      fileName: file.file_name?.trim() || undefined,
      declaredBytes: Number.isFinite(declared) ? declared : undefined,
      quoted,
    };
  }
  if (item.type === WeixinItemType.VIDEO) {
    const video = item.video_item ?? {};
    return { kind: "video", media: video.media ?? {}, aesKey: video.media?.aes_key || undefined, quoted };
  }
  return null;
}

/**
 * 消息里的图片/文件/视频。当前消息没带媒体时,回落到被引用的那条(引用一份文件说"处理这个")。
 * 下载参数缺失的条目也保留,由下载步骤报出原因,而不是让附件无声消失。
 */
export function weixinMediaRefs(items: WeixinMessageItem[] = []): WeixinMediaRef[] {
  const own = items.map((item) => mediaRefOf(item, false)).filter((ref): ref is WeixinMediaRef => ref !== null);
  if (own.length > 0) return own;
  return items
    .map((item) => (item.ref_msg?.message_item ? mediaRefOf(item.ref_msg.message_item, true) : null))
    .filter((ref): ref is WeixinMediaRef => ref !== null);
}

/** aes_key 有两种编码:base64(16 字节原始密钥) 与 base64(32 位十六进制字符串)。 */
export function parseWeixinAesKey(aesKeyBase64: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, "base64");
  if (decoded.length === 16) return decoded;
  const ascii = decoded.toString("ascii");
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(ascii)) return Buffer.from(ascii, "hex");
  throw new Error(`解密密钥格式不对(解码后 ${decoded.length} 字节)`);
}

function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function downloadUrl(media: WeixinCdnMedia): string | null {
  if (media.full_url) return media.full_url;
  if (media.encrypt_query_param) {
    return `${WEIXIN_CDN_BASE}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`;
  }
  return null;
}

function tooLarge(bytes: number): Error {
  return new Error(`超过 ${formatSize(WEIXIN_MEDIA_MAX_BYTES)} 上限(${formatSize(bytes)})`);
}

/** 下载并解密一份媒体,返回明文。 */
export async function downloadWeixinMedia(ref: WeixinMediaRef, signal?: AbortSignal): Promise<Buffer> {
  const url = downloadUrl(ref.media);
  if (!url) throw new Error("消息未带 CDN 下载参数");
  // 图片没有密钥时按明文图片处理(官方插件同样如此);文件/视频必须解密。
  if (!ref.aesKey && ref.kind !== "image") throw new Error("消息未带解密密钥");
  const key = ref.aesKey ? parseWeixinAesKey(ref.aesKey) : null;
  if (ref.declaredBytes !== undefined && ref.declaredBytes > WEIXIN_MEDIA_MAX_BYTES) throw tooLarge(ref.declaredBytes);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  timer.unref?.();
  const onAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`CDN 下载失败:HTTP ${response.status}`);
    const length = Number(response.headers?.get("content-length"));
    // 密文比明文多至多 16 字节的 PKCS#7 填充。
    if (length > WEIXIN_MEDIA_MAX_BYTES + 16) throw tooLarge(length);
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > WEIXIN_MEDIA_MAX_BYTES + 16) throw tooLarge(body.length);
    return key ? decryptAesEcb(body, key) : body;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(signal?.aborted ? "下载被取消" : `下载超时(${DOWNLOAD_TIMEOUT_MS / 1000} 秒)`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** 按字节截断但保留扩展名,不切断多字节字符。 */
function fitBytes(name: string, max: number): string {
  if (Buffer.byteLength(name) <= max) return name;
  const ext = path.extname(name);
  const keepExt = ext && Buffer.byteLength(ext) <= 20 ? ext : "";
  const stem = Array.from(keepExt ? name.slice(0, -ext.length) : name);
  while (stem.length > 0 && Buffer.byteLength(stem.join("") + keepExt) > max) stem.pop();
  return stem.join("") + keepExt;
}

/** 发送端给的文件名只取最后一段,去掉控制字符与开头的点(不落成隐藏文件或 `..`)。 */
export function safeWeixinFileName(raw: string | undefined): string | null {
  const base = (raw ?? "").replace(/\\/g, "/").split("/").pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim().replace(/^[.\s]+/, "");
  return cleaned ? fitBytes(cleaned, FILE_NAME_MAX_BYTES) : null;
}

function imageExtension(data: Buffer): string {
  if (data[0] === 0xff && data[1] === 0xd8) return ".jpg";
  if (data.subarray(0, 4).toString("hex") === "89504e47") return ".png";
  if (data.subarray(0, 3).toString("ascii") === "GIF") return ".gif";
  if (data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") return ".webp";
  return ".jpg";
}

function fallbackName(kind: WeixinMediaKind, index: number, data: Buffer): string {
  if (kind === "image") return `image-${index}${imageExtension(data)}`;
  if (kind === "video") return `video-${index}.mp4`;
  return `file-${index}.bin`;
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

function localDate(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** 逐个下载落盘;单个失败只记在该附件上,不影响其余附件与消息本身。 */
export async function saveWeixinAttachments(
  refs: WeixinMediaRef[],
  messageId: string | null,
  options: { signal?: AbortSignal; now?: Date; inboxDir?: string } = {},
): Promise<WeixinAttachment[]> {
  const folder = (messageId ?? "").replace(/[^0-9A-Za-z_-]/g, "") || randomUUID();
  const root = options.inboxDir ?? resolveImInboxDir("");
  const dir = path.join(root, "weixin", localDate(options.now ?? new Date()), folder);
  const used = new Set<string>();
  const results: WeixinAttachment[] = [];
  for (const [index, ref] of refs.entries()) {
    const wanted = safeWeixinFileName(ref.fileName);
    try {
      const data = await downloadWeixinMedia(ref, options.signal);
      const name = uniqueName(wanted ?? fallbackName(ref.kind, index + 1, data), used);
      const file = path.join(dir, name);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(file, data, { mode: 0o600 });
      const details = ref.kind === "file" ? await inspectArchive(file, data, name) : [];
      results.push({ kind: ref.kind, quoted: ref.quoted, name, path: file, bytes: data.length, error: null, details });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ kind: ref.kind, quoted: ref.quoted, name: wanted, path: null, bytes: null, error: message, details: [] });
    }
  }
  return results;
}

/** 附件在触发正文里的一行(压缩包再跟清单):Router 据此写 mandate,失败时知道要让用户重发。 */
export function describeWeixinAttachment(attachment: WeixinAttachment): string {
  const label = `[${attachment.quoted ? "引用的" : ""}微信${KIND_LABEL[attachment.kind]}]`;
  if (attachment.path) {
    const head = `${label} ${attachment.name}(${formatSize(attachment.bytes ?? 0)})已保存到本机:${attachment.path}`;
    return [head, ...attachment.details].join("\n");
  }
  const name = attachment.name ? ` ${attachment.name}` : "";
  return `${label}${name} 下载失败:${attachment.error},请让用户重新发送`;
}

/** 下载前的简短描述(群消息留痕、标题);文件名同样先清理,不带换行进正文。 */
export function describeWeixinMediaRef(ref: WeixinMediaRef): string {
  const name = safeWeixinFileName(ref.fileName);
  return `[微信${KIND_LABEL[ref.kind]}]${name ? ` ${name}` : ""}`;
}
