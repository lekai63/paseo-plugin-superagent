import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useRpc } from "@getpaseo/plugin/client";
import { EMPTY_CHAT_TABS, sameChatTabs, type ChatTabs } from "../shared/chat-tabs";
import { superagentSaveChatTabsRpc } from "../shared/rpc";

/**
 * 对话页标签的本机副本,按宿主分开,存活于整个 app 会话(离开 Superagent 页面再回来不丢)。
 * 首次拿到快照时用 daemon 保存的标签初始化,并写回 daemon:种子(defaultChatTabs 播种的
 * 近期对话)也落盘,两端从第一次打开页面起就是同一份。之后本机变更 300ms 防抖写回;
 * 本机没有未确认写回的改动时采纳快照里的新值,其他设备的改动随 3 秒轮询近实时同步。
 */

type Save = (tabs: ChatTabs) => Promise<{ ok: boolean; error?: string | null }>;

interface HostTabs {
  tabs: ChatTabs | null;
  timer: ReturnType<typeof setTimeout> | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  /** 本地有还没在 daemon 里确认的改动(防抖中、写回中或写回失败待重试),此时不采纳远端标签。 */
  dirty: boolean;
  failures: number;
}

const SAVE_DELAY_MS = 300;
/** 写回失败后的重试间隔与上限;连续超过上限就放弃这份本地改动,恢复采纳远端,避免两端永久卡死。 */
const RETRY_DELAY_MS = 2000;
const MAX_SAVE_FAILURES = 3;
const hosts = new Map<string, HostTabs>();
const listeners = new Set<() => void>();

function entry(hostId: string): HostTabs {
  let item = hosts.get(hostId);
  if (!item) {
    item = { tabs: null, timer: null, retryTimer: null, dirty: false, failures: 0 };
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

function clearRetry(item: HostTabs) {
  if (item.retryTimer !== null) clearTimeout(item.retryTimer);
  item.retryTimer = null;
}

function saveFailed(hostId: string, item: HostTabs, save: Save, error: unknown) {
  console.warn("[superagent] saving chat tabs failed", error ?? "unknown error");
  item.failures += 1;
  if (item.failures < MAX_SAVE_FAILURES) {
    clearRetry(item);
    item.retryTimer = setTimeout(() => {
      item.retryTimer = null;
      // 已有新的变更在防抖就不再抢:那份变更稍后会带上最新的标签一起写回。
      if (item.timer === null) persist(hostId, save);
    }, RETRY_DELAY_MS);
    return;
  }
  // 重试用尽:这份本地改动无法落盘,放弃它并恢复采纳远端,下次变更重新走完整写回。
  item.failures = 0;
  item.dirty = false;
}

function persist(hostId: string, save: Save) {
  const item = entry(hostId);
  if (item.timer !== null) clearTimeout(item.timer);
  item.dirty = true;
  item.timer = setTimeout(() => {
    item.timer = null;
    const sent = item.tabs;
    if (!sent) return;
    void save(sent).then((result) => {
      if (result.ok) {
        item.failures = 0;
        clearRetry(item);
        // 写回期间本地又变了就保持 dirty:那份更新的变更还没进 daemon,由它自己的写回负责。
        if (item.tabs && sameChatTabs(item.tabs, sent)) item.dirty = false;
        return;
      }
      saveFailed(hostId, item, save, result.error ?? result);
    }, (error: unknown) => saveFailed(hostId, item, save, error));
  }, SAVE_DELAY_MS);
}

/**
 * 当前宿主的标签;快照到达前为 null。`saved` 是快照里 daemon 保存的标签,`failed` 表示
 * 快照读取失败,此时以空标签继续,不让对话页一直停在加载中。
 */
export function useChatTabs(hostId: string, saved: ChatTabs | null | undefined, loaded: boolean, failed: boolean) {
  const tabs = useSyncExternalStore(subscribe, () => entry(hostId).tabs, () => entry(hostId).tabs);
  const save = useRpc(superagentSaveChatTabsRpc);
  useEffect(() => {
    const item = entry(hostId);
    if (!item.tabs) {
      // 快照没到、失败也没判定前不初始化,否则 daemon 保存的标签会被一份空列表顶掉。
      if (!loaded && !failed) return;
      item.tabs = saved ?? EMPTY_CHAT_TABS;
      emit();
      // 首个快照写回 daemon:种子与已保存值一样进状态,两端看到并保存的是同一份。
      if (saved) persist(hostId, save);
      return;
    }
    // 已初始化且没有未确认的本地改动:采纳其他设备写入的新标签(快照 3 秒一轮)。
    if (saved && !item.dirty && !sameChatTabs(item.tabs, saved)) {
      item.tabs = saved;
      emit();
    }
  }, [hostId, saved, loaded, failed, save]);

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
