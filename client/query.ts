import { useEffect } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import type { PaseoAgent } from "@getpaseo/client";
import type { RpcInput } from "@getpaseo/plugin";
import { superagentStateRpc } from "../shared/rpc";
import { ROUTER_AGENT_LABEL, ROUTER_AGENT_LABEL_VALUE } from "../shared/model";
import type { ExecutionAgent } from "../shared/execution";

/** 操作后按此前缀失效;具体快照再按宿主隔离。 */
export const STATE_QUERY_KEY = ["superagent", "state"] as const;

export function useSuperagentState(hostId: string, input: RpcInput<typeof superagentStateRpc> = {}, enabled = true) {
  const fetchState = useRpc(superagentStateRpc);
  return useQuery({
    queryKey: [...STATE_QUERY_KEY, hostId, input],
    queryFn: () => fetchState(input),
    refetchInterval: 3000,
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

/**
 * 枚举 daemon 里全部 Router 会话(按创建时打上的标签过滤,不扫全部 agent)。
 * 引擎只记住一个 id,但状态重置后旧 Router 会残留——多个并存时状态点要带数字。
 * 快照里记住的 id 兜底并入:标签枚举异常时至少能显示当前 Router 的状态。
 */
export function useRouterAgents(hostId: string, routerAgentId: string | null | undefined, enabled: boolean) {
  const paseo = usePaseo();
  return useQuery({
    queryKey: ["superagent", "routers", hostId, routerAgentId ?? null],
    queryFn: async (): Promise<PaseoAgent[]> => {
      const listed = await paseo.agents.list({ filter: { includeBackground: true, labels: { [ROUTER_AGENT_LABEL]: ROUTER_AGENT_LABEL_VALUE } } });
      const agents = listed.entries.map((entry) => entry.agent).filter((agent) => !agent.archivedAt);
      if (routerAgentId && !agents.some((agent) => agent.id === routerAgentId)) {
        const remembered = (await paseo.agents.ref(routerAgentId).refresh())?.agent ?? null;
        if (remembered && !remembered.archivedAt) agents.push(remembered);
      }
      return agents;
    },
    enabled,
    staleTime: 2000,
    refetchInterval: 5000,
    retry: 1,
  });
}
