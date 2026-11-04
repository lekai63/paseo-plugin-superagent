import { View } from "react-native";
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { Loading, ScrollView } from "@getpaseo/plugin/client/ui";
import { ExecutionView } from "./execution-view";
import { useSuperagentState } from "./query";
import { Button, Notice, space } from "./ui";

export function ExecutionPanel(props: PluginWorkspacePanelProps & {
  openChat(input?: { threadId?: string }): void;
}) {
  const query = useSuperagentState(props.host.id);
  if (query.isPending) return <Loading />;
  return (
    <ScrollView style={{ flex: 1, backgroundColor: props.theme.colors.surface0 }} contentContainerStyle={{ padding: space.md, gap: space.md }}>
      {query.isError ? <Notice theme={props.theme} tone="warning" title={query.data ? "状态刷新失败，当前显示上一次的数据" : "无法读取执行状态"}
        description={query.error instanceof Error ? query.error.message : String(query.error)}>
        <Button theme={props.theme} label="重试" size="xs" onPress={() => void query.refetch()} />
      </Notice> : null}
      <View>
        {query.data ? <ExecutionView snapshot={query.data} theme={props.theme} hostId={props.host.id} navigation={props.navigation}
          compact={props.layout.compact} workspaceId={props.workspaceId} onDetails={props.openChat} /> : null}
      </View>
    </ScrollView>
  );
}
