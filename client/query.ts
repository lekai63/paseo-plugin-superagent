import { useEffect } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import type { PaseoAgent } from "@getpaseo/client";
import type { RpcInput } from "@getpaseo/plugin";
import { superagentStateRpc } from "../shared/rpc";
import type { ExecutionAgent } from "../shared/execution";

/** 操作后按此前缀失效;具体快照再按宿主隔离。 */
export const STATE_QUERY_KEY = ["superagent", "state"] as const;

export function useSuperagentState(hostId: string, input: RpcInput<typeof superagentStateRpc> = {}) {
  const fetchState = useRpc(superagentStateRpc);
  return useQuery({
    queryKey: [...STATE_QUERY_KEY, hostId, input],
    queryFn: () => fetchState(input),
    refetchInterval: 3000,
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
    const off = paseo.agents.subscribe((update) => {
      const id = update.kind === "upsert" ? update.agent.id : update.agentId;
      if (!scope.has(id)) return;
      client.setQueryData<PaseoAgent | null>([...prefix, id], update.kind === "upsert" ? update.agent : null);
    });
    const events = paseo.observeEvents(["agent_permission_request", "agent_permission_resolved", "agent_attention_required"]);
    events.subscribe({
      snapshot() {},
      update(message) {
        if (message.type !== "agent_permission_request" && message.type !== "agent_permission_resolved" && message.type !== "agent_attention_required") return;
        const id = message.payload.agentId;
        if (scope.has(id)) void client.invalidateQueries({ queryKey: [...prefix, id] });
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
