/**
 * 排版与配色的纯函数刻度,取自 better-paseo 的设计规范(docs/design.md「Foundations」),
 * 让 Superagent 对话页和装了 better-paseo 的 agent 会话读起来是同一套节奏:
 *
 * - 界面文字固定刻度(TYPE):标签 13/18、元信息 12/16、按钮 13/18、标题 16/22,不低于 12;
 * - 阅读文字从宿主正文字号 b 推出(proseScale):正文 b / 偶数(1.5b),次要 b−1,小字 b−2;
 * - 颜色只从宿主 theme 混出(mix),不发明新色;状态色用宿主 statusDot 色带。
 *
 * 不依赖 React Native,client 渲染与测试共用。
 */

/** 一个字号与它的行高。 */
export interface TypeStep {
  size: number;
  lineHeight: number;
}

/** 界面文字(固定,不随正文字号变化;最小 12)。 */
export const TYPE = {
  /** 行标签、动作动词、卡片内正文。 */
  label: { size: 13, lineHeight: 18 },
  /** 行尾元信息(时间、状态、用时),等宽数字。 */
  meta: { size: 12, lineHeight: 16 },
  /** 说明、时间戳、分组标题。 */
  caption: { size: 12, lineHeight: 16 },
  /** 按钮文字。 */
  button: { size: 13, lineHeight: 18 },
  /** 侧栏卡片与列表的主文字。 */
  body: { size: 14, lineHeight: 20 },
  /** 页面级标题。 */
  title: { size: 16, lineHeight: 22 },
  /** 大号数字(概览)。 */
  stat: { size: 20, lineHeight: 26 },
  /** 会换行的说明文字:同字号多给行距(better-paseo `smRead`),中文多行时不挤。 */
  captionRead: { size: 12, lineHeight: 18 },
  labelRead: { size: 13, lineHeight: 20 },
  bodyRead: { size: 14, lineHeight: 22 },
} as const satisfies Record<string, TypeStep>;

/** 最近的偶数:阅读行高落在 2px 网格上。 */
export function even(value: number): number {
  return 2 * Math.round(value / 2);
}

export interface ProseScale {
  body: TypeStep;
  /** 比正文低一档:Worker 汇报预览、思考类次要文字。 */
  secondary: TypeStep;
  /** 表格、行内代码等小字。 */
  small: TypeStep;
}

/** 从宿主正文字号推出阅读文字刻度。b = 15(Web)得 15/22、14/20、13/18;b = 16(原生)得 16/24、15/22、14/20。 */
export function proseScale(b: number): ProseScale {
  const base = Math.round(b);
  const body = { size: base, lineHeight: even(1.5 * base) };
  return {
    body,
    secondary: { size: base - 1, lineHeight: body.lineHeight - 2 },
    small: { size: base - 2, lineHeight: body.lineHeight - 4 },
  };
}

/** 用户气泡与输入框:与宿主自己的气泡一致,正文字号 × 1.4。 */
export function bubbleStep(b: number): TypeStep {
  const size = Math.round(b);
  return { size, lineHeight: Math.round(size * 1.4) };
}

// ---------------------------------------------------------------- colour

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export function parseColor(color: string): Rgba | null {
  const value = color.trim();
  if (value.startsWith("#")) {
    let hex = value.slice(1);
    if (hex.length === 3 || hex.length === 4) hex = [...hex].map((c) => c + c).join("");
    if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(hex)) return null;
    const channel = (i: number) => Number.parseInt(hex.slice(i, i + 2), 16);
    return { r: channel(0), g: channel(2), b: channel(4), a: hex.length === 8 ? channel(6) / 255 : 1 };
  }
  const body = /^rgba?\(([^)]+)\)$/i.exec(value)?.[1];
  if (!body) return null;
  const [r, g, b, a = 1] = body.split(/[\s,/]+/).filter(Boolean).map(Number);
  if (r === undefined || g === undefined || b === undefined) return null;
  if ([r, g, b, a].some(Number.isNaN)) return null;
  return { r, g, b, a };
}

/** 从 from 线性混向 to;t = 0 返回 from。任一颜色无法解析时原样返回 from。 */
export function mix(from: string, to: string, t: number): string {
  const a = parseColor(from);
  const b = parseColor(to);
  if (!a || !b) return from;
  const channel = (x: number, y: number) => Math.round(x + (y - x) * t).toString(16).padStart(2, "0");
  return `#${channel(a.r, b.r)}${channel(a.g, b.g)}${channel(a.b, b.b)}`;
}

/** color 叠加 alpha 透明度(与已有 alpha 相乘);无法解析时原样返回。 */
export function withAlpha(color: string, alpha: number): string {
  const rgba = parseColor(color);
  if (!rgba) return color;
  const a = Number((rgba.a * Math.min(1, Math.max(0, alpha))).toFixed(3));
  return `rgba(${rgba.r}, ${rgba.g}, ${rgba.b}, ${a})`;
}

/** 按亮度判断是否深色表面;无法解析时当作深色。 */
export function isDarkColor(color: string): boolean {
  const rgba = parseColor(color);
  if (!rgba) return true;
  return (0.299 * rgba.r + 0.587 * rgba.g + 0.114 * rgba.b) / 255 < 0.5;
}

function luminance(color: string): number {
  const rgba = parseColor(color) ?? { r: 0, g: 0, b: 0, a: 1 };
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgba.r) + 0.7152 * channel(rgba.g) + 0.0722 * channel(rgba.b);
}

/** WCAG 对比度。 */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * 把一个色相当作文字放在若干背景上:已达 min:1 对比度时不变,否则每次 5% 向 toward(前景色)
 * 靠拢直到可读。无法解析时原样返回。
 */
export function readableOn(hue: string, backgrounds: readonly string[], toward: string, min = 4.5): string {
  const start = mix(hue, hue, 0);
  const grounds = backgrounds.map((ground) => mix(ground, ground, 0)).filter((ground) => /^#[0-9a-f]{6}$/i.test(ground));
  if (!/^#[0-9a-f]{6}$/i.test(start) || grounds.length === 0) return hue;
  for (let step = 0; step <= 20; step++) {
    const color = step === 0 ? start : mix(start, toward, step / 20);
    if (grounds.every((ground) => contrastRatio(color, ground) >= min)) return color;
  }
  return mix(start, toward, 1);
}

/** Paseo 的 statusDot 色带(运行中、等待输入、完成、失败),按表面亮度在浅/深两套里选。 */
export const STATUS_DOT = {
  light: { running: "#268ae0", warning: "#b37824", success: "#299f51", danger: "#f12e2f" },
  dark: { running: "#5caaf6", warning: "#db932e", success: "#35c264", danger: "#f7796d" },
} as const;
