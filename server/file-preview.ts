import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { FileKind, FilePreview } from "../shared/file-preview";
import { FILE_PREVIEW_LIMITS, IMAGE_MIME_TYPES } from "../shared/file-preview";
import { extensionOf } from "../shared/file-links";

/**
 * 对话页文件预览的只读读取:任意绝对路径(`~` 展开为 daemon 用户的主目录)。
 * 只读普通文件与目录;设备、管道、套接字一律不读(读管道会一直阻塞)。
 * 文本截断到上限,图片超过上限不传,其他二进制只给大小。
 */

export async function readFilePreview(rawPath: string, limits = FILE_PREVIEW_LIMITS): Promise<FilePreview> {
  const path = expandPath(rawPath);
  if (!path) return { kind: "error", path: rawPath, message: "只能预览绝对路径" };
  try {
    const info = await stat(path);
    const modifiedAt = info.mtime.toISOString();
    if (info.isDirectory()) return await readDirectory(path, modifiedAt, limits.entries);
    if (!info.isFile()) return { kind: "error", path, message: "不是普通文件,无法预览" };

    const mimeType = IMAGE_MIME_TYPES[extensionOf(path)];
    if (mimeType) {
      if (info.size > limits.imageBytes) return { kind: "binary", path, size: info.size, modifiedAt, reason: "too_large" };
      const { bytes } = await readHead(path, limits.imageBytes);
      return { kind: "image", path, size: info.size, modifiedAt, mimeType, base64: bytes.toString("base64") };
    }

    const { bytes, complete } = await readHead(path, limits.textBytes);
    if (looksBinary(bytes)) return { kind: "binary", path, size: info.size, modifiedAt, reason: "binary" };
    // 截断可能切在多字节字符中间:退到最后一个完整字符,避免末尾出现替换符。
    const text = (complete ? bytes : bytes.subarray(0, utf8Boundary(bytes))).toString("utf8").replace(/^﻿/, "");
    return { kind: "text", path, size: Math.max(info.size, bytes.length), modifiedAt, text, truncated: !complete };
  } catch (error) {
    return { kind: "error", path, message: errorMessage(error) };
  }
}

/**
 * 文件药丸的类型:一次查完一段对话里链接到的所有路径。stat 跟随符号链接;不存在为 missing,
 * 其他原因读不到(权限等)为 unknown,由界面按链接写法猜。
 */
export async function statPaths(paths: readonly string[]): Promise<Record<string, FileKind>> {
  const kinds = await Promise.all(paths.map(async (rawPath): Promise<FileKind> => {
    const path = expandPath(rawPath);
    if (!path) return "unknown";
    try {
      const info = await stat(path);
      return info.isDirectory() ? "directory" : info.isFile() ? "file" : "unknown";
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unknown";
    }
  }));
  return Object.fromEntries(paths.map((path, index) => [path, kinds[index]]));
}

/** `~`、`~/x` 展开;不是绝对路径时为 null。 */
export function expandPath(rawPath: string): string | null {
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed.includes("\0")) return null;
  const expanded = trimmed === "~" ? homedir() : trimmed.startsWith("~/") ? join(homedir(), trimmed.slice(2)) : trimmed;
  return isAbsolute(expanded) ? resolve(expanded) : null;
}

async function readDirectory(path: string, modifiedAt: string, limit: number): Promise<FilePreview> {
  const dirents = await readdir(path, { withFileTypes: true });
  const entries = dirents
    .map((entry) => ({ name: entry.name, directory: entry.isDirectory() }))
    .sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
  return { kind: "directory", path, modifiedAt, entries: entries.slice(0, limit), total: entries.length };
}

/** 读前 limit 字节;多读 1 字节判断是否读完(/proc 等文件的 size 是 0,不能信 stat)。 */
async function readHead(path: string, limit: number): Promise<{ bytes: Buffer; complete: boolean }> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    return { bytes: buffer.subarray(0, Math.min(length, limit)), complete: length <= limit };
  } finally {
    await handle.close();
  }
}

/** 与 git 相同的判断:开头 8000 字节里有 NUL 即视为二进制。 */
function looksBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, 8000).includes(0);
}

function utf8Boundary(bytes: Buffer): number {
  let end = bytes.length;
  // 往回最多看 3 个续字节,找到起始字节后判断该字符是否完整。
  for (let back = 1; back <= 4 && end - back >= 0; back++) {
    const byte = bytes[end - back];
    if ((byte & 0xc0) === 0x80) continue;
    const width = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return width > back ? end - back : end;
  }
  return end;
}

function errorMessage(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOENT" || code === "ENOTDIR") return "文件不存在(可能已被删除或移动)";
  if (code === "EACCES" || code === "EPERM") return "没有读取权限";
  if (code === "ELOOP") return "符号链接层数过多";
  return error instanceof Error ? error.message : String(error);
}
