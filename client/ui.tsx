import { useEffect, useState, type ReactNode } from "react";
import { Modal as NativeModal, Pressable, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { Icon, Markdown, ScrollView, copyText, useToast } from "@getpaseo/plugin/client/ui";
import { TYPE, mix } from "../shared/design";
import { markdownPreview, type Tone } from "../shared/labels";
import { HAIRLINE, WEB_TRANSITION, chatTokens, hueTokens, radius, space, type Theme } from "./theme-tokens";

/**
 * 插件内复用的小型 UI 原语。宿主只向插件暴露 Settings* 系列与 Icon/Modal 等,按钮、药丸、
 * 卡片、提示条需要自己画。外观取自 better-paseo 的设计规范:描边按钮(细线、无底色,
 * 悬停只加深阴影)、细线药丸、带轻阴影的抬起卡片;颜色全部从宿主 theme 混出。
 */

export { HAIRLINE, radius, space, type Theme } from "./theme-tokens";
export { TYPE, withAlpha } from "../shared/design";

/** 旧刻度,设置页等仍在用;新代码优先用 TYPE(字号与行高成对)。 */
export const fontSize = { sm: 12, base: 14, stat: 20 } as const;

export function toneColor(tone: Tone, theme: Theme): string {
  switch (tone) {
    case "success":
      return theme.colors.statusSuccess;
    case "danger":
      return theme.colors.statusDanger;
    case "warning":
      return theme.colors.statusWarning;
    case "muted":
      return theme.colors.foregroundMuted;
    default:
      return theme.colors.foreground;
  }
}

/** 状态色点:用宿主 statusDot 色带(比文字状态色更亮,小点也压得住);中性为次要色。 */
export function toneDotColor(tone: Tone, theme: Theme): string {
  const status = chatTokens(theme).status;
  if (tone === "success") return status.success;
  if (tone === "warning") return status.warning;
  if (tone === "danger") return status.danger;
  return tone === "muted" ? mix(theme.colors.foregroundMuted, theme.colors.surface0, 0.3) : theme.colors.foregroundMuted;
}

// ---------------------------------------------------------------- Button

export type ButtonVariant = "primary" | "secondary" | "outline" | "ghost";

export interface ButtonProps {
  theme: Theme;
  label?: string;
  /** Lucide 图标名。 */
  icon?: string;
  onPress(): void;
  variant?: ButtonVariant;
  size?: "xs" | "sm";
  /** 危险操作:描边与文字用危险色;primary 用危险色填充。 */
  danger?: boolean;
  /** 上膛等需要强调的状态:铺一层色洗。 */
  emphasized?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
}

const BUTTON_HEIGHT = { xs: 28, sm: 32 } as const;

/**
 * 按钮(better-paseo「Buttons → Look」):
 * - outline:细线描边、无底色,文字为前景色、图标为次要色;悬停只加深阴影,按下铺一层浅底;
 * - secondary:同上再垫一层中性浅底,用于一组里的主操作;
 * - ghost:无边无底,悬停/按下才出现浅底;
 * - primary:强调色填充,只给真正的确认动作;
 * - danger:描边、文字与图标都换成危险色。
 */
export function Button({
  theme,
  label,
  icon,
  onPress,
  variant = "secondary",
  size = "sm",
  danger = false,
  emphasized = false,
  disabled = false,
  accessibilityLabel,
}: ButtonProps) {
  const [hovered, setHovered] = useState(false);
  const { colors } = theme;
  const tokens = chatTokens(theme);
  const height = BUTTON_HEIGHT[size];
  const filled = variant === "primary";
  const dangerHue = danger ? hueTokens(theme, colors.statusDanger, colors.surface0) : null;
  const type = size === "xs" ? { size: 12, lineHeight: 16 } : TYPE.button;

  let textColor: string = dangerHue?.text ?? colors.foreground;
  let iconColor: string = dangerHue?.text ?? colors.foregroundMuted;
  if (filled) textColor = iconColor = danger ? colors.surface0 : colors.accentForeground;
  else if (variant === "ghost" && !danger && !hovered) textColor = colors.foregroundMuted;
  if (variant === "ghost" && hovered && !danger) iconColor = colors.foreground;

  const bordered = variant === "outline" || variant === "secondary";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      hitSlop={4}
      style={({ pressed }) => {
        const active = (pressed || hovered) && !disabled;
        let backgroundColor = "transparent";
        if (filled) backgroundColor = danger ? colors.statusDanger : colors.accent;
        else if (emphasized && dangerHue) backgroundColor = dangerHue.wash;
        else if (variant === "secondary") backgroundColor = pressed ? tokens.pressed : tokens.hover;
        else if (variant === "ghost" && active) backgroundColor = pressed ? tokens.pressed : tokens.hover;
        else if (variant === "outline" && pressed) backgroundColor = tokens.hover;
        return {
          height,
          minWidth: height,
          paddingHorizontal: label ? (size === "xs" ? space.sm + 2 : space.md) : 0,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: space.xs + 2,
          borderRadius: radius.block,
          borderWidth: bordered || (danger && !filled && variant !== "ghost") ? HAIRLINE : 0,
          borderColor: dangerHue?.border ?? tokens.card.buttonBorder,
          backgroundColor,
          opacity: disabled ? 0.5 : filled && active ? 0.88 : 1,
          ...WEB_TRANSITION,
          ...(bordered && hovered && !disabled ? tokens.card.shadowHover : null),
        };
      }}
    >
      {icon ? <Icon name={icon} size={14} color={iconColor} /> : null}
      {label ? (
        <Text numberOfLines={1} style={{ color: textColor, fontSize: type.size, lineHeight: type.lineHeight, fontWeight: "500" }}>
          {label}
        </Text>
      ) : null}
    </Pressable>
  );
}

