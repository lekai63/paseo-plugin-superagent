import { useEffect, useMemo, useState } from "react";
import { Image, Pressable, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, Loading, Markdown, Modal } from "@getpaseo/plugin/client/ui";
import { basename, extensionOf, lineSuffix, type FileLink } from "../shared/file-links";
import {
  FILE_PREVIEW_LIMITS,
  IMAGE_MIME_TYPES,
  MARKDOWN_EXTENSIONS,
  codeLanguage,
  excerptLines,
  fenceCode,
  formatBytes,
  type FilePreview,
} from "../shared/file-preview";
import { fullStamp } from "../shared/labels";
import { superagentReadFileRpc } from "../shared/rpc";
import { TYPE } from "../shared/design";
import { HAIRLINE, WEB_TRANSITION, chatTokens, radius, space, type Theme } from "./theme-tokens";
import { Button, CopyButton, Notice, TextButton } from "./ui";

/**
 * 答复里的文件链接与预览。宿主 Markdown 在插件页面里点文件链接没有反应(没有工作区
 * 上下文),所以把认出的文件列在答复下方,点开在弹层里预览:Markdown 按 Markdown 渲染,
 * 其余文本放进宿主的代码块(Web 端有高亮),图片直接显示,目录可以逐级点进去。
 */

/** 打开预览的目标:答复里的链接,或在目录里点进去的条目。 */
export type FileTarget = Pick<FileLink, "path" | "directory" | "lineStart" | "lineEnd">;

function fileIcon(target: FileTarget): string {
  if (target.directory) return "Folder";
  const extension = extensionOf(target.path);
  if (IMAGE_MIME_TYPES[extension]) return "Image";
  if (MARKDOWN_EXTENSIONS.has(extension)) return "FileText";
  return "File";
}

// ---------------------------------------------------------------- chips

/** 答复下方的文件条:细线药丸,图标 + 链接文字 + 行号;悬停显示完整路径(无障碍标签)。 */
export function FileLinkList({ links, theme, touch, onOpen }: {
  links: readonly FileLink[];
  theme: Theme;
  touch: boolean;
  onOpen(link: FileLink): void;
}) {
  if (!links.length) return null;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs + 2 }}>
      {links.map((link) => (
        <FileChip key={`${link.path}${lineSuffix(link)}`} link={link} theme={theme} touch={touch} onPress={() => onOpen(link)} />
      ))}
    </View>
  );
}

function FileChip({ link, theme, touch, onPress }: { link: FileLink; theme: Theme; touch: boolean; onPress(): void }) {
  const tokens = chatTokens(theme);
  const [hovered, setHovered] = useState(false);
  const suffix = lineSuffix(link);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`预览 ${link.path}${suffix}`}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      hitSlop={touch ? 6 : 2}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: space.xs + 1,
        height: touch ? 28 : 24,
        maxWidth: "100%",
        paddingHorizontal: space.sm,
        borderRadius: radius.chip,
        borderWidth: HAIRLINE,
        borderColor: tokens.card.pillBorder,
        backgroundColor: pressed ? tokens.pressed : hovered ? tokens.card.controlHover : tokens.card.pillFill,
        ...WEB_TRANSITION,
      })}
    >
      <Icon name={fileIcon(link)} size={12} color={hovered ? theme.colors.foreground : theme.colors.foregroundMuted} />
      <Text numberOfLines={1} style={{ flexShrink: 1, maxWidth: 280, color: theme.colors.foreground, fontSize: TYPE.caption.size,
        lineHeight: TYPE.caption.lineHeight }}>
        {link.label}
        {suffix ? <Text style={{ color: theme.colors.foregroundMuted, fontVariant: ["tabular-nums"] }}>{suffix}</Text> : null}
      </Text>
    </Pressable>
  );
}

// ---------------------------------------------------------------- modal

/**
 * 预览弹层。target 变化时从它开始;在目录里点进去会压栈,「返回」出栈。关闭时保留最后的
 * 内容,让收起动画里不闪空。
 */
