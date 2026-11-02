import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useRpc } from "@getpaseo/plugin/client";
import { TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { superagentDispatchRpc } from "../shared/rpc";
import { STATE_QUERY_KEY } from "./query";
import { Button, Card, Divider, fontSize, space, type Theme } from "./ui";

/** 新任务输入卡:手动 Trigger 的入口。标题可选,任务描述必填。 */
export function DispatchCard({ theme, disabledReason }: { theme: Theme; disabledReason: string | null }) {
  const [title, setTitle] = useState("");
  const [task, setTask] = useState("");
  const [busy, setBusy] = useState(false);
  const dispatch = useRpc(superagentDispatchRpc);
  const queryClient = useQueryClient();
  const toast = useToast();
  const canSubmit = Boolean(task.trim()) && !busy && !disabledReason;

  const submit = useCallback(async () => {
    const text = task.trim();
    if (!text || busy || disabledReason) return;
    setBusy(true);
    try {
      const result = await dispatch({ title: title.trim() || undefined, task: text });
      setTitle("");
      setTask("");
      void queryClient.invalidateQueries({ queryKey: STATE_QUERY_KEY });
      toast.show(result.directDelivered ? "已直接发给正在处理的 Worker" : "已提交,Router 正在评估", {
        variant: "success",
      });
    } catch (error) {
      toast.error(`派发失败:${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }, [busy, disabledReason, dispatch, queryClient, task, title, toast]);

  const inputStyle = {
    color: theme.colors.foreground,
    fontSize: fontSize.base,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  };

  return (
    <Card theme={theme}>
      <TextInput
        value={title}
        onChangeText={setTitle}
        placeholder="标题(可选,默认取任务首行)"
        placeholderTextColor={theme.colors.foregroundMuted}
        accessibilityLabel="任务标题"
        editable={!busy}
        style={inputStyle}
      />
      <Divider theme={theme} />
      <TextInput
        value={task}
        onChangeText={setTask}
        placeholder="描述要完成的任务,例如:修复登录页的 CORS 问题并补测试"
        placeholderTextColor={theme.colors.foregroundMuted}
        accessibilityLabel="任务描述"
        editable={!busy}
        multiline
        style={{ ...inputStyle, minHeight: 96, maxHeight: 280, textAlignVertical: "top", lineHeight: 20 }}
      />
      <Divider theme={theme} />
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: space.md,
          paddingHorizontal: space.lg,
          paddingVertical: space.sm,
        }}
      >
        <Text
          style={{
            flex: 1,
            color: disabledReason ? theme.colors.statusWarning : theme.colors.foregroundMuted,
            fontSize: fontSize.sm,
          }}
          numberOfLines={2}
        >
          {disabledReason ?? "也可以在任意 agent 会话里输入 /superagent <任务>"}
        </Text>
        <Button
          theme={theme}
          variant="primary"
          icon="SendHorizontal"
          label={busy ? "派发中..." : "派发"}
          disabled={!canSubmit}
          onPress={() => void submit()}
        />
      </View>
    </Card>
  );
}
