/**
 * Paseo 外观设置(Settings → Appearance):界面字号 uiBaseFontSize、正文字号 contentFontSize
 * 与对话内容列宽度 contentMaxWidth。宿主给插件的 theme 不带这些,与 better-paseo 一样只读宿主
 * 持久化的 app settings:当前键缺失或损坏时退回旧键。宿主按 uiBaseFontSize / 14 等比缩放
 * 自己的界面字号刻度并四舍五入,这里同样换算;正文(对话气泡、Markdown)直接用 contentFontSize。
 */

export const APP_SETTINGS_KEY = "@paseo:app-settings";
export const LEGACY_SETTINGS_KEY = "@paseo:settings";

/** 宿主 `use-settings/storage.ts` 的取值范围;刻度以 14 为基准(`FONT_SIZE.base`)。 */
export const HOST_UI_FONT_SIZE = { min: 10, max: 21, base: 14 } as const;
export const HOST_CONTENT_FONT_SIZE = { min: 10, max: 21 } as const;
/** 对话与 Markdown 内容列的最大宽度;宿主存 null 表示默认 820。 */
export const HOST_CONTENT_MAX_WIDTH = { min: 600, max: 4000, default: 820 } as const;

/** 用户从未设置时宿主的界面字号:Web 14,iOS/Android 15。 */
export function defaultUiFontSize(platform: string): number {
  return platform === "web" ? 14 : 15;
}

/** 用户从未设置时宿主的正文字号:Web 15,iOS/Android 16。 */
export function defaultContentFontSize(platform: string): number {
  return platform === "web" ? 15 : 16;
}

/** 宿主 `parseClampedFontSize`:数字或数字字符串,取整后夹在范围内;其他为 null。 */
function clampNumber(value: unknown, bounds: { min: number; max: number }): number | null {
  const numeric = typeof value === "number" ? value
    : typeof value === "string" && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(numeric)) return null;
  return Math.min(bounds.max, Math.max(bounds.min, Math.floor(numeric)));
}

/** 一份 app settings JSON 解析成对象;缺失、非 JSON 或非对象时为 null。 */
function parseSettingsObject(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return null;
  return decoded as Record<string, unknown>;
}

/** 一份 app settings JSON 里的界面字号(取整并夹在 10–21);缺失、非 JSON 或非对象时为 null。 */
export function parseUiBaseFontSize(raw: string | null | undefined): number | null {
  const record = parseSettingsObject(raw);
  return record ? clampNumber(record.uiBaseFontSize, HOST_UI_FONT_SIZE) : null;
}

/** 宿主的读取顺序:当前键,其次旧键,都没有时用平台默认。 */
export function resolveUiFontSize(current: string | null | undefined, legacy: string | null | undefined, platform: string): number {
  return parseUiBaseFontSize(current) ?? parseUiBaseFontSize(legacy) ?? defaultUiFontSize(platform);
}

/** 插件排版用到的宿主外观。 */
export interface HostAppearance {
  /** 界面字号,控件与侧栏按它等比缩放。 */
  uiFontSize: number;
  /** 正文字号:对话气泡、输入框与宿主 Markdown 都用它。 */
  contentFontSize: number;
  /** 对话内容列最大宽度。 */
  contentMaxWidth: number;
}

export function defaultHostAppearance(platform: string): HostAppearance {
  return {
    uiFontSize: defaultUiFontSize(platform),
    contentFontSize: defaultContentFontSize(platform),
    contentMaxWidth: HOST_CONTENT_MAX_WIDTH.default,
  };
}

/**
 * 与宿主 `storage.ts` 同样解读外观:先取当前键,当前键缺失或损坏时取旧键;都没有就是平台默认。
 * 宿主迁移旧数据时正文字号缺失就沿用界面字号,这里同样处理。
 */
export function resolveHostAppearance(current: string | null | undefined, legacy: string | null | undefined, platform: string): HostAppearance {
  const record = parseSettingsObject(current) ?? parseSettingsObject(legacy);
  const defaults = defaultHostAppearance(platform);
  if (!record) return defaults;
  const uiFontSize = clampNumber(record.uiBaseFontSize, HOST_UI_FONT_SIZE) ?? defaults.uiFontSize;
  const contentFontSize = record.contentFontSize === undefined
    ? uiFontSize
    : clampNumber(record.contentFontSize, HOST_CONTENT_FONT_SIZE) ?? defaults.contentFontSize;
  const contentMaxWidth = clampNumber(record.contentMaxWidth, HOST_CONTENT_MAX_WIDTH) ?? defaults.contentMaxWidth;
  return { uiFontSize, contentFontSize, contentMaxWidth };
}

export function sameHostAppearance(a: HostAppearance, b: HostAppearance): boolean {
  return a.uiFontSize === b.uiFontSize && a.contentFontSize === b.contentFontSize && a.contentMaxWidth === b.contentMaxWidth;
}

/** 把以 14 为基准写的字号换算到用户的界面字号,与宿主的 `Math.round(size * ui / 14)` 一致。 */
export function scaleFontSize(size: number, uiFontSize: number): number {
  return Math.round(size * (uiFontSize / HOST_UI_FONT_SIZE.base));
}
