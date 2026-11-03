/** 完整答复按单条上限拆分;正文不删字,序号也计入上限。 */
export function splitImReply(text: string, maxChars: number): string[] {
  if (!Number.isInteger(maxChars) || maxChars < 16) throw new Error("IM message limit must be at least 16");
  if (!text) return [];
  if (text.length <= maxChars) return [text];
  let digits = 1;
  while (true) {
    const bodies = splitBodies(text, maxChars - (2 * digits + 4));
    const needed = String(bodies.length).length;
    if (needed > digits) { digits = needed; continue; }
    return bodies.map((body, index) => `[${index + 1}/${bodies.length}] ${body}`);
  }
}

function splitBodies(text: string, limit: number): string[] {
  const chunks: string[] = [];
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let offset = 0;
  while (offset < text.length) {
    let end = offset;
    for (const { segment } of segmenter.segment(text.slice(offset))) {
      if (end + segment.length > offset + limit) break;
      end += segment.length;
    }
    // 极长的组合字符也必须能前进;退回 Unicode code point 边界。
    if (end === offset) {
      end = Math.min(offset + limit, text.length);
      if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end])) end--;
    }
    if (end < text.length) {
      const window = text.slice(offset, end);
      const paragraph = window.lastIndexOf("\n\n");
      const newline = window.lastIndexOf("\n");
      if (paragraph >= 0) end = offset + paragraph + 2;
      else if (newline >= 0) end = offset + newline + 1;
      // CRLF 是一个字素,不可在换行偏好处再次拆开。
      if (text[end - 1] === "\r" && text[end] === "\n") end--;
    }
    chunks.push(text.slice(offset, end));
    offset = end;
  }
  return chunks;
}
