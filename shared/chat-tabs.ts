import { z } from "zod";

/**
 * 对话页顶部的标签:用户在界面里打开着的对话(线程)。
 * 只是「打开的视图」,关闭标签不关闭线程;IM / agent 委派产生的线程不会自动成为标签。
 * 标签列表与最后查看的标签存在 daemon 状态里,离开页面或重启 app 后回到同一对话。
 */

export const MAX_CHAT_TABS = 12;
/** 首次使用时自动打开的对话:最近一天内有活动的,最多几个。线程不会自动关闭,更早的留在「对话」列表里。 */
export const SEED_TAB_WINDOW_MS = 24 * 60 * 60 * 1000;
export const MAX_SEED_TABS = 4;

export const ChatTabsSchema = z.object({
  /** 打开顺序;新标签追加在末尾。 */
  open: z.array(z.string().min(1)).max(MAX_CHAT_TABS),
  /** 最后查看的对话;回到页面时直接进入它。 */
  last: z.string().min(1).nullable(),
});
export type ChatTabs = z.infer<typeof ChatTabsSchema>;

export const EMPTY_CHAT_TABS: ChatTabs = { open: [], last: null };

/** 打开(或聚焦)一个对话。activate=false 只加入标签栏,不改变最后查看的对话。 */
export function openChatTab(tabs: ChatTabs, threadId: string, activate = true): ChatTabs {
  let open = tabs.open.includes(threadId) ? tabs.open : [...tabs.open, threadId];
  // 超出上限时丢弃最早打开、且不是当前要打开或最后查看的标签。
  while (open.length > MAX_CHAT_TABS) {
    const drop = open.find((id) => id !== threadId && id !== tabs.last) ?? open[0];
    open = open.filter((id) => id !== drop);
  }
  const last = activate ? threadId : tabs.last;
  return open === tabs.open && last === tabs.last ? tabs : { open, last };
}

/**
 * 关闭一个标签,并给出关闭后应显示的对话:关的是当前标签时取右侧邻居,没有就取左侧,
 * 都没有时为 null(新对话);关的不是当前标签时保持当前。
 */
export function closeChatTab(tabs: ChatTabs, threadId: string, activeId: string | null): { tabs: ChatTabs; next: string | null } {
  const index = tabs.open.indexOf(threadId);
  if (index < 0) return { tabs, next: activeId === threadId ? tabs.open.at(-1) ?? null : activeId };
  const open = tabs.open.filter((id) => id !== threadId);
  const next = activeId === threadId ? open[index] ?? open[index - 1] ?? null : activeId;
  const last = tabs.last === threadId ? next ?? open.at(-1) ?? null : tabs.last;
  return { tabs: { open, last }, next };
}

/** 进入对话页(没有指定线程)时显示哪段对话:最后查看的,其次最后打开的,都没有时新对话。 */
export function entryChatTab(tabs: ChatTabs): string | null {
  if (tabs.last && tabs.open.includes(tabs.last)) return tabs.last;
  return tabs.open.at(-1) ?? null;
}

/** 去掉已不存在的线程(已关闭线程超出保留上限会被清理)。 */
export function pruneChatTabs(tabs: ChatTabs, threadIds: ReadonlySet<string>): ChatTabs {
  const open = tabs.open.filter((id) => threadIds.has(id));
  const last = tabs.last && threadIds.has(tabs.last) ? tabs.last : null;
  return open.length === tabs.open.length && last === tabs.last ? tabs : { open, last };
}

/**
 * 从未保存过标签时的初始标签:在界面里发起(手动触发、发送者为 user)、仍进行中且最近一天内
 * 有活动的对话,取最近的几个,按创建时间排列;最后查看的取最近更新的一段。
 */
export function defaultChatTabs(
  threads: readonly { id: string; state: string; createdAt: string; updatedAt: string }[],
  triggers: readonly { threadId?: string | null; kind: string; sender: string; receivedAt: string }[],
  now: number = Date.now(),
): ChatTabs {
  const first = new Map<string, { kind: string; sender: string; receivedAt: string }>();
  for (const trigger of triggers) {
    if (!trigger.threadId) continue;
    const seen = first.get(trigger.threadId);
    if (!seen || trigger.receivedAt < seen.receivedAt) first.set(trigger.threadId, trigger);
  }
  const since = now - SEED_TAB_WINDOW_MS;
  const recent = threads
    .filter((thread) => {
      const origin = first.get(thread.id);
      return thread.state === "active" && origin?.kind === "manual" && origin.sender === "user" && Date.parse(thread.updatedAt) >= since;
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, MAX_SEED_TABS);
  const open = [...recent].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((thread) => thread.id);
  return { open, last: recent[0]?.id ?? null };
}

export function sameChatTabs(a: ChatTabs, b: ChatTabs): boolean {
  return a.last === b.last && a.open.length === b.open.length && a.open.every((id, index) => id === b.open[index]);
}
