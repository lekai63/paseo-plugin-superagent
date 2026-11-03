import type { ReactNode } from "react";
import { View } from "react-native";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { Loading, ScrollView } from "@getpaseo/plugin/client/ui";
import { useSuperagentState } from "./query";
import { Button, MAX_CONTENT_WIDTH, Notice, space } from "./ui";

export function ScreenLayout({ theme, layout, wide, children }: Pick<PluginScreenProps, "theme" | "layout"> & {
  wide?: boolean;
  children: ReactNode;
}) {
  const padding = layout.compact ? space.lg : space.xl;
  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{ padding, paddingBottom: padding + space.lg }} keyboardShouldPersistTaps="handled">
      <View style={{ width: "100%", maxWidth: wide ? 1120 : MAX_CONTENT_WIDTH, alignSelf: "center" }}>{children}</View>
    </ScrollView>
  );
}

export function StateFeedback({ query, theme }: {
  query: ReturnType<typeof useSuperagentState>;
  theme: PluginScreenProps["theme"];
}) {
  if (query.isPending && !query.data) return <Loading />;
  if (!query.isError) return null;
  return (
    <Notice theme={theme} tone={query.data ? "warning" : "danger"}
      title={query.data ? "状态刷新失败，当前显示上一次的数据" : "无法读取 Superagent 状态"}
      description={query.error instanceof Error ? query.error.message : String(query.error)}>
      <Button theme={theme} label="重试" size="xs" variant="outline" onPress={() => void query.refetch()} />
    </Notice>
  );
}
