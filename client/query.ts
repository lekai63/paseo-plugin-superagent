import { useEffect, useRef, useState } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { usePaseo, useRpc, useSubscription } from "@getpaseo/plugin/client";
import type { PaseoAgent } from "@getpaseo/client";
import type { RpcInput } from "@getpaseo/plugin";
import { superagentPiModesRpc, superagentStateEventsSubscription, superagentStateRpc } from "../shared/rpc";
import type { SuperagentSnapshot } from "../shared/model";
import type { ExecutionAgent } from "../shared/execution";

/** 操作后按此前缀失效;具体快照再按宿主隔离。 */
export const STATE_QUERY_KEY = ["superagent", "state"] as const;

/** 没有实时推送时(旧版 app、订阅断开)的轮询间隔。 */
export const STATE_POLL_MS = 3000;
/** 推送在线时的兜底轮询:只刷新不推送的字段(如程序看门狗时间)。 */
export const STATE_LIVE_POLL_MS = 30_000;
/** 订阅被关闭(插件重载、daemon 重启)后隔多久重新订阅;期间按 STATE_POLL_MS 轮询。 */
export const STATE_RESUBSCRIBE_MS = 5000;

type StateRevisionListener = (revision: string) => void;

/**
 * 订阅 superagent.state_events,返回推送是否在线。宿主的 useSubscription 在订阅关闭后
 * 不会自动重订(只在输入变化时重订),这里换一个 attempt 值重新订阅。
 */
function useLiveStateEvents(onRevision: StateRevisionListener): boolean {
  const [attempt, setAttempt] = useState(0);
  const state = useSubscription(superagentStateEventsSubscription, { attempt }, (event) => onRevision(event.revision));
  const ended = state.status === "closed" || state.status === "error";
  useEffect(() => {
    if (!ended) return;
    const timer = setTimeout(() => setAttempt((value) => value + 1), STATE_RESUBSCRIBE_MS);
    return () => clearTimeout(timer);
  }, [ended, attempt]);
  return state.status === "live";
}

function usePolledStateEvents(): boolean {
  return false;
}

/**
 * 0.16 之前的 app 没有 useSubscription(宿主提供的 SDK 模块里取不到):退回轮询。
 * 模块加载时就定下用哪个实现,同一组件每次渲染调用的 hook 不变。
 */
const useStateEvents: (onRevision: StateRevisionListener) => boolean =
  typeof useSubscription === "function" ? useLiveStateEvents : usePolledStateEvents;

export function useSuperagentState(hostId: string, input: RpcInput<typeof superagentStateRpc> = {}, enabled = true) {
  const fetchState = useRpc(superagentStateRpc);
  const queryClient = useQueryClient();
  const queryKey = [...STATE_QUERY_KEY, hostId, input] as const;
  const keyRef = useRef(queryKey);
  keyRef.current = queryKey;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const live = useStateEvents((revision) => {
    try {
      if (!enabledRef.current) return;
      const key = keyRef.current;
      // 缓存已是推送的版本(刚读过)就不重读;旧 daemon 的快照不带版本,一律重读。
      if (queryClient.getQueryData<SuperagentSnapshot>(key)?.revision === revision) return;
      void queryClient.invalidateQueries({ queryKey: key, exact: true });
    } catch (error) {
      // 推送回调在宿主的消息分发里运行,抛错会被当作未捕获异常;宁可丢一次刷新(下次轮询补上)。
      console.warn("[superagent] state event handler failed", error);
    }
  });
  return useQuery({
    queryKey,
    queryFn: () => fetchState(input),
    refetchInterval: live ? STATE_LIVE_POLL_MS : STATE_POLL_MS,
    enabled,
  });
}

/** 设置页的模型选择候选:与引擎启动校验同源的 daemon provider 快照。 */
export interface ProviderSnapshotEntry {
  provider: string;
  status: string;
  enabled?: boolean;
  label?: string;
  models?: ReadonlyArray<{
    id: string;
    label?: string;
    isDefault?: boolean;
    thinkingOptions?: ReadonlyArray<{ id: string; label?: string; description?: string; isDefault?: boolean }> | null;
  }> | null;
  modes?: ReadonlyArray<{ id: string; label: string; description?: string }> | null;
}

/** wire 模式 compact 快照的模型条目:thinking 选项收进共享的 thinkingSets,模型只带索引。 */
interface CompactSnapshotModel {
  id: string;
  label?: string;
  isDefault?: boolean;
  thinkingSet?: number;
}

interface CompactSnapshot {
  entries: ReadonlyArray<Omit<ProviderSnapshotEntry, "models"> & { models?: ReadonlyArray<CompactSnapshotModel> | null }>;
  thinkingSets?: ReadonlyArray<{
    options: ReadonlyArray<{ id: string; label?: string; description?: string; isDefault?: boolean }>;
    defaultOptionId?: string;
  }>;
}

type SnapshotModel = NonNullable<ProviderSnapshotEntry["models"]>[number];

/**
 * 把 wire 模式 compact 快照归一成展开形态:模型引用的 thinkingSet 索引还原成
 * thinkingOptions(与 @getpaseo/protocol 的 expandProviderSnapshot 同构,只搬本插件用到的字段)。
 * thinkingSet 索引越界时保守地视为未上报(不抛错,选择器退化为保存值 + 手工输入)。
 */
