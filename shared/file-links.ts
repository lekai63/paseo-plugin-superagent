/**
 * Router 答复里的文件链接。宿主的 Markdown 在插件页面里没有文件链接上下文,点击
 * `[\`name\`](/abs/path)` 不会有反应;对话页把这里认出的文件列在答复下方,点开走插件
 * 自己的预览(server/file-preview.ts)。
 *
 * 只认指向绝对路径的行内链接:`/…`、`~/…`、`file://…`、Windows 盘符。代码块与行内代码里的
 * 链接文本不算;相对路径、网址、锚点不算。路径末尾的行号(`:12`、`:12-20`、`#L12-L20`)
 * 拆出来,用于预览定位。
 */

export interface FileLink {
  /** 去掉行号后的路径(`file://` 已转成本地路径,百分号编码已解码)。 */
  path: string;
  /** 链接文字(去掉反引号);为空时取文件名。 */
  label: string;
  lineStart?: number;
  lineEnd?: number;
  /** 以 `/` 结尾:按目录列出。 */
  directory: boolean;
}

/** 一条答复最多列出的文件数;更多的链接只在正文里出现。 */
export const MAX_FILE_LINKS = 12;

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
// [文字](<目标> "标题") 或 [文字](目标 "标题");目标里允许一层成对括号。
const LINK = /!?\[((?:[^\[\]\\]|\\.)*)\]\(\s*(<[^<>\n]*>|(?:[^\s()\\]|\\.|\([^\s()]*\))+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;

export function extractFileLinks(markdown: string, limit = MAX_FILE_LINKS): FileLink[] {
  const masked = maskCode(markdown);
  const seen = new Set<string>();
  const links: FileLink[] = [];
  for (const match of masked.matchAll(LINK)) {
    if (match[0].startsWith("!")) continue;
    const start = match.index ?? 0;
    // 文字从原文取(行内代码在掩码里被抹掉了);目标在掩码前后相同,因为代码里的链接整段被抹掉。
    const original = markdown.slice(start, start + match[0].length);
    const text = original.slice(1, 1 + match[1].length);
    const target = parseFileTarget(match[2]);
    if (!target) continue;
    const key = `${target.path}#${target.lineStart ?? ""}-${target.lineEnd ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ ...target, label: linkLabel(text, target.path) });
    if (links.length >= limit) break;
  }
  return links;
}

/** 链接目标 → 本地文件;不是绝对路径时为 null。 */
export function parseFileTarget(raw: string): Omit<FileLink, "label"> | null {
  let target = raw.trim();
  if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1).trim();
  target = target.replace(/\\([!-/:-@[-`{-~])/g, "$1");
  if (/^file:/i.test(target)) {
    target = target.replace(/^file:(\/\/(localhost)?)?/i, "");
    if (/^\/[A-Za-z]:\//.test(target)) target = target.slice(1);
  } else if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) && !/^[A-Za-z]:[\\/]/.test(target)) {
    return null;
  }
  try {
    target = decodeURI(target);
  } catch {
    // 不是合法的百分号编码:按原样当路径。
  }

  let lineStart: number | undefined;
  let lineEnd: number | undefined;
  const hashLine = /#L(\d+)(?:C\d+)?(?:-L?(\d+)(?:C\d+)?)?$/i.exec(target);
  const colonLine = hashLine ? null : /:(\d+)(?::\d+)?(?:-(\d+)(?::\d+)?)?$/.exec(target);
  const line = hashLine ?? colonLine;
  if (line) {
    target = target.slice(0, line.index);
    lineStart = Number(line[1]);
    lineEnd = line[2] ? Number(line[2]) : undefined;
  } else {
    target = target.replace(/[?#].*$/, "");
  }

  if (!isAbsoluteLike(target)) return null;
  const directory = /[\\/]$/.test(target) && target.length > 1;
  const path = directory ? target.replace(/[\\/]+$/, "") : target;
  if (!path || path === "~") return null;
  return {
    path,
    directory,
    ...(lineStart && lineStart > 0 ? { lineStart } : {}),
    ...(lineStart && lineEnd && lineEnd >= lineStart ? { lineEnd } : {}),
  };
}

export function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return index >= 0 ? trimmed.slice(index + 1) || trimmed : trimmed;
}

export function extensionOf(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** 行号后缀,如「:12」「:12-20」。 */
export function lineSuffix(link: Pick<FileLink, "lineStart" | "lineEnd">): string {
  if (!link.lineStart) return "";
  return link.lineEnd && link.lineEnd !== link.lineStart ? `:${link.lineStart}-${link.lineEnd}` : `:${link.lineStart}`;
}

function isAbsoluteLike(path: string): boolean {
  return path.startsWith("/") || path.startsWith("~/") || /^[A-Za-z]:[\\/]/.test(path);
}

function linkLabel(text: string, path: string): string {
  const label = text.replace(/\\(.)/g, "$1").replace(/`+/g, "").replace(/\s+/g, " ").trim();
  return label || basename(path);
}

/** 代码块与行内代码换成等长空白,下标保持不变,其中的 `[x](/y)` 不再被认成链接。 */
function maskCode(markdown: string): string {
  const lines = markdown.split("\n");
  let fence: string | null = null;
  const out = lines.map((line) => {
    const open = FENCE.exec(line);
    if (fence) {
      if (open && open[1][0] === fence[0] && open[1].length >= fence.length && !line.slice(open[0].length).trim()) fence = null;
      return blank(line);
    }
    if (open) {
      fence = open[1];
      return blank(line);
    }
    return line;
  });
  return maskInlineCode(out.join("\n"));
}

function maskInlineCode(text: string): string {
  let result = "";
  let index = 0;
  while (index < text.length) {
    const tick = text.indexOf("`", index);
    if (tick < 0) break;
    let run = tick;
    while (text[run] === "`") run++;
    const ticks = text.slice(tick, run);
    const close = findClosingTicks(text, run, ticks.length);
    if (close < 0) {
      result += text.slice(index, run);
      index = run;
      continue;
    }
    result += text.slice(index, run) + blank(text.slice(run, close)) + ticks;
    index = close + ticks.length;
  }
  return result + text.slice(index);
}

function findClosingTicks(text: string, from: number, length: number): number {
  let index = from;
  while (index < text.length) {
    const tick = text.indexOf("`", index);
    if (tick < 0) return -1;
    let run = tick;
    while (text[run] === "`") run++;
    if (run - tick === length) return tick;
    index = run;
  }
  return -1;
}

function blank(text: string): string {
  return text.replace(/[^\n]/g, " ");
}
