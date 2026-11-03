import assert from "node:assert/strict";
import test from "node:test";
import { splitImReply } from "../server/im-replies.ts";
import { RouterVerdictSchema } from "../shared/model.ts";

const body = (part) => part.replace(/^\[\d+\/\d+\] /, "");

test("short replies stay unchanged and long replies preserve all text within the numbered limit", () => {
  assert.deepEqual(splitImReply("简短答复", 100), ["简短答复"]);
  assert.deepEqual(splitImReply("", 100), []);
  for (const text of ["a".repeat(100), "a".repeat(101), "中文\n".repeat(1200), "x".repeat(12000)]) {
    const parts = splitImReply(text, 100);
    assert.equal(parts.map(body).join(""), text);
    parts.forEach((part, index) => {
      assert.ok(part.length <= 100);
      if (parts.length > 1) assert.ok(part.startsWith(`[${index + 1}/${parts.length}] `));
    });
  }
});

test("paragraphs and newlines are preferred without dropping whitespace or splitting emoji", () => {
  const emoji = "👩🏽‍💻";
  const text = `第一段\n\n${emoji.repeat(18)}\r\n末段\n`;
  const parts = splitImReply(text, 100).map(body);
  assert.equal(parts[0], "第一段\n\n");
  assert.equal(parts.join(""), text);
  const boundaries = new Set([...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)]
    .map((item) => item.index + item.segment.length));
  let offset = 0;
  for (const part of parts) { offset += part.length; assert.ok(boundaries.has(offset)); }
});

test("pathologically long graphemes still fit the limit and never produce lone surrogates", () => {
  const text = `😀${"\u0301".repeat(300)}`;
  const parts = splitImReply(text, 100);
  assert.equal(parts.map(body).join(""), text);
  for (const part of parts) { assert.ok(part.length <= 100); assert.ok(part.isWellFormed()); }
});

test("Router verdicts accept full replies beyond the former 2000 character limit", () => {
  const text = "完整长答复".repeat(900);
  const verdict = RouterVerdictSchema.parse({ actions: [{ action: "reply", reply: text }] });
  assert.equal(verdict.actions[0].reply, text);
});
