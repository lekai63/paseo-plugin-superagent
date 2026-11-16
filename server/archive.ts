import { execFile } from "node:child_process";
import path from "node:path";
import { t } from "./i18n";

/**
 * IM 收到的压缩包只列清单、不解压:文件数、文件名、解压后总大小与可疑条目,写进触发正文,
 * 让 Router 不动手也能写出准确的 mandate。解压本身交给 Worker(解到哪、怎么归档由
 * 各工作区的 AGENTS.md 决定)。
 *
 * - zip:自带目录区解析(含 ZIP64;无 UTF-8 标记的文件名按 GB18030 解码,中文 Windows 打包常见);
 * - 7z / rar:调用本机 `7z l -slt`(没有 7z 时如实说明未能列出)。
 * 清单里的大小取自压缩包自报的元数据,只作提示;真正解压时 Worker 仍须自行防护。
 */

export type ArchiveFormat = "zip" | "7z" | "rar";

export interface ArchiveEntry {
  name: string;
  /** 解压后字节数(压缩包自报)。 */
  size: number;
  directory: boolean;
  encrypted: boolean;
  symlink: boolean;
}

export interface ArchiveListing {
  format: ArchiveFormat;
  entries: ArchiveEntry[];
  /** 条目超过解析上限,只读了前 MAX_ENTRIES 个。 */
  truncated: boolean;
}

const MAX_ENTRIES = 20_000;
const LISTED_FILES = 30;
const LISTED_WARNINGS = 5;
const NAME_MAX_CHARS = 120;
const SEVEN_ZIP_TIMEOUT_MS = 30_000;
/** 解压后超过这个大小,或超过 BOMB_MIN_BYTES 且压缩比超过 BOMB_RATIO,按疑似压缩炸弹提示。 */
const BOMB_ABSOLUTE_BYTES = 2 * 1024 ** 3;
const BOMB_MIN_BYTES = 200 * 1024 ** 2;
const BOMB_RATIO = 100;

const EXTENSIONS: Record<string, ArchiveFormat> = { ".zip": "zip", ".7z": "7z", ".rar": "rar" };
const FORMAT_LABEL: Record<ArchiveFormat, string> = { zip: "zip", "7z": "7z", rar: "RAR" };
/** 打包时夹带的系统元数据:不算进文件数,单独计数。 */
const JUNK = /(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$|desktop\.ini$)/i;

/** 按扩展名判断(.xlsx/.docx/.ofd 等内部也是 zip,但它们是文档,不当压缩包列)。 */
export function archiveFormat(fileName: string): ArchiveFormat | null {
  return EXTENSIONS[path.extname(fileName).toLowerCase()] ?? null;
}

// ---- zip 目录区解析 ----

const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const CENTRAL_HEADER_SIG = 0x02014b50;
const UNIX_HOST = 3;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

function corrupt(): Error {
  return new Error(t("server.archive.corrupt"));
}

