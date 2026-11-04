/**
 * Paseo 的发送快捷键(Settings → General 的 sendShortcut,与界面字号同在 app settings JSON)。
 * 默认 "enter":Enter 发送、Shift+Enter 换行;"mod-enter" 时 Cmd/Ctrl+Enter 发送,裸 Enter 换行。
 * 语义对齐宿主 composer 的 resolveMessageInputEnterAction。
 */

export type HostSendShortcut = "enter" | "mod-enter";

export const DEFAULT_SEND_SHORTCUT: HostSendShortcut = "enter";

/** 一份 app settings JSON 里的 sendShortcut;缺失、非 JSON 或未知取值时为 null。 */
export function parseHostSendShortcut(raw: string | null | undefined): HostSendShortcut | null {
  if (!raw) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return null;
  const value = (decoded as Record<string, unknown>).sendShortcut;
  return value === "mod-enter" || value === "enter" ? value : null;
}

/** 宿主的读取顺序:当前键,其次旧键,都没有时默认 Enter 发送。 */
export function resolveHostSendShortcut(current: string | null | undefined, legacy: string | null | undefined): HostSendShortcut {
  return parseHostSendShortcut(current) ?? parseHostSendShortcut(legacy) ?? DEFAULT_SEND_SHORTCUT;
}
