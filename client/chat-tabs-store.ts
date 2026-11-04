import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useRpc } from "@getpaseo/plugin/client";
import { EMPTY_CHAT_TABS, sameChatTabs, type ChatTabs } from "../shared/chat-tabs";
import { superagentSaveChatTabsRpc } from "../shared/rpc";

/**
 * 对话页标签的本机副本,按宿主分开,存活于整个 app 会话(离开 Superagent 页面再回来不丢)。
 * 首次拿到快照时用 daemon 保存的标签初始化;之后以本机为准,每次变更合并 300ms 后写回 daemon,
 * 下次启动 app 时恢复。其他设备的改动在下次启动时生效,运行中不互相覆盖界面。
 */

type Save = (tabs: ChatTabs) => Promise<{ ok: boolean; error?: string | null }>;

interface HostTabs {
  tabs: ChatTabs | null;
  timer: ReturnType<typeof setTimeout> | null;
}

const SAVE_DELAY_MS = 300;
const hosts = new Map<string, HostTabs>();
const listeners = new Set<() => void>();

function entry(hostId: string): HostTabs {
  let item = hosts.get(hostId);
  if (!item) {
    item = { tabs: null, timer: null };
    hosts.set(hostId, item);
  }
  return item;
}

function emit() {
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function persist(hostId: string, save: Save) {
  const item = entry(hostId);
  if (item.timer !== null) clearTimeout(item.timer);
  item.timer = setTimeout(() => {
    item.timer = null;
    if (!item.tabs) return;
    void save(item.tabs).then((result) => {
      if (!result.ok) console.warn("[superagent] saving chat tabs failed", result.error);
    }, (error: unknown) => console.warn("[superagent] saving chat tabs failed", error));
  }, SAVE_DELAY_MS);
}

/**
 * 当前宿主的标签;快照到达前为 null。`saved` 是快照里 daemon 保存的标签,`failed` 表示
 * 快照读取失败,此时以空标签继续,不让对话页一直停在加载中。
 */
export function useChatTabs(hostId: string, saved: ChatTabs | null | undefined, loaded: boolean, failed: boolean) {
  const tabs = useSyncExternalStore(subscribe, () => entry(hostId).tabs, () => entry(hostId).tabs);
  useEffect(() => {
    const item = entry(hostId);
    if (item.tabs || (!loaded && !failed)) return;
    item.tabs = saved ?? EMPTY_CHAT_TABS;
    emit();
  }, [hostId, saved, loaded, failed]);

  const save = useRpc(superagentSaveChatTabsRpc);
  const update = useCallback((change: (current: ChatTabs) => ChatTabs) => {
    const item = entry(hostId);
    // 初始化前不改:否则 daemon 保存的标签会被一份空列表覆盖。
    if (!item.tabs) return;
    const current = item.tabs;
    const next = change(current);
    if (sameChatTabs(current, next)) return;
    item.tabs = next;
    emit();
    persist(hostId, save);
  }, [hostId, save]);

  return { tabs, update };
}