function findEocd(data: Buffer): number {
  const lowest = Math.max(0, data.length - 22 - 0xffff);
  for (let i = data.length - 22; i >= lowest; i -= 1) {
    if (data.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

let utf8Strict: TextDecoder | null = null;
let gb18030: TextDecoder | null | undefined;

/** 没有 UTF-8 标记时:合法 UTF-8 就按 UTF-8,否则按 GB18030(GBK 超集),都不行退回 latin1。 */
function decodeZipName(raw: Buffer, utf8Flag: boolean): string {
  if (utf8Flag) return raw.toString("utf8");
  utf8Strict ??= new TextDecoder("utf-8", { fatal: true });
  try {
    return utf8Strict.decode(raw);
  } catch {
    // 不是 UTF-8。
  }
  if (gb18030 === undefined) {
    try {
      gb18030 = new TextDecoder("gb18030");
    } catch {
      gb18030 = null; // small-icu 构建没有 GB18030。
    }
  }
  return gb18030 ? gb18030.decode(raw) : raw.toString("latin1");
}

export function listZip(data: Buffer): ArchiveListing {
  const eocd = findEocd(data);
  if (eocd < 0) throw new Error(t("server.archive.notZip"));
  let count = data.readUInt16LE(eocd + 10);
  let offset = data.readUInt32LE(eocd + 16);
  if (count === 0xffff || offset === 0xffffffff) {
    const locator = eocd - 20;
    if (locator >= 0 && data.readUInt32LE(locator) === ZIP64_LOCATOR_SIG) {
      const zip64 = Number(data.readBigUInt64LE(locator + 8));
      if (zip64 + 56 <= data.length && data.readUInt32LE(zip64) === ZIP64_EOCD_SIG) {
        count = Number(data.readBigUInt64LE(zip64 + 32));
        offset = Number(data.readBigUInt64LE(zip64 + 48));
      }
    }
  }

  const entries: ArchiveEntry[] = [];
  let pos = offset;
  for (let index = 0; index < count; index += 1) {
    if (entries.length >= MAX_ENTRIES) return { format: "zip", entries, truncated: true };
    if (pos + 46 > data.length || data.readUInt32LE(pos) !== CENTRAL_HEADER_SIG) throw corrupt();
    const madeBy = data.readUInt16LE(pos + 4);
    const flags = data.readUInt16LE(pos + 8);
    let size = data.readUInt32LE(pos + 24);
    const nameLength = data.readUInt16LE(pos + 28);
    const extraLength = data.readUInt16LE(pos + 30);
    const commentLength = data.readUInt16LE(pos + 32);
    const externalAttributes = data.readUInt32LE(pos + 38);
    const nameStart = pos + 46;
    const extraStart = nameStart + nameLength;
    const next = extraStart + extraLength + commentLength;
    if (next > data.length) throw corrupt();

    let unicodeName: string | null = null;
    const extra = data.subarray(extraStart, extraStart + extraLength);
    for (let p = 0; p + 4 <= extra.length; ) {
      const id = extra.readUInt16LE(p);
      const body = extra.subarray(p + 4, p + 4 + extra.readUInt16LE(p + 2));
      // ZIP64 扩展:原字段为 0xFFFFFFFF 时,解压后大小排在第一位。
      if (id === 0x0001 && size === 0xffffffff && body.length >= 8) size = Number(body.readBigUInt64LE(0));
      // Info-ZIP Unicode Path:版本(1) + 原名 CRC(4) + UTF-8 文件名。
      if (id === 0x7075 && body.length > 5 && body[0] === 1) unicodeName = body.subarray(5).toString("utf8");
      p += 4 + body.length;
    }
    const name = unicodeName ?? decodeZipName(data.subarray(nameStart, extraStart), (flags & 0x800) !== 0);
    const unixMode = madeBy >> 8 === UNIX_HOST ? externalAttributes >>> 16 : 0;
    entries.push({
      name,
      size,
      directory: name.endsWith("/") || name.endsWith("\\"),
      encrypted: (flags & 0x1) !== 0,
      symlink: (unixMode & S_IFMT) === S_IFLNK,
    });
    pos = next;
  }
  return { format: "zip", entries, truncated: false };
}

// ---- 7z / rar:本机 7z ----

/** 解析 `7z l -slt -ba` 的逐条 "Key = Value" 块。 */
export function parseSevenZipSlt(output: string, format: ArchiveFormat): ArchiveListing {
  const entries: ArchiveEntry[] = [];
  for (const block of output.split(/\r?\n\s*\r?\n/)) {
    const fields = new Map<string, string>();
    for (const line of block.split(/\r?\n/)) {
      const match = /^([A-Za-z ]+?) = (.*)$/.exec(line);
      if (match) fields.set(match[1]!, match[2]!);
    }
    const name = fields.get("Path");
    if (!name) continue;
    if (entries.length >= MAX_ENTRIES) return { format, entries, truncated: true };
    const attributes = fields.get("Attributes") ?? "";
    entries.push({
      name,
      size: Number.parseInt(fields.get("Size") ?? "0", 10) || 0,
      directory: fields.get("Folder") === "+" || /^D/.test(attributes),
      encrypted: fields.get("Encrypted") === "+",
      symlink: /\bl[rwx-]{9}\b/.test(attributes),
    });
  }
  return { format, entries, truncated: false };
}

function listWithSevenZip(file: string, format: ArchiveFormat): Promise<ArchiveListing> {
  return new Promise((resolve, reject) => {
    // 固定一个假密码:文件名列表被加密时直接报错,而不是等终端输入卡住。
    execFile(
      "7z",
      ["l", "-slt", "-ba", "-pnot-the-password", "--", file],
      { timeout: SEVEN_ZIP_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, LC_ALL: "C.UTF-8" } },
      (error, stdout, stderr) => {
        const output = `${stdout}\n${stderr}`;
        if (/Wrong password|encrypted archive/i.test(output)) return reject(new Error(t("server.archive.headersEncrypted")));
        if (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT") return reject(new Error(t("server.archive.no7z")));
          return reject(new Error(error.killed ? t("server.archive.listTimeout") : t("server.archive.unreadable")));
        }
        resolve(parseSevenZipSlt(stdout, format));
      },
    );
  });
}

export async function listArchive(file: string, data: Buffer, format: ArchiveFormat): Promise<ArchiveListing> {
  return format === "zip" ? listZip(data) : listWithSevenZip(file, format);
}

// ---- 清单 → 触发正文 ----

/** 绝对路径、盘符或含 `..` 段:解压时会写到目标目录之外。 */
export function escapesRoot(name: string): boolean {
  const normalized = name.replace(/\\/g, "/");
  return normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || normalized.split("/").includes("..");
}

/** 文件名进触发正文前去掉控制字符(换行可能伪造出一行"附件"),并限制长度。 */
function displayName(name: string): string {
  const clean = name.replace(/[\u0000-\u001f\u007f]/g, "?");
  return clean.length > NAME_MAX_CHARS ? `${clean.slice(0, NAME_MAX_CHARS - 1)}…` : clean;
}

function sample(names: string[]): string {
  const shown = names.slice(0, LISTED_WARNINGS).map(displayName).join(t("server.archive.separator"));
  return names.length > LISTED_WARNINGS ? t("server.archive.sampleMore", { shown, count: names.length }) : shown;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/** 清单的缩进行(接在附件那一行后面)。archiveBytes 是压缩包本身的大小,用来算压缩比。 */
export function describeArchive(listing: ArchiveListing, archiveBytes: number): string[] {
  const junk = listing.entries.filter((entry) => JUNK.test(entry.name.replace(/\\/g, "/")));
  const real = listing.entries.filter((entry) => !junk.includes(entry));
  const files = real.filter((entry) => !entry.directory);
  const total = files.reduce((sum, entry) => sum + entry.size, 0);
  const label = FORMAT_LABEL[listing.format];
  if (files.length === 0) {
    return [t(listing.entries.length > 0 ? "server.archive.emptyMetadataOnly" : "server.archive.empty", { label })];
  }

  const size = formatSize(total);
  const lines = [
    listing.truncated
      ? t("server.archive.headerTruncated", { label, count: files.length, size })
      : t("server.archive.header", { label, count: files.length, size }),
  ];
  for (const entry of files.slice(0, LISTED_FILES)) lines.push(t("server.archive.entry", { name: displayName(entry.name), size: formatSize(entry.size) }));
  if (files.length > LISTED_FILES) lines.push(t("server.archive.moreFiles", { count: files.length - LISTED_FILES }));

  const nested = files.filter((entry) => archiveFormat(entry.name) !== null);
  if (nested.length > 0) lines.push(t("server.archive.nested", { count: nested.length, names: sample(nested.map((entry) => entry.name)) }));
  const encrypted = files.filter((entry) => entry.encrypted);
  if (encrypted.length > 0) {
    lines.push(
      encrypted.length === files.length
        ? t("server.archive.encryptedAll")
        : t("server.archive.encryptedSome", { count: encrypted.length }),
    );
  }
  const escaping = real.filter((entry) => escapesRoot(entry.name)).map((entry) => entry.name);
  if (escaping.length > 0) lines.push(t("server.archive.escaping", { names: sample(escaping) }));
  const links = real.filter((entry) => entry.symlink).map((entry) => entry.name);
  if (links.length > 0) lines.push(t("server.archive.symlinks", { names: sample(links) }));
  const ratio = archiveBytes > 0 ? total / archiveBytes : 0;
  if (total > BOMB_ABSOLUTE_BYTES || (total > BOMB_MIN_BYTES && ratio > BOMB_RATIO)) {
    lines.push(t("server.archive.bomb", { size: formatSize(total), ratio: Math.round(ratio) }));
  }
  if (junk.length > 0) lines.push(t("server.archive.junk", { count: junk.length }));
  return lines;
}

/** 落盘后的压缩包 → 清单行;不是压缩包返回空数组,读不了时说明原因。 */
export async function inspectArchive(file: string, data: Buffer, fileName: string): Promise<string[]> {
  const format = archiveFormat(fileName);
  if (!format) return [];
  try {
    return describeArchive(await listArchive(file, data, format), data.length);
  } catch (error) {
    return [t("server.archive.unlisted", { label: FORMAT_LABEL[format], error: error instanceof Error ? error.message : String(error) })];
  }
}
