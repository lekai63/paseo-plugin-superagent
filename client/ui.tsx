import { useEffect, useState, type ReactNode } from "react";
import { Pressable, Text, View, type StyleProp, type ViewStyle } from "react-native";
import type { PluginHostProps } from "@getpaseo/plugin/client";
import { Icon, Markdown } from "@getpaseo/plugin/client/ui";
import { markdownPreview, type Tone } from "../shared/labels";

/**
 * 插件内复用的小型 UI 原语。宿主只向插件暴露 Settings* 系列与 Icon/Modal 等,
 * 按钮、徽标、提示条需要自己画;数值与宿主 theme.ts 的刻度保持一致
 * (间距 4/8/12/16/24、圆角 6/8、字号 12/14/20),颜色全部来自 theme。
 */

export type Theme = PluginHostProps["theme"];

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;
export const radius = { md: 6, lg: 8, full: 999 } as const;
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

/** 给 #rgb / #rrggbb 颜色加透明度;其他格式原样返回(宁可不透明也不产出非法颜色)。 */
export function withAlpha(color: string, alpha: number): string {
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(color);
  const hex = short ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}` : color;
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return color;
  const value = Math.round(Math.min(1, Math.max(0, alpha)) * 255)
    .toString(16)
    .padStart(2, "0");
  return `${hex}${value}`;
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
  /** 危险操作:outline/ghost 用红色文字,primary 用红色填充。 */
  danger?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
}

const BUTTON_HEIGHT = { xs: 28, sm: 32 } as const;

export function Button({
  theme,
  label,
  icon,
  onPress,
  variant = "secondary",
  size = "sm",
  danger = false,
  disabled = false,
  accessibilityLabel,
}: ButtonProps) {
  const [hovered, setHovered] = useState(false);
  const { colors } = theme;
  const height = BUTTON_HEIGHT[size];
  const filled = variant === "primary";
  const fillColor = danger ? colors.statusDanger : colors.accent;
  // 状态色填充上的文字用 surface0:浅色主题是白底色、深色主题是深底色,两边都有足够对比。
  let foreground: string = danger ? colors.statusDanger : colors.foreground;
  if (filled) foreground = danger ? colors.surface0 : colors.accentForeground;
  else if (variant === "ghost" && !danger && !hovered) foreground = colors.foregroundMuted;

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
        if (filled) backgroundColor = fillColor;
        else if (variant === "secondary") backgroundColor = active ? colors.border : colors.surface2;
        else if (active) backgroundColor = colors.surface2;
        return {
          height,
          minWidth: height,
          paddingHorizontal: label ? (size === "xs" ? space.sm : space.md) : 0,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: space.xs + 2,
          borderRadius: radius.md,
          borderWidth: variant === "outline" || variant === "secondary" ? 1 : 0,
          borderColor: colors.border,
          backgroundColor,
          opacity: disabled ? 0.5 : filled && active ? 0.88 : 1,
        };
      }}
    >
      {icon ? <Icon name={icon} size={size === "xs" ? 14 : 16} color={foreground} /> : null}
      {label ? (
        <Text style={{ color: foreground, fontSize: size === "xs" ? fontSize.sm : fontSize.base }} numberOfLines={1}>
          {label}
        </Text>
      ) : null}
    </Pressable>
  );
}

/**
 * 二次确认按钮:第一次点击只"上膛"(变成红色确认),4 秒内再点才执行。
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
  /** 上膛前的样式;上膛后总是红色填充。 */
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
        variant="primary"
        danger
        size={size}
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

export function Card({ theme, children, style }: { theme: Theme; children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View
      style={[
        {
          backgroundColor: theme.colors.surface1,
          borderWidth: 1,
          borderColor: theme.colors.border,
          borderRadius: radius.lg,
          overflow: "hidden",
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

/** 状态徽标:中性外壳 + 状态色圆点与文字(与宿主 StatusBadge 同构)。 */
export function StatusBadge({ theme, label, tone }: { theme: Theme; label: string; tone: Tone }) {
  const color = toneColor(tone, theme);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.xs + 2,
        height: 22,
        paddingHorizontal: space.sm,
        borderRadius: radius.full,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface2,
      }}
    >
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color }} />
      <Text style={{ color, fontSize: fontSize.sm }} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

/** 页面级提示条:细边框、透明底、带色图标与标题,描述用次要色;操作放 children。 */
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
  const color = tone === "default" ? theme.colors.foreground : toneColor(tone, theme);
  const icon = tone === "danger" ? "CircleAlert" : tone === "warning" ? "TriangleAlert" : "Info";
  return (
    <View
      accessibilityRole="alert"
      style={{
        flexDirection: "row",
        gap: space.md,
        padding: space.lg,
        borderWidth: 1,
        borderRadius: radius.lg,
        borderColor: tone === "default" ? theme.colors.border : withAlpha(color, 0.45),
      }}
    >
      <View style={{ paddingTop: 2 }}>
        <Icon name={icon} size={16} color={color} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: space.xs }}>
        <Text style={{ color, fontSize: fontSize.base, fontWeight: "500" }}>{title}</Text>
        {description ? (
          <Text selectable style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.sm, lineHeight: 18 }}>
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
    <Card theme={theme} style={{ flex: 1, minWidth: 0, paddingVertical: space.md, paddingHorizontal: space.lg, gap: 2 }}>
      <Text style={{ color: toneColor(tone, theme), fontSize: fontSize.stat, fontVariant: ["tabular-nums"] }}>{value}</Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.sm }} numberOfLines={1}>
        {label}
        {caption ? <Text style={{ color: theme.colors.statusWarning }}>{` · ${caption}`}</Text> : null}
      </Text>
    </Card>
  );
}

/** 卡片内分组的小标题(结构性标签:medium 字重、次要色)。 */
export function GroupLabel({ theme, children, trailing }: { theme: Theme; children: string; trailing?: ReactNode }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.sm, fontWeight: "500" }}>{children}</Text>
      {trailing}
    </View>
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
    <Text
      accessibilityRole="button"
      onPress={() => setOpen((value) => !value)}
      style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.sm, marginTop: space.xs, alignSelf: "flex-start" }}
    >
      {open ? "收起" : "展开全部"}
    </Text>
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
        style={{ color: color ?? theme.colors.foreground, fontSize: fontSize.base, lineHeight: 20 }}
      >
        {markdown ? markdownPreview(trimmed) : trimmed}
      </Text>
      {toggle}
    </View>
  );
}
