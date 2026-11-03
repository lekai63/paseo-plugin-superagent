import { View } from "react-native";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { SettingsSection } from "@getpaseo/plugin/client/ui";
import { DispatchCard } from "./dispatch-card";
import { ExecutionView } from "./execution-view";
import { useSuperagentState } from "./query";
import { ScreenLayout, StateFeedback } from "./screen-layout";
import { Button, Notice, space } from "./ui";

export { STATE_QUERY_KEY } from "./query";

export interface SuperagentScreenProps extends PluginScreenProps {
  openSettings(): void;
  openHistory(input?: { threadId?: string; ticketId?: string }): void;
  openStatus(): void;
}

/** 新任务始终在前,主区域留给当前 Router → Worker 调用。 */
export function SuperagentScreen(props: SuperagentScreenProps) {
  const { theme, layout, navigation, openSettings, openHistory, openStatus } = props;
  const query = useSuperagentState(props.host.id);
  const snapshot = query.data;
  const disabledReason = !snapshot ? query.isError ? "状态不可用，请先重试" : "正在读取配置"
    : !snapshot.configured ? "先在设置里填写工作目录"
    : snapshot.workingDirIssue ? "工作目录不可用,Worker 暂时无法启动" : null;
  return (
    <ScreenLayout {...props} wide>
      <SettingsSection title="新任务" trailing={
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }}>
          <Button theme={theme} variant="ghost" size="xs" icon="History" label="历史消息" onPress={() => openHistory()} />
          <Button theme={theme} variant="ghost" size="xs" icon="Activity" label="运行状态" onPress={openStatus} />
          <Button theme={theme} variant="ghost" size="xs" icon="Settings" accessibilityLabel="设置" onPress={openSettings} />
        </View>
      }>
        <DispatchCard theme={theme} disabledReason={disabledReason} />
      </SettingsSection>

      <StateFeedback query={query} theme={theme} />
      {snapshot?.configured && snapshot.workingDirIssue ? (
        <Notice theme={theme} tone="danger" title="Worker 无法启动" description={snapshot.workingDirIssue}>
          <Button theme={theme} variant="outline" size="xs" label="打开设置" onPress={openSettings} />
        </Notice>
      ) : snapshot && !snapshot.configured ? (
        <Notice theme={theme} tone="warning" title="先设置工作目录，即可派发任务">
          <Button theme={theme} variant="outline" size="xs" label="打开设置" onPress={openSettings} />
        </Notice>
      ) : null}

      {snapshot ? <SettingsSection title="调用情况">
        <ExecutionView snapshot={snapshot} theme={theme} hostId={props.host.id} navigation={navigation}
          compact={layout.compact} onDetails={openHistory} />
      </SettingsSection> : null}
    </ScreenLayout>
  );
}
