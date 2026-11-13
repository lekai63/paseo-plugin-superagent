import type { TriggerOrigin } from "./model";

/** IM 日界线沿用插件文件归档的北京时间,与 daemon 所在时区无关。 */
export function imDay(at: Date): string {
  return new Date(at.getTime() + 8 * 60 * 60_000).toISOString().slice(0, 10);
}

export function imConversationKey(origin: TriggerOrigin): string {
  return JSON.stringify([origin.channel, origin.accountId ?? "", origin.chatId]);
}

export function dailyImThreadKey(conversation: string, day: string): string {
  return `im:${day}:${conversation}`;
}