/**
 * 二次确认按钮:第一次点击只"上膛"(换成危险色描边与色洗,文案变成确认语),4 秒内再点才执行。
 * 对应宿主"红色只在用户表达意图后出现"的规则,也省掉一个确认弹窗。
 */
export function ConfirmButton({
  theme,
  label,
  confirmLabel,
  icon,
  onConfirm,
  size = "sm",
  variant = "outline",
  disabled,
  accessibilityLabel,
  onArmedChange,
}: {
  theme: Theme;
  /** 省略时为纯图标按钮,此时应给 accessibilityLabel。 */
  label?: string;
  confirmLabel: string;
  icon?: string;
  onConfirm(): void;
  size?: "xs" | "sm";
  /** 上膛前的样式;上膛后总是危险色。 */
  variant?: ButtonVariant;
  disabled?: boolean;
  accessibilityLabel?: string;
  /** 上膛与复位时通知外层,例如悬停才显示的按钮在上膛期间保持可见。 */
  onArmedChange?(armed: boolean): void;
}) {
  const [armed, setArmed] = useState(false);
  const arm = (value: boolean) => {
    setArmed(value);
    onArmedChange?.(value);
  };
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => arm(false), 4000);
    return () => clearTimeout(timer);
  }, [armed]);

  if (armed) {
    return (
      <Button
        theme={theme}
        variant="outline"
        danger
        emphasized
        size={size}
        icon="CircleAlert"
        label={confirmLabel}
        disabled={disabled}
        onPress={() => {
          arm(false);
          onConfirm();
        }}
      />
    );
  }
  return (
    <Button theme={theme} variant={variant} size={size} icon={icon} label={label} disabled={disabled}
      accessibilityLabel={accessibilityLabel} onPress={() => arm(true)} />
  );
}

// ---------------------------------------------------------------- Surfaces

export type CardState = "rest" | "current" | "failed" | "attention";

