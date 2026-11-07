import { z } from "zod";

/** 文件预览:server/file-preview.ts 读取,client/file-preview.tsx 展示。 */

export const FILE_PREVIEW_LIMITS = {
  /** 文本最多读 256 KB:再大宿主 Markdown 渲染与高亮会明显变慢。 */
  textBytes: 256 * 1024,
  /** 图片以 base64 走 RPC,超过 4 MB 不传。 */
  imageBytes: 4 * 1024 * 1024,
  /** 目录最多列出的条目数。 */
  entries: 500,
} as const;

/** RN Image 在各端都能显示的格式。SVG 当文本预览。 */
export const IMAGE_MIME_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
};

export const FilePreviewSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("text"),
    path: z.string(),
    size: z.number(),
    modifiedAt: z.string(),
    text: z.string(),
    /** 只读了开头一部分。 */
    truncated: z.boolean(),
  }),
  z.object({
    kind: z.literal("image"),
    path: z.string(),
    size: z.number(),
    modifiedAt: z.string(),
    mimeType: z.string(),
    base64: z.string(),
  }),
  z.object({
    kind: z.literal("directory"),
    path: z.string(),
    modifiedAt: z.string(),
    entries: z.array(z.object({ name: z.string(), directory: z.boolean() })),
    /** 目录里的条目总数(entries 可能被截断)。 */
    total: z.number(),
  }),
  z.object({
    kind: z.literal("binary"),
    path: z.string(),
    size: z.number(),
    modifiedAt: z.string(),
    /** binary = 不是文本;too_large = 图片超过上限。 */
    reason: z.enum(["binary", "too_large"]),
  }),
  z.object({
    kind: z.literal("error"),
    path: z.string(),
    message: z.string(),
  }),
]);

export type FilePreview = z.infer<typeof FilePreviewSchema>;

/** 链接目标在磁盘上的类型;unknown = 读不到(权限等),界面按链接写法猜。 */
export const FileKindSchema = z.enum(["file", "directory", "missing", "unknown"]);
export type FileKind = z.infer<typeof FileKindSchema>;

/** 一次查询的路径上限:一段对话最近 120 条记录里链接到的文件。 */
export const MAX_STAT_PATHS = 200;

const ICON_BY_EXTENSION: Readonly<Record<string, string>> = {
  ...Object.fromEntries(["md", "markdown", "mdx", "txt", "rst", "log", "pdf", "doc", "docx", "rtf"].map((extension) => [extension, "FileText"])),
  ...Object.fromEntries(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "tif", "tiff", "heic"].map((extension) => [extension, "FileImage"])),
  ...Object.fromEntries(["json", "jsonl", "ndjson", "json5"].map((extension) => [extension, "FileJson"])),
  ...Object.fromEntries(["yaml", "yml", "toml", "ini", "conf", "cfg", "env", "properties", "plist", "lock"].map((extension) => [extension, "FileCog"])),
  ...Object.fromEntries(["csv", "tsv", "xls", "xlsx", "parquet"].map((extension) => [extension, "FileSpreadsheet"])),
  ...Object.fromEntries(["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar", "zst"].map((extension) => [extension, "FileArchive"])),
  ...Object.fromEntries(["sh", "bash", "zsh", "fish", "ps1", "bat", "cmd"].map((extension) => [extension, "FileTerminal"])),
  ...Object.fromEntries([
    "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "py", "go", "rs", "java", "kt", "kts", "swift", "c", "h", "cc", "cpp",
    "hpp", "cs", "rb", "php", "lua", "dart", "scala", "sql", "html", "htm", "css", "scss", "less", "vue", "svelte", "xml",
    "diff", "patch", "proto", "graphql", "gradle", "r", "m", "zig", "nix", "tf",
  ].map((extension) => [extension, "FileCode"])),
};

/** 药丸与目录列表的 Lucide 图标:目录、不存在,或按扩展名区分的文件。 */
export function fileIconName(extension: string, kind: FileKind | "guess-directory"): string {
  if (kind === "directory" || kind === "guess-directory") return "Folder";
  if (kind === "missing") return "FileX";
  return ICON_BY_EXTENSION[extension] ?? "File";
}

/** Markdown 文件按 Markdown 渲染,其余文本放进代码块。 */
export const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdx", "mdown", "mkd"]);

const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  mjs: "javascript",
  cjs: "javascript",
  js: "javascript",
  jsx: "jsx",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  py: "python",
  rb: "ruby",
  rs: "rust",
  kt: "kotlin",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yml: "yaml",
  h: "c",
  hpp: "cpp",
  cc: "cpp",
  cs: "csharp",
  patch: "diff",
  txt: "",
  log: "",
};

const FILENAME_LANGUAGES: Readonly<Record<string, string>> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
};

/** 代码块的语言标记;认不出时为空(纯文本)。 */
export function codeLanguage(name: string, extension: string): string {
  const byName = FILENAME_LANGUAGES[name.toLowerCase()];
  if (byName !== undefined) return byName;
  if (!extension) return "";
  return LANGUAGE_ALIASES[extension] ?? (/^[a-z0-9+#-]{1,16}$/.test(extension) ? extension : "");
}

/** 把文本包成代码块:围栏比正文里最长的反引号串多一个,正文里的 ``` 不会提前收尾。 */
export function fenceCode(text: string, language: string): string {
  let longest = 0;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${text.replace(/\n$/, "")}\n${fence}`;
}

/** 定位到行号时显示的片段:目标行前留 10 行,目标范围后再多显示 40 行。 */
export function excerptLines(text: string, lineStart: number, lineEnd = lineStart): { text: string; from: number; to: number; total: number } | null {
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  if (lineStart < 1 || lineStart > lines.length) return null;
  const from = Math.max(1, lineStart - 10);
  const to = Math.min(lines.length, Math.max(lineEnd, lineStart) + 40);
  if (from === 1 && to === lines.length) return null;
  return { text: lines.slice(from - 1, to).join("\n"), from, to, total: lines.length };
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
