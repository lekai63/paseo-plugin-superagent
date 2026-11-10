import { createDecipheriv } from "node:crypto";
import { formatSize } from "./archive";
import { downloadBuffer, IM_ATTACHMENT_MAX_BYTES, type PendingAttachment } from "./im-attachments";
import { WeixinItemType, type WeixinCdnMedia, type WeixinMessageItem } from "./weixin-api";

/**
 * 微信入站附件(图片/文件/视频)的取法:从微信 CDN 下载,AES-128-ECB 解密。落盘、命名、
 * 压缩包清单与正文行见 im-attachments.ts。协议依据 Tencent/openclaw-weixin 的
 * src/cdn/pic-decrypt.ts 与 src/media/media-download.ts。
 */

export const WEIXIN_CDN_BASE = "https://novac2c.cdn.weixin.qq.com/c2c";

export type WeixinMediaKind = "image" | "file" | "video";

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

/** 下载并解密一份媒体,返回明文。 */
export async function downloadWeixinMedia(ref: WeixinMediaRef, signal?: AbortSignal): Promise<Buffer> {
  const url = downloadUrl(ref.media);
  if (!url) throw new Error("消息未带 CDN 下载参数");
  // 图片没有密钥时按明文图片处理(官方插件同样如此);文件/视频必须解密。
  if (!ref.aesKey && ref.kind !== "image") throw new Error("消息未带解密密钥");
  const key = ref.aesKey ? parseWeixinAesKey(ref.aesKey) : null;
  if (ref.declaredBytes !== undefined && ref.declaredBytes > IM_ATTACHMENT_MAX_BYTES) {
    throw new Error(`超过 ${formatSize(IM_ATTACHMENT_MAX_BYTES)} 上限(${formatSize(ref.declaredBytes)})`);
  }
  // 密文比明文多至多 16 字节的 PKCS#7 填充。
  const { data } = await downloadBuffer(url, { signal, label: "CDN ", maxBytes: IM_ATTACHMENT_MAX_BYTES + 16 });
  return key ? decryptAesEcb(data, key) : data;
}

export function weixinPendingAttachment(ref: WeixinMediaRef): PendingAttachment {
  return {
    kind: ref.kind,
    fileName: ref.fileName,
    quoted: ref.quoted,
    download: async (signal) => ({ data: await downloadWeixinMedia(ref, signal) }),
  };
}