/** 抬起的卡片(better-paseo 任务卡):圆角 8、细线描边、轻阴影;状态改变底色与描边。 */
export function Card({ theme, children, style, state = "rest" }: {
  theme: Theme;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  state?: CardState;
}) {
  return <View style={[cardSurface(theme, state), { overflow: "hidden" }, style]}>{children}</View>;
}

export function cardSurface(theme: Theme, state: CardState = "rest"): ViewStyle {
  const card = chatTokens(theme).card;
  const fill = state === "current" ? card.current : state === "failed" ? card.failed : state === "attention" ? card.attention : card.background;
  const border = state === "current" ? card.currentBorder : state === "failed" ? card.failedBorder
    : state === "attention" ? card.attentionBorder : card.border;
  return { backgroundColor: fill, borderWidth: HAIRLINE, borderColor: border, borderRadius: radius.card, ...card.shadow };
}

/**
 * 状态药丸(better-paseo 卡片药丸):20 高、全圆角、细线描边。中性状态用中性浅底与次要色文字;
 * 成功/警告/危险用该色相的浅洗、描边与可读文字,前面带状态色点。
 */
export function StatusBadge({ theme, label, tone, dot = true }: { theme: Theme; label: string; tone: Tone; dot?: boolean }) {
  const tokens = chatTokens(theme);
  const hue = tone === "success" || tone === "warning" || tone === "danger" ? toneColor(tone, theme) : null;
  const surface = tokens.card.background;
  const tint = hue ? {
    fill: mix(surface, hue, tokens.isDark ? 0.16 : 0.1),
    border: mix(surface, hue, tokens.isDark ? 0.34 : 0.26),
    text: hueTokens(theme, hue, mix(surface, hue, tokens.isDark ? 0.16 : 0.1)).text,
  } : null;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.xs + 1,
        height: 20,
        paddingHorizontal: space.sm - 1,
        borderRadius: radius.full,
        borderWidth: HAIRLINE,
        borderColor: tint?.border ?? tokens.card.pillBorder,
        backgroundColor: tint?.fill ?? tokens.card.pillFill,
        flexShrink: 1,
        minWidth: 0,
      }}
    >
      {dot ? <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: toneDotColor(tone, theme) }} /> : null}
      <Text style={{ flexShrink: 1, color: tint?.text ?? theme.colors.foregroundMuted, fontSize: TYPE.caption.size, lineHeight: TYPE.caption.lineHeight }}
        numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

/** 页面级提示条:该色相的浅洗与描边,带色图标与标题,描述用次要色;操作放 children。 */
export function Notice({
  theme,
  tone,
  title,
  description,
  children,
}: {
  theme: Theme;
  tone: "warning" | "danger" | "default";
  title: string;
  description?: string | null;
  children?: ReactNode;
}) {
  const tokens = chatTokens(theme);
  const hue = tone === "default" ? null : toneColor(tone, theme);
  const surface = theme.colors.surface0;
  const fill = hue ? mix(surface, hue, tokens.isDark ? 0.08 : 0.06) : tokens.card.background;
  const color = hue ? hueTokens(theme, hue, fill).text : theme.colors.foreground;
  const icon = tone === "danger" ? "CircleAlert" : tone === "warning" ? "TriangleAlert" : "Info";
  return (
    <View
      accessibilityRole="alert"
      style={{
        flexDirection: "row",
        gap: space.sm + 2,
        paddingVertical: space.md,
        paddingHorizontal: space.md + 2,
        borderWidth: HAIRLINE,
        borderRadius: radius.card,
        borderColor: hue ? mix(theme.colors.border, hue, 0.35) : theme.colors.border,
        backgroundColor: fill,
      }}
    >
      <View style={{ height: TYPE.body.lineHeight, justifyContent: "center" }}>
        <Icon name={icon} size={16} color={color} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text style={{ color, fontSize: TYPE.body.size, lineHeight: TYPE.body.lineHeight, fontWeight: "600" }}>{title}</Text>
        {description ? (
          <Text selectable style={{ color: theme.colors.foregroundMuted, fontSize: TYPE.labelRead.size, lineHeight: TYPE.labelRead.lineHeight }}>
            {description}
          </Text>
        ) : null}
        {children ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginTop: space.sm }}>{children}</View>
        ) : null}
      </View>
    </View>
  );
}

