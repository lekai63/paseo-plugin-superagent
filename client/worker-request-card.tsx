import { useState } from "react";
import { Text, View } from "react-native";
import { useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { canRespondToWorkerPermission, type Ticket, type WorkerRequest } from "../shared/model";
import { superagentRespondToPermissionRpc } from "../shared/rpc";
import { useT } from "./i18n";
import { STATE_QUERY_KEY } from "./query";
import { Button, TextButton, cardSurface, space, TYPE, type Theme } from "./ui";

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

export function WorkerRequestCard({ threadId, ticket, agentId, request, theme, navigation }: {
  threadId: string;
  ticket: Ticket;
  agentId: string;
  request: WorkerRequest;
  theme: Theme;
  navigation: PluginScreenProps["navigation"];
}) {
  const t = useT();
  const respond = useRpc(superagentRespondToPermissionRpc);
  const toast = useToast();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: async (behavior: "allow" | "deny") => {
      const result = await respond({ threadId, ticketId: ticket.id, agentId, requestId: request.id, behavior });
      if (!result.ok) throw new Error(result.error ?? t("chat.requests.responseFailed"));
    },
    onError: (error) => toast.error(error.message),
    onSettled: () => { void queryClient.invalidateQueries({ queryKey: STATE_QUERY_KEY }); },
  });
  const [expanded, setExpanded] = useState(false);
  const question = request.kind === "question";
  const input = request.input as { questions?: { question?: unknown }[]; plan?: unknown } | undefined;
  const metadata = request.metadata as { planText?: unknown } | undefined;
  const questionText = question ? text(input?.questions?.[0]?.question) : undefined;
  const summary = questionText ?? text(request.title) ?? text(request.description) ?? request.name;
  const description = text(request.description);
  const detail = question ? null : text(metadata?.planText) ?? text(input?.plan)
    ?? JSON.stringify(request.input ?? request.detail ?? null, null, 2);
  const hasDetail = detail !== null && detail !== "null" && detail !== "{}";
  const canAllow = canRespondToWorkerPermission(request, "allow");
  const canDeny = canRespondToWorkerPermission(request, "deny");
  const { colors } = theme;

  return (
    <View style={{ ...cardSurface(theme), gap: space.sm, padding: space.md }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <Icon name={question ? "CircleHelp" : "Shield"} size={16} color={colors.statusWarning} />
        <Text style={{ flex: 1, color: colors.foreground, fontSize: TYPE.body.size, lineHeight: TYPE.body.lineHeight, fontWeight: "600" }}>
          {t(question ? "chat.requests.question" : "chat.requests.permission", { title: ticket.title })}
        </Text>
      </View>
      <Text selectable numberOfLines={question ? 3 : undefined} style={{ color: colors.foreground, fontSize: TYPE.body.size, lineHeight: TYPE.body.lineHeight }}>
        {summary}
      </Text>
      {!question && description && description !== summary ? (
        <Text selectable style={{ color: colors.foregroundMuted, fontSize: TYPE.body.size, lineHeight: TYPE.body.lineHeight }}>{description}</Text>
      ) : null}
      {hasDetail ? (
        <View style={{ alignItems: "flex-start", gap: space.xs }}>
          <Text selectable numberOfLines={expanded ? undefined : 4}
            style={{ color: colors.foregroundMuted, fontSize: TYPE.caption.size, lineHeight: TYPE.caption.lineHeight }}>{detail}</Text>
          <TextButton theme={theme} label={t(expanded ? "chat.collapse" : "chat.requests.details")} onPress={() => setExpanded(!expanded)} />
        </View>
      ) : null}
      {!question && (!canAllow || !canDeny) ? (
        <Text style={{ color: colors.foregroundMuted, fontSize: TYPE.caption.size, lineHeight: TYPE.caption.lineHeight }}>
          {t("chat.requests.chooseInWorker")}
        </Text>
      ) : null}
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.sm }}>
        {canAllow ? (
          <Button theme={theme} label={t("chat.requests.allow")} disabled={mutation.isPending} onPress={() => mutation.mutate("allow")} />
        ) : null}
        {canDeny ? (
          <Button theme={theme} label={t("chat.requests.deny")} variant="outline" disabled={mutation.isPending} onPress={() => mutation.mutate("deny")} />
        ) : null}
        {navigation ? (
          <Button theme={theme} label={t(question ? "chat.requests.answerInWorker" : "chat.requests.openWorker")} icon="ExternalLink"
            variant="ghost" onPress={() => navigation.openAgent({ agentId })} />
        ) : null}
        {mutation.isPending ? (
          <Text accessibilityLiveRegion="polite" style={{ color: colors.foregroundMuted, fontSize: TYPE.caption.size, lineHeight: TYPE.caption.lineHeight }}>
            {t("chat.requests.submitting")}
          </Text>
        ) : null}
      </View>
    </View>
  );
}
