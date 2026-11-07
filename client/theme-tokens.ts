import { Platform, type ViewStyle } from "react-native";
import type { PluginHostProps } from "@getpaseo/plugin/client";
import { STATUS_DOT, isDarkColor, mix, readableOn } from "../shared/design";

/**
 * 由宿主 theme 推出的派生色与几何常量(取自 better-paseo 的 theme-tokens / cards/tokens)。
 * 宿主只给插件十来个颜色,行悬停、卡片、药丸、状态色洗都从这些颜色混出来,
 * 因此任何 Paseo 主题(含插件主题)下都保持同一套层次。
 */

export type Theme = PluginHostProps["theme"];

/** 间距刻度:宿主的 SPACING 档位;24 只用于分隔大区块。 */
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;

/**
 * 圆角:chip 4、块(行、代码、按钮)6、卡片 8、浮层 12、气泡 16 带 2 的尾角。
 * md / lg 是旧名,分别等于 block / card。
 */
export const radius = {
  chip: 4,
  md: 6,
  block: 6,
  lg: 8,
  card: 8,
  overlay: 12,
  bubble: 16,
  bubbleTail: 2,
  full: 999,
} as const;

/** 当前平台;只依赖 react-native 部分模块的环境(设置页测试)里可能没有 Platform。 */
const OS: string | undefined = Platform?.OS;
const WEB = OS === "web";

/** 细线:Web 上 1 个 CSS 像素,原生 0.5pt。 */
export const HAIRLINE = WEB ? 1 : 0.5;

/** 是否触屏优先(原生客户端一律按触屏;Web 交给 layout.compact 判断窄屏)。 */
export const TOUCH = OS !== undefined && !WEB;

/**
 * 对话里的一行(better-paseo `DISCLOSURE_HEADER`):桌面 26、触屏 28 高,触屏点按区扩到 44;
 * 左右各外扩 8 再内缩 8,让图标落在正文边线上;图标槽 16(含 2 的尾距)放 14 的图标,
 * 文字列从 24 开始,展开的正文、预览与错误行都对齐这一列。
 */
export const ROW = {
  height: { desktop: 26, touch: 28 },
  hit: 44,
  bleed: space.sm,
  paddingX: space.sm,
  gap: space.sm,
  iconSlot: 16,
  iconSlotPad: 2,
  icon: 14,
  textColumn: 16 + space.sm,
  /** 一串连续行之间的间距(宿主在条目间留 16,行收回 12)。 */
  stackGap: space.xs,
} as const;

export interface ChatTokens {
  isDark: boolean;
  /** 行悬停、展开正文:前景在页面上 2.5%(深色 3%)。 */
  hover: string;
  /** 行按下:前景 4.5%(深色 6%)。 */
  pressed: string;
  /** 行在静止(已结束)时的颜色:目标次要色、元信息与图标再往页面退一步。 */
  row: { target: string; targetActive: string; meta: string; icon: string; body: string; bodyText: string };
  /** Paseo 的 statusDot 色带。 */
  status: { running: string; warning: string; success: string; danger: string };
  card: CardTokens;
}

export interface CardTokens {
  /** 卡片表面:浅色主题 surface0,深色 surface2(Linear 式的抬起卡片)。 */
  background: string;
  border: string;
  /** 中性药丸填充与描边。 */
  pillFill: string;
  pillBorder: string;
  /** 中性按钮描边:比边框稍深,深色主题下多加一些以免消失。 */
  buttonBorder: string;
  /** 卡片内的悬停/按下底色。 */
  controlHover: string;
  /** 当前选中:强调色 7%(深色 10%)与边框向强调色 45%。 */
  current: string;
  currentBorder: string;
  /** 失败卡片:危险色 5%(深色 8%)与边框向危险色 35%(深色 40%)。 */
  failed: string;
  failedBorder: string;
  /** 需要处理(权限、待命):琥珀色洗。 */
  attention: string;
  attentionBorder: string;
  /** 卡片阴影:静止与悬停(Web 为 CSS box-shadow,原生为 RN 阴影)。 */
  shadow: ViewStyle;
  shadowHover: ViewStyle;
}

