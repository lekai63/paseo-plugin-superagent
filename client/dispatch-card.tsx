import { useCallback, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginHostProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/ui";import { TextInput } from "@getpaseo/plugin/client/ui";
import { superagentDispatchRpc } from "../shared/rpc";
import { ActionChip } from "./thread-card";

/** 派发卡:新任务的入口(手动 Trigger)。 */
export function DispatchCard({ theme, layout }: PluginHostProps) {
  const [title, setTitle] = useState("");
  const [task, setTask] = useState("");
  const [busy, setBusy] = useState(false);
  const dispatch = useRpc(superagentDispatchRpc);
  const toast = useToast();
  const gap = layout.compact ? 8 : 12;

  const submit = useCallback(async () => {
    const text = task.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      const result = await dispatch({ title: title.trim() || undefined, task: text });
      setTitle("");
      setTask("");
      toast.show(result.directDelivered ? "已直通订阅的 Worker" : "已入队,Router 即将评估", {
        variant: "success",
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [busy, dispatch, task, title, toast]);

  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: theme.colors.foregroundMuted + "44",
        borderRadius: 10,
        padding: gap,
        gap: 8,
      }}
    >
      <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>派发任务</Text>
      <TextInput
        value={title}
        onChangeText={setTitle}
        placeholder="标题(可选)"
        placeholderTextColor={theme.colors.foregroundMuted}
        style={{ color: theme.colors.foreground, minHeight: 32 }}
      />
      <TextInput
        value={task}
        onChangeText={setTask}
        placeholder="任务描述,交给 Router 评估后派发 Worker…"
        placeholderTextColor={theme.colors.foregroundMuted}
        multiline
        style={{ color: theme.colors.foreground, minHeight: 64, textAlignVertical: "top" }}
      />
      <Pressable onPress={() => void submit()} disabled={busy || !task.trim()} hitSlop={6}>
        {({ pressed }) => (
          <View
            style={{
              alignSelf: "flex-start",
              paddingHorizontal: 14,
              paddingVertical: 7,
              borderRadius: 8,
              backgroundColor: theme.colors.foregroundMuted + (pressed || !task.trim() ? "22" : "44"),
            }}
          >
            <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>
              {busy ? "派发中…" : "提交给 Superagent"}
            </Text>
          </View>
        )}
      </Pressable>
    </View>
  );
}