export function expandCompactSnapshot(snapshot: CompactSnapshot): ProviderSnapshotEntry[] {
  const sets = snapshot.thinkingSets ?? [];
  return snapshot.entries.map((entry): ProviderSnapshotEntry => {
    if (!entry.models) return entry;
    return {
      ...entry,
      models: entry.models.map((model): SnapshotModel => {
        if (model.thinkingSet === undefined) return model;
        const set = sets[model.thinkingSet];
        if (!set) return { ...model, thinkingOptions: null };
        return { ...model, thinkingOptions: set.options.map((option) => ({ ...option })) };
      }),
    };
  });
}

/**
 * 读取 daemon 的 provider 快照(含每个 provider 的 model 清单),供设置页下拉选择。
 * 快照不可用(旧 daemon、连接异常)时调用方回退为手工输入;列表较稳,缓存一分钟。
 *
 * App 宿主共享给插件的连接以 wire 模式取快照:`entries` 为空数组,内容在
 * `compactSnapshot.entries` 里(宿主自家 UI 自行展开)。compact 条目保留了
 * provider/status/enabled/label 与模型清单,但模型的 thinkingOptions 被收进共享的
 * `compactSnapshot.thinkingSets`、模型上只剩 `thinkingSet` 索引,这里就地展开归一成
 * 同一种形状(wire 客户端也可用 compactSnapshot.thinkingSets 还原,本地连接直接拿到
 * 展开形态),思考档位选择器依赖它;取不到时选择器退化为保存值 + 手工输入,不在插件层拦截。
 * wire 模式下 SDK 的 waitForReady 看到的 entries 恒为空、不会等待发现,故自行按 status 轮询。
 */
export function useProviderSnapshot(hostId: string) {
  const paseo = usePaseo();
  return useQuery({
    queryKey: ["superagent", "providers", hostId],
    queryFn: async (): Promise<ProviderSnapshotEntry[]> => {
      const read = async () => {
        const payload = await paseo.providers.snapshot();
        return payload.entries.length > 0
          ? ([...payload.entries] as ProviderSnapshotEntry[])
          : (payload.compactSnapshot ? expandCompactSnapshot(payload.compactSnapshot as CompactSnapshot) : []);
      };
      let entries = await read();
      for (let attempt = 0; attempt < 6 && entries.some((entry) => entry.status === "loading"); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        entries = await read();
      }
      return entries;
    },
    staleTime: 60_000,
    retry: 1,
  });
}

/**
 * pi 的权限模式候选:来自 daemon 主机上的 pi-permission-modes 扩展。
 * provider 选 pi 时设置页用它替代 provider 快照(pi 上报的模式清单恒为空);
 * 读不到时调用方回退「Paseo 默认」。
 */
export function usePiPermissionModes(hostId: string) {
  const fetchModes = useRpc(superagentPiModesRpc);
  return useQuery({
    queryKey: ["superagent", "pi-modes", hostId],
    queryFn: () => fetchModes({}),
    staleTime: 60_000,
    retry: 1,
  });
}

export interface AgentObservation {
  agent?: ExecutionAgent | null;
  loading: boolean;
  error: boolean;
}

/** 按可见 Ticket 的精确 ID 读取会话,不扫描项目、所有工作区或会话时间线。 */
export function useExecutionAgents(hostId: string, agentIds: string[]): Record<string, AgentObservation> {
  const paseo = usePaseo();
  const client = useQueryClient();
  const ids = [...new Set(agentIds)].sort();
  const key = JSON.stringify(ids);
  useEffect(() => {
    const scope = new Set<string>(JSON.parse(key));
    if (!scope.size) return;
    const prefix = ["superagent", "agent", hostId];
    // 订阅回调运行在宿主的消息分发上下文里,不在 React 边界内:任何抛错都会被宿主当作
    // 未捕获异常直接终止 app(0.15.0 iOS 实测闪退)。这里只做缓存写入,宁可丢一次更新。
    const off = paseo.agents.subscribe((update) => {
      try {
        const id = update.kind === "upsert" ? update.agent?.id : update.agentId;
        if (!id || !scope.has(id)) return;
        client.setQueryData<PaseoAgent | null>([...prefix, id], update.kind === "upsert" ? update.agent : null);
      } catch (error) {
        console.warn("[superagent] agent update handler failed", error);
      }
    });
    const events = paseo.observeEvents(["agent_permission_request", "agent_permission_resolved", "agent_attention_required"]);
    events.subscribe({
      snapshot() {},
      update(message) {
        try {
          if (message.type !== "agent_permission_request" && message.type !== "agent_permission_resolved" && message.type !== "agent_attention_required") return;
          const id = message.payload?.agentId;
          if (id && scope.has(id)) void client.invalidateQueries({ queryKey: [...prefix, id] });
        } catch (error) {
          console.warn("[superagent] event handler failed", error);
        }
      },
    });
    // 定时读取也负责断线恢复和未打开原生会话时的状态更新。
    void events.ready.catch(() => {});
    return () => {
      off();
      void events.release().catch(() => {});
    };
  }, [paseo, client, hostId, key]);

  const queries = useQueries({
    queries: ids.map((id) => ({
      queryKey: ["superagent", "agent", hostId, id],
      queryFn: async () => (await paseo.agents.ref(id).refresh())?.agent ?? null,
      staleTime: 2000,
      refetchInterval: 5000,
      retry: 1,
    })),
  });
  return Object.fromEntries(ids.map((id, index) => [id, {
    agent: queries[index].data,
    loading: queries[index].isPending,
    error: queries[index].isError,
  }]));
}
