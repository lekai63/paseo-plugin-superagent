import assert from "node:assert/strict";
import test from "node:test";
import { TYPE, bubbleStep, contrastRatio, even, isDarkColor, mix, proseScale, readableOn, withAlpha } from "../shared/design.ts";
import { defaultHostAppearance, resolveHostAppearance, sameHostAppearance } from "../shared/host-font.ts";
import { fullStamp, stampTime } from "../shared/labels.ts";

test("reading text follows the host content size on better-paseo's 1.5 grid", () => {
  assert.equal(even(22.5), 22);
  assert.equal(even(23), 24);
  assert.deepEqual(proseScale(15), {
    body: { size: 15, lineHeight: 22 },
    secondary: { size: 14, lineHeight: 20 },
    small: { size: 13, lineHeight: 18 },
  });
  assert.deepEqual(proseScale(16).body, { size: 16, lineHeight: 24 });
  // 气泡与输入框和宿主自己的气泡一致:正文 × 1.4。
  assert.deepEqual(bubbleStep(15), { size: 15, lineHeight: 21 });
  assert.deepEqual(bubbleStep(18), { size: 18, lineHeight: 25 });
});

test("interface text never drops below 12 and always pairs a size with a line height", () => {
  for (const [name, step] of Object.entries(TYPE)) {
    assert.ok(step.size >= 12, `${name} is at least 12`);
    assert.ok(step.lineHeight > step.size, `${name} has leading`);
  }
  // 会换行的说明比同字号的单行标签多给行距。
  assert.ok(TYPE.labelRead.lineHeight > TYPE.label.lineHeight);
  assert.ok(TYPE.captionRead.lineHeight > TYPE.caption.lineHeight);
});

test("colours are mixed from the theme, never invented", () => {
  assert.equal(mix("#000000", "#ffffff", 0), "#000000");
  assert.equal(mix("#000000", "#ffffff", 0.5), "#808080");
  assert.equal(mix("#fff", "#000", 0.1), "#e6e6e6");
  assert.equal(mix("not-a-colour", "#000000", 0.5), "not-a-colour");
  assert.equal(mix("rgb(255, 0, 0)", "#0000ff", 1), "#0000ff");
  assert.equal(withAlpha("#ff0000", 0.5), "rgba(255, 0, 0, 0.5)");
  assert.equal(withAlpha("#ff000080", 0.5), "rgba(255, 0, 0, 0.251)");
  assert.equal(withAlpha("var(--x)", 0.5), "var(--x)");
  assert.equal(isDarkColor("#18181b"), true);
  assert.equal(isDarkColor("#ffffff"), false);
});

test("hue text is pulled toward the foreground until it reads at 4.5:1", () => {
  const ground = "#ffffff";
  const amber = "#eab308";
  assert.ok(contrastRatio(amber, ground) < 4.5);
  const text = readableOn(amber, [ground], "#111111");
  assert.ok(contrastRatio(text, ground) >= 4.5);
  assert.notEqual(text, "#111111", "stops as soon as it reads, keeping the hue");
  assert.equal(readableOn("#111111", [ground], "#000000"), "#111111");
});

test("host appearance follows Paseo's own read order and bounds", () => {
  assert.deepEqual(defaultHostAppearance("web"), { uiFontSize: 14, contentFontSize: 15, contentMaxWidth: 820 });
  assert.deepEqual(defaultHostAppearance("ios"), { uiFontSize: 15, contentFontSize: 16, contentMaxWidth: 820 });
  assert.deepEqual(resolveHostAppearance(null, null, "web"), defaultHostAppearance("web"));
  assert.deepEqual(
    resolveHostAppearance(JSON.stringify({ uiBaseFontSize: 16, contentFontSize: "17.6", contentMaxWidth: 1200 }), null, "web"),
    { uiFontSize: 16, contentFontSize: 17, contentMaxWidth: 1200 },
  );
  // 当前键损坏时退回旧键;旧数据没有正文字号时沿用界面字号(宿主迁移同样处理)。
  assert.deepEqual(resolveHostAppearance("{bad", JSON.stringify({ uiBaseFontSize: 13 }), "android"),
    { uiFontSize: 13, contentFontSize: 13, contentMaxWidth: 820 });
  // 越界夹紧;null 宽度表示默认;非法正文字号回到平台默认。
  assert.deepEqual(resolveHostAppearance(JSON.stringify({ uiBaseFontSize: 40, contentFontSize: 2, contentMaxWidth: 99999 }), null, "web"),
    { uiFontSize: 21, contentFontSize: 10, contentMaxWidth: 4000 });
  assert.deepEqual(resolveHostAppearance(JSON.stringify({ contentFontSize: "big", contentMaxWidth: null }), null, "ios"),
    { uiFontSize: 15, contentFontSize: 16, contentMaxWidth: 820 });
  assert.equal(sameHostAppearance(defaultHostAppearance("web"), resolveHostAppearance(null, null, "web")), true);
});

test("timeline stamps drop today's date and the current year", () => {
  const now = new Date(2026, 10, 6, 18, 30).getTime();
  assert.equal(stampTime(new Date(2026, 10, 6, 9, 5).toISOString(), now), "09:05");
  assert.equal(stampTime(new Date(2026, 9, 31, 23, 59).toISOString(), now), "10月31日 23:59");
  assert.equal(stampTime(new Date(2025, 0, 2, 7, 0).toISOString(), now), "2025年1月2日 07:00");
  assert.equal(stampTime("", now), "");
  assert.equal(stampTime("garbage", now), "");
  assert.equal(fullStamp(new Date(2026, 10, 6, 9, 5, 7).toISOString()), "2026-11-06 09:05:07");
});
