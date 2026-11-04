/**
 * Paseo 界面字号(Settings → Appearance 的 uiBaseFontSize)。宿主给插件的 theme 不带字号,
 * 与 better-paseo 一样只读宿主持久化的 app settings:当前键缺失或损坏时退回旧键。
 * 宿主按 uiBaseFontSize / 14 等比缩放自己的字号刻度并四舍五入,这里同样换算。
 */

export const APP_SETTINGS_KEY = "@paseo:app-settings";
export const LEGACY_SETTINGS_KEY = "@paseo:settings";

/** 宿主 `use-settings/storage.ts` 的取值范围;刻度以 14 为基准(`FONT_SIZE.base`)。 */
export const HOST_UI_FONT_SIZE = { min: 10, max: 21, base: 14 } as const;

/** 用户从未设置时宿主的界面字号:Web 14,iOS/Android 15。 */
export function defaultUiFontSize(platform: string): number {
  return platform === "web" ? 14 : 15;
}

/** 一份 app settings JSON 里的界面字号(取整并夹在 10–21);缺失、非 JSON 或非对象时为 null。 */
export function parseUiBaseFontSize(raw: string | null | undefined): number | null {
  if (!raw) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return null;
  const value = (decoded as Record<string, unknown>).uiBaseFontSize;
  const numeric = typeof value === "number" ? value
    : typeof value === "string" && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(numeric)) return null;
  return Math.min(HOST_UI_FONT_SIZE.max, Math.max(HOST_UI_FONT_SIZE.min, Math.floor(numeric)));
}

/** 宿主的读取顺序:当前键,其次旧键,都没有时用平台默认。 */
export function resolveUiFontSize(current: string | null | undefined, legacy: string | null | undefined, platform: string): number {
  return parseUiBaseFontSize(current) ?? parseUiBaseFontSize(legacy) ?? defaultUiFontSize(platform);
}

/** 把以 14 为基准写的字号换算到用户的界面字号,与宿主的 `Math.round(size * ui / 14)` 一致。 */
export function scaleFontSize(size: number, uiFontSize: number): number {
  return Math.round(size * (uiFontSize / HOST_UI_FONT_SIZE.base));
}