/** 概览数字卡。 */
export function StatTile({
  theme,
  label,
  value,
  tone = "default",
  caption,
}: {
  theme: Theme;
  label: string;
  value: number;
  tone?: Tone;
  caption?: string | null;
}) {
  return (
    <Card theme={theme} style={{ flex: 1, minWidth: 0, paddingVertical: space.sm + 2, paddingHorizontal: space.md, gap: 2 }}>
      <Text style={{ color: tone === "default" ? theme.colors.foreground : toneColor(tone, theme), fontSize: TYPE.stat.size,
        lineHeight: TYPE.stat.lineHeight, fontWeight: "600", fontVariant: ["tabular-nums"] }}>{value}</Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: TYPE.caption.size, lineHeight: TYPE.caption.lineHeight }} numberOfLines={1}>
        {label}
        {caption ? <Text style={{ color: theme.colors.statusWarning }}>{` · ${caption}`}</Text> : null}
      </Text>
    </Card>
  );
}

/** 分组小标题(结构性标签:12/16、semibold、次要色)。 */
export function GroupLabel({ theme, children, trailing }: { theme: Theme; children: string; trailing?: ReactNode }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm, minHeight: 20 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: TYPE.caption.size, lineHeight: TYPE.caption.lineHeight, fontWeight: "600" }}>
        {children}
      </Text>
      {trailing}
    </View>
  );
}

/** 文字按钮(展开全部 / 收起 之类):13/18、medium、次要色,悬停变前景色。 */
export function TextButton({ theme, label, onPress, accessibilityLabel }: {
  theme: Theme;
  label: string;
  onPress(): void;
  accessibilityLabel?: string;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? label} hitSlop={6} onPress={onPress}
      onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)} style={{ alignSelf: "flex-start" }}>
      <Text style={{ color: hovered ? theme.colors.foreground : theme.colors.foregroundMuted, fontSize: TYPE.button.size,
        lineHeight: TYPE.button.lineHeight, fontWeight: "500" }}>{label}</Text>
    </Pressable>
  );
}

/**
 * 复制按钮(better-paseo 同款):24 的方框放 14 的图标,复制成功后 1.2 秒显示对勾并提示;
 * 失败只提示错误,不显示对勾。走宿主 copyText,各平台一致。
 */
export function CopyButton({ theme, text, label = "复制", touch = false }: {
  theme: Theme;
  text: string;
  /** 无障碍与提示里的说法,例如「复制消息」。 */
  label?: string;
  touch?: boolean;
}) {
  const toast = useToast();
  const tokens = chatTokens(theme);
  const [copied, setCopied] = useState(false);
  const [hovered, setHovered] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = () => {
    copyText(text).then(
      () => {
        setCopied(true);
        toast.show("已复制", { variant: "success" });
      },
      (error: unknown) => toast.error(`复制失败:${error instanceof Error ? error.message : String(error)}`),
    );
  };
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={copied ? "已复制" : label} hitSlop={touch ? 10 : 4} onPress={copy}
      onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)}
      style={({ pressed }) => ({ width: 24, height: 24, alignItems: "center", justifyContent: "center", borderRadius: radius.chip,
        backgroundColor: pressed ? tokens.pressed : hovered ? tokens.hover : "transparent", ...WEB_TRANSITION })}>
      <Icon name={copied ? "Check" : "Copy"} size={14}
        color={copied ? tokens.status.success : hovered ? theme.colors.foreground : theme.colors.foregroundMuted} />
    </Pressable>
  );
}

/**
 * 可展开的长文本:默认截断到 N 行,超长时给出"展开全部"。
 * markdown=true 时展开后用宿主 Markdown 渲染(Worker 汇报、Router 答复通常是 Markdown)。
 */
