import { useState } from "react";
import { Pressable, Text, View, type NativeSyntheticEvent, type TextInputKeyPressEventData } from "react-native";
import type { PluginHostProps } from "@getpaseo/plugin/client";
import { Icon, TextInput } from "@getpaseo/plugin/client/ui";
import type { Tone } from "../shared/labels";
import { TYPE, mix } from "../shared/design";
import type { ChatMetrics } from "./chat-messages";
import { readWebSendShortcut } from "./web";
import { HAIRLINE, WEB_TRANSITION, chatTokens, radius, space, type Theme } from "./theme-tokens";
import { toneColor, withAlpha } from "./ui";

const MAX_INPUT_HEIGHT = 200;
/** 每个标签各自的未发送草稿;切换标签不会把一段对话里写了一半的话带到另一段。 */
const drafts = new Map<string, string>();

type WebKeyPressEvent = NativeSyntheticEvent<TextInputKeyPressEventData & {
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  /** 输入法组字中(中文/日文等)按下的回车只确认候选词,不能发送。 */
  isComposing?: boolean;
  keyCode?: number;
}>;

export interface ComposerHint {
  icon: string;
  label: string;
  tone?: Tone;
}

/**
 * 对话输入框:停靠在消息流下方,外观对齐 Paseo 的 composer(圆角 16 的卡片、细线描边、
 * 右下角圆形发送键);输入文字与用户气泡同为宿主正文字号 × 1.4,宽度与消息列一致。桌面 Web 的发送键跟随 Paseo 全局设置(Settings → General 的
 * sendShortcut):默认 Enter 发送、Shift+Enter 换行;设为 Cmd/Ctrl+Enter 后裸 Enter 换行。
 * 组字中的回车不发送。草稿按 draftKey 保存在本次 app 会话里;调用方切换对话时应以
 * draftKey 作为 key 重新挂载。
 */