/** 状态色相的三件套:文字可读的前景、洗底、描边。 */
export interface HueTokens {
  text: string;
  wash: string;
  border: string;
}

function shadowStyle(isDark: boolean, hover: boolean): ViewStyle {
  const [y, blur, light, dark] = hover ? [2, 6, 0.14, 0.38] : [1, 2, 0.06, 0.18];
  const opacity = isDark ? dark : light;
  if (WEB) return { boxShadow: `0px ${y}px ${blur}px rgba(0, 0, 0, ${opacity})` } as ViewStyle;
  return { shadowColor: "#000000", shadowOffset: { width: 0, height: y }, shadowOpacity: opacity, shadowRadius: blur / 2, elevation: hover ? 2 : 1 };
}

function build(colors: Theme["colors"]): ChatTokens {
  const isDark = isDarkColor(colors.surface0);
  const fg = colors.foreground;
  const muted = colors.foregroundMuted;
  const page = colors.surface0;
  const status = isDark ? STATUS_DOT.dark : STATUS_DOT.light;
  const background = isDark ? colors.surface2 : colors.surface0;
  const warning = colors.statusWarning || status.warning;
  const danger = colors.statusDanger || status.danger;
  return {
    isDark,
    hover: mix(page, fg, isDark ? 0.03 : 0.025),
    pressed: mix(page, fg, isDark ? 0.06 : 0.045),
    row: {
      target: muted,
      targetActive: mix(muted, fg, 0.5),
      meta: mix(muted, page, 0.1),
      icon: mix(muted, page, 0.3),
      body: mix(colors.surface1, page, 0.3),
      bodyText: mix(fg, muted, 0.25),
    },
    status,
    card: {
      background,
      border: colors.border,
      pillFill: mix(background, fg, isDark ? 0.06 : 0.035),
      pillBorder: mix(colors.border, fg, isDark ? 0.08 : 0.05),
      buttonBorder: mix(colors.border, fg, isDark ? 0.2 : 0.05),
      controlHover: mix(background, fg, isDark ? 0.1 : 0.07),
      current: mix(background, colors.accent, isDark ? 0.1 : 0.07),
      currentBorder: mix(colors.border, colors.accent, 0.45),
      failed: mix(background, danger, isDark ? 0.08 : 0.05),
      failedBorder: mix(colors.border, danger, isDark ? 0.4 : 0.35),
      attention: mix(background, warning, isDark ? 0.08 : 0.06),
      attentionBorder: mix(colors.border, warning, isDark ? 0.45 : 0.4),
      shadow: shadowStyle(isDark, false),
      shadowHover: shadowStyle(isDark, true),
    },
  };
}

let cachedKey = "";
let cached: ChatTokens | null = null;

/** 当前主题的派生色;宿主每次渲染都会重建 theme 对象,这里按颜色值缓存。 */
export function chatTokens(theme: Theme): ChatTokens {
  const colors = theme.colors;
  const key = [colors.surface0, colors.surface1, colors.surface2, colors.border, colors.foreground, colors.foregroundMuted,
    colors.accent, colors.statusWarning, colors.statusDanger].join("|");
  if (cached && key === cachedKey) return cached;
  cachedKey = key;
  cached = build(colors);
  return cached;
}

/** 一个状态色相在给定表面上的文字色、洗底与描边(better-paseo 的按钮/药丸着色规则)。 */
export function hueTokens(theme: Theme, hue: string, surface: string): HueTokens {
  const isDark = chatTokens(theme).isDark;
  const wash = mix(surface, hue, isDark ? 0.16 : 0.1);
  return {
    text: readableOn(hue, [surface, wash], theme.colors.foreground),
    wash,
    border: mix(surface, hue, isDark ? 0.45 : 0.4),
  };
}

/** 交互元素在 Web 上的颜色/阴影过渡(120ms,不涉及位移)。 */
export const WEB_TRANSITION: ViewStyle = WEB
  ? ({ transitionProperty: "background-color, border-color, box-shadow, color, opacity", transitionDuration: "120ms", transitionTimingFunction: "ease-out" } as ViewStyle)
  : {};