export function ExpandableText({
  theme,
  text,
  lines = 3,
  color,
  markdown = false,
}: {
  theme: Theme;
  text: string;
  lines?: number;
  color?: string;
  markdown?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const trimmed = text.trim();
  const long = trimmed.length > lines * 64 || trimmed.split("\n").length > lines;
  const toggle = long ? (
    <View style={{ marginTop: space.xs }}>
      <TextButton theme={theme} label={open ? "收起" : "展开全部"} onPress={() => setOpen((value) => !value)} />
    </View>
  ) : null;

  if (open && markdown) {
    return (
      <View>
        <Markdown>{trimmed}</Markdown>
        {toggle}
      </View>
    );
  }
  return (
    <View>
      <Text
        selectable
        numberOfLines={open ? undefined : lines}
        style={{ color: color ?? theme.colors.foreground, fontSize: TYPE.labelRead.size, lineHeight: TYPE.labelRead.lineHeight }}
      >
        {markdown ? markdownPreview(trimmed) : trimmed}
      </Text>
      {toggle}
    </View>
  );
}

// ---------------------------------------------------------------- Dialog

const FILL: ViewStyle = { position: "absolute", top: 0, right: 0, bottom: 0, left: 0 };

/**
 * 宽弹窗,只用于桌面 Web。宿主 Modal 的桌面卡片固定最宽 520,插件改不了;这里照它的样子
 * (半透明遮罩、surface1 卡片、圆角 12、标题栏 + 关闭、24 内边距的滚动正文)自己画一个,
 * 宽度由调用方定。走 RN Modal:Web 上是挂到 body 的 portal,Esc 与点遮罩都会关闭。
 */
export function Dialog({ theme, title, icon, open, onClose, maxWidth, children }: {
  theme: Theme;
  title: string;
  icon?: ReactNode;
  open: boolean;
  onClose(): void;
  maxWidth: number;
  children: ReactNode;
}) {
  const tokens = chatTokens(theme);
  const [closeHovered, setCloseHovered] = useState(false);
  return (
    <NativeModal transparent visible={open} animationType="fade" onRequestClose={onClose}>
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: space.xl + space.sm, backgroundColor: "rgba(0,0,0,0.55)" }}>
        <Pressable accessibilityLabel="关闭" onPress={onClose} style={FILL} />
        <View role="dialog" aria-modal aria-label={title}
          style={{ width: "100%", maxWidth, maxHeight: "88%", flexShrink: 1, minHeight: 0, overflow: "hidden", backgroundColor: theme.colors.surface1,
            borderRadius: 12, borderWidth: 1, borderColor: theme.colors.surface2, ...tokens.card.shadowHover }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.xl, paddingVertical: space.lg,
            borderBottomWidth: 1, borderBottomColor: theme.colors.surface2 }}>
            {icon ? <View style={{ alignItems: "center", justifyContent: "center" }}>{icon}</View> : null}
            <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, color: theme.colors.foreground, fontSize: TYPE.body.size,
              lineHeight: TYPE.body.lineHeight, fontWeight: "500" }}>{title}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="关闭" hitSlop={8} onPress={onClose}
              onHoverIn={() => setCloseHovered(true)} onHoverOut={() => setCloseHovered(false)}
              style={({ pressed }) => ({ padding: space.xs, borderRadius: radius.block,
                backgroundColor: pressed ? tokens.pressed : closeHovered ? tokens.hover : "transparent", ...WEB_TRANSITION })}>
              <Icon name="X" size={18} color={closeHovered ? theme.colors.foreground : theme.colors.foregroundMuted} />
            </Pressable>
          </View>
          <ScrollView style={{ flexShrink: 1, minHeight: 0 }} contentContainerStyle={{ padding: space.xl, gap: space.lg }}
            keyboardShouldPersistTaps="handled">
            {children}
          </ScrollView>
        </View>
      </View>
    </NativeModal>
  );
}