export function FilePreviewModal({ target, hostId, theme, onClose }: {
  target: FileTarget | null;
  hostId: string;
  theme: Theme;
  onClose(): void;
}) {
  const [stack, setStack] = useState<FileTarget[]>(() => (target ? [target] : []));
  useEffect(() => {
    if (target) setStack([target]);
  }, [target]);
  const current = stack[stack.length - 1] ?? null;
  const open = Boolean(target);
  const title = current ? `${basename(current.path) || current.path}${lineSuffix(current)}` : "文件预览";
  return (
    <Modal title={title} icon={current ? <Icon name={fileIcon(current)} size={16} color={theme.colors.foregroundMuted} /> : undefined}
      open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <Modal.Content>
        {current ? (
          <PreviewBody
            key={`${current.path}${lineSuffix(current)}`}
            target={current}
            hostId={hostId}
            theme={theme}
            enabled={open}
            onBack={stack.length > 1 ? () => setStack((items) => items.slice(0, -1)) : null}
            onOpen={(next) => setStack((items) => [...items, next])}
          />
        ) : null}
      </Modal.Content>
    </Modal>
  );
}

function PreviewBody({ target, hostId, theme, enabled, onBack, onOpen }: {
  target: FileTarget;
  hostId: string;
  theme: Theme;
  enabled: boolean;
  onBack: (() => void) | null;
  onOpen(target: FileTarget): void;
}) {
  const read = useRpc(superagentReadFileRpc);
  const query = useQuery({
    queryKey: ["superagent", "file", hostId, target.path],
    queryFn: () => read({ path: target.path }),
    enabled,
    // 每次打开都重新读:文件可能刚被 Worker 改过。
    staleTime: 0,
    gcTime: 30_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const preview = query.data;
  const muted = theme.colors.foregroundMuted;
  const caption = { fontSize: TYPE.caption.size, lineHeight: TYPE.caption.lineHeight };
  const meta = preview && preview.kind !== "error"
    ? [preview.kind === "directory" ? `${preview.total} 项` : formatBytes(preview.size), `修改于 ${fullStamp(preview.modifiedAt)}`].join(" · ")
    : null;

  return (
    <View style={{ gap: space.md }}>
      <View style={{ gap: space.xs }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          {onBack ? <Button theme={theme} variant="ghost" size="xs" icon="ArrowLeft" label="返回" onPress={onBack} /> : null}
          <Text selectable numberOfLines={3} style={{ ...caption, flex: 1, minWidth: 0, color: muted }}>{target.path}</Text>
          <CopyButton theme={theme} text={target.path} label="复制路径" />
          <Button theme={theme} variant="ghost" size="xs" icon="RotateCw" accessibilityLabel="重新读取"
            disabled={query.isFetching} onPress={() => void query.refetch()} />
        </View>
        {meta ? <Text style={{ ...caption, color: muted, fontVariant: ["tabular-nums"] }}>{meta}</Text> : null}
      </View>
      {query.isError ? (
        <Notice theme={theme} tone="danger" title="读取失败"
          description={query.error instanceof Error ? query.error.message : String(query.error)} />
      ) : !preview ? (
        <View style={{ height: 160 }}><Loading /></View>
      ) : (
        <PreviewContent preview={preview} target={target} theme={theme} onOpen={onOpen} />
      )}
    </View>
  );
}

function PreviewContent({ preview, target, theme, onOpen }: {
  preview: FilePreview;
  target: FileTarget;
  theme: Theme;
  onOpen(target: FileTarget): void;
}) {
  switch (preview.kind) {
    case "text":
      return <TextPreview preview={preview} target={target} theme={theme} />;
    case "image":
      return <ImagePreview preview={preview} />;
    case "directory":
      return <DirectoryPreview preview={preview} theme={theme} onOpen={onOpen} />;
    case "binary":
      return (
        <Notice theme={theme} tone="default" title="无法在这里预览"
          description={preview.reason === "too_large"
            ? `图片超过 ${formatBytes(FILE_PREVIEW_LIMITS.imageBytes)},不在这里显示。可复制路径后用其他应用打开。`
            : "这不是文本文件。可复制路径后用其他应用打开。"} />
      );
    case "error":
      return <Notice theme={theme} tone="danger" title="无法读取" description={preview.message} />;
  }
}

function TextPreview({ preview, target, theme }: { preview: Extract<FilePreview, { kind: "text" }>; target: FileTarget; theme: Theme }) {
  const [showAll, setShowAll] = useState(false);
  const extension = extensionOf(preview.path);
  const markdown = MARKDOWN_EXTENSIONS.has(extension);
  const excerpt = useMemo(
    () => (!markdown && target.lineStart ? excerptLines(preview.text, target.lineStart, target.lineEnd) : null),
    [markdown, preview.text, target.lineStart, target.lineEnd],
  );
  const shown = excerpt && !showAll ? excerpt.text : preview.text;
  const source = useMemo(
    () => (markdown ? shown : fenceCode(shown, codeLanguage(basename(preview.path), extension))),
    [markdown, shown, preview.path, extension],
  );
  const caption = { fontSize: TYPE.caption.size, lineHeight: TYPE.caption.lineHeight, color: theme.colors.foregroundMuted };
  if (!preview.text.trim()) return <Text style={caption}>空文件</Text>;
  return (
    <View style={{ gap: space.sm }}>
      {preview.truncated ? (
        <Notice theme={theme} tone="warning" title={`文件较大,只显示前 ${formatBytes(FILE_PREVIEW_LIMITS.textBytes)}`} />
      ) : null}
      {excerpt ? (
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.sm }}>
          <Text style={{ ...caption, fontVariant: ["tabular-nums"] }}>
            {showAll ? `全文 ${excerpt.total} 行` : `第 ${excerpt.from}–${excerpt.to} 行(共 ${excerpt.total} 行)`}
          </Text>
          <TextButton theme={theme} label={showAll ? "只看引用附近" : "显示全文"} onPress={() => setShowAll((value) => !value)} />
        </View>
      ) : null}
      <Markdown>{source}</Markdown>
    </View>
  );
}

function ImagePreview({ preview }: { preview: Extract<FilePreview, { kind: "image" }> }) {
  const [aspectRatio, setAspectRatio] = useState(4 / 3);
  const uri = useMemo(() => `data:${preview.mimeType};base64,${preview.base64}`, [preview.mimeType, preview.base64]);
  return (
    <Image
      accessibilityLabel={basename(preview.path)}
      source={{ uri }}
      resizeMode="contain"
      onLoad={(event) => {
        const size = (event.nativeEvent as { source?: { width?: number; height?: number } } | undefined)?.source;
        if (size?.width && size.height) setAspectRatio(size.width / size.height);
      }}
      style={{ width: "100%", aspectRatio, maxHeight: 640, borderRadius: radius.block }}
    />
  );
}

function DirectoryPreview({ preview, theme, onOpen }: {
  preview: Extract<FilePreview, { kind: "directory" }>;
  theme: Theme;
  onOpen(target: FileTarget): void;
}) {
  const caption = { fontSize: TYPE.caption.size, lineHeight: TYPE.caption.lineHeight, color: theme.colors.foregroundMuted };
  if (!preview.entries.length) return <Text style={caption}>空目录</Text>;
  const join = (name: string) => (preview.path.endsWith("/") ? `${preview.path}${name}` : `${preview.path}/${name}`);
  return (
    <View style={{ gap: 2 }}>
      {preview.entries.map((entry) => (
        <DirectoryRow key={entry.name} name={entry.name} directory={entry.directory} theme={theme}
          onPress={() => onOpen({ path: join(entry.name), directory: entry.directory })} />
      ))}
      {preview.total > preview.entries.length ? (
        <Text style={{ ...caption, marginTop: space.sm }}>共 {preview.total} 项,只列出前 {preview.entries.length} 项</Text>
      ) : null}
    </View>
  );
}

function DirectoryRow({ name, directory, theme, onPress }: { name: string; directory: boolean; theme: Theme; onPress(): void }) {
  const tokens = chatTokens(theme);
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={directory ? `打开目录 ${name}` : `预览 ${name}`} onPress={onPress}
      onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)}
      style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 32, paddingHorizontal: space.sm,
        borderRadius: radius.block, backgroundColor: pressed ? tokens.pressed : hovered ? tokens.hover : "transparent", ...WEB_TRANSITION })}>
      <Icon name={fileIcon({ path: name, directory })} size={14} color={theme.colors.foregroundMuted} />
      <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, color: theme.colors.foreground, fontSize: TYPE.label.size,
        lineHeight: TYPE.label.lineHeight }}>{name}</Text>
      {directory ? <Icon name="ChevronRight" size={14} color={theme.colors.foregroundMuted} /> : null}
    </Pressable>
  );
}