export function ChatComposer({
  theme,
  layout,
  metrics,
  placeholder,
  hint,
  disabledReason,
  draftKey,
  onSubmit,
}: {
  theme: Theme;
  layout: PluginHostProps["layout"];
  metrics: ChatMetrics;
  placeholder: string;
  hint: ComposerHint;
  /** 有值时禁止发送并在提示位说明原因。 */
  disabledReason: string | null;
  /** 草稿归属(宿主 + 对话);同一 key 再次挂载时恢复未发送的内容。 */
  draftKey: string;
  /** 返回 false 表示发送失败,输入内容会恢复。 */
  onSubmit(text: string): Promise<boolean>;
}) {
  const [text, setTextState] = useState(() => drafts.get(draftKey) ?? "");
  const setText = (next: string | ((current: string) => string)) => setTextState((current) => {
    const value = typeof next === "function" ? next(current) : next;
    if (value) drafts.set(draftKey, value);
    else drafts.delete(draftKey);
    return value;
  });
  const [busy, setBusy] = useState(false);
  const [focused, setFocused] = useState(false);
  const [contentHeight, setContentHeight] = useState(0);
  const web = layout.platform === "web";
  const enterToSend = web && !layout.compact;
  // 桌面 Web 默认留出两行,原生一行加一点余量(正文 15/21 时分别是 46 与 30)。
  const minHeight = web ? metrics.bubble.lineHeight * 2 + 4 : metrics.bubble.lineHeight + 9;
  const height = Math.min(MAX_INPUT_HEIGHT, Math.max(minHeight, contentHeight));
  const canSend = Boolean(text.trim()) && !busy && !disabledReason;

  const send = async () => {
    const value = text.trim();
    if (!value || busy || disabledReason) return;
    setBusy(true);
    setText("");
    try {
      // 发送失败时恢复原文;期间又输入了新内容就不覆盖。
      if (!(await onSubmit(value))) setText((current) => current || value);
    } finally {
      setBusy(false);
    }
  };

  const onKeyPress = (event: WebKeyPressEvent) => {
    const native = event.nativeEvent;
    if (native.key !== "Enter" || native.isComposing || native.keyCode === 229) return;
    // 与宿主 composer 的 resolveMessageInputEnterAction 一致:Shift+Enter 总是换行;
    // 发送键跟随宿主全局设置,每次按键现读,改设置后立即生效。
    if (native.shiftKey) return;
    const sendKey = readWebSendShortcut();
    if (sendKey === "mod-enter" && !native.metaKey && !native.ctrlKey) return;
    event.preventDefault();
    void send();
  };

  const status = disabledReason ? { icon: "TriangleAlert", label: disabledReason, tone: "warning" as Tone } : hint;
  const statusColor = status.tone && status.tone !== "default" ? toneColor(status.tone, theme) : theme.colors.foregroundMuted;
  // 文本镜像:与输入框同宽同字号的隐藏 Text 量出内容高度,输入框随内容增高、删除后回缩。
  const mirror = !text ? " " : text.endsWith("\n") ? `${text} ` : text;
  const inputFont = { fontSize: metrics.bubble.size, lineHeight: metrics.bubble.lineHeight };
  const tokens = chatTokens(theme);

  return (
    <View style={{ paddingHorizontal: layout.compact ? space.md : space.lg, paddingBottom: layout.compact ? space.md : space.lg, alignItems: "center" }}>
      <View
        style={{
          width: "100%",
          maxWidth: metrics.maxWidth,
          gap: layout.compact ? space.sm : space.md,
          paddingTop: layout.compact ? space.sm + 2 : space.md + 2,
          paddingBottom: layout.compact ? space.sm : space.sm + 2,
          paddingHorizontal: layout.compact ? space.md : space.lg,
          borderRadius: radius.bubble,
          borderWidth: HAIRLINE,
          borderColor: focused ? mix(theme.colors.border, theme.colors.foregroundMuted, 0.5) : tokens.card.pillBorder,
          backgroundColor: theme.colors.surface1,
          ...WEB_TRANSITION,
          ...(focused ? tokens.card.shadowHover : tokens.card.shadow),
        }}
      >
        <View>
          <Text
            aria-hidden
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            pointerEvents="none"
            selectable={false}
            onLayout={(event) => setContentHeight(event.nativeEvent.layout.height)}
            style={{ position: "absolute", left: 0, right: 0, top: 0, opacity: 0, ...inputFont }}
          >
            {mirror}
          </Text>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder={placeholder}
            placeholderTextColor={withAlpha(theme.colors.foregroundMuted, 0.75)}
            accessibilityLabel="发送给 Superagent 的消息"
            multiline
            scrollEnabled={contentHeight > MAX_INPUT_HEIGHT}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyPress={enterToSend ? onKeyPress : undefined}
            style={{
              height,
              padding: 0,
              margin: 0,
              color: theme.colors.foreground,
              textAlignVertical: "top",
              ...inputFont,
              ...(web ? { outlineStyle: "none" } as object : {}),
            }}
          />
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.md }}>
          <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: space.xs + 2 }}>
            <Icon name={status.icon} size={13} color={statusColor} />
            <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, color: statusColor, fontSize: TYPE.caption.size, lineHeight: TYPE.caption.lineHeight }}>
              {status.label}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="发送"
            accessibilityState={{ disabled: !canSend }}
            disabled={!canSend}
            hitSlop={6}
            onPress={() => void send()}
            style={({ pressed }) => ({
              width: 28,
              height: 28,
              borderRadius: 14,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: canSend ? theme.colors.accent : tokens.pressed,
              opacity: pressed ? 0.85 : 1,
              ...WEB_TRANSITION,
            })}
          >
            <Icon name="ArrowUp" size={16} color={canSend ? theme.colors.accentForeground : theme.colors.foregroundMuted} />
          </Pressable>
        </View>
      </View>
    </View>
  );
}
