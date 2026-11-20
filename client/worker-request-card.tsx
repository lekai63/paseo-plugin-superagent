import { useState } from "react";
import { Text, View } from "react-native";
import { useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { canRespondToWorkerPermission, type SuperagentSnapshot, type Ticket, type WorkerRequest } from "../shared/model";
import { superagentRespondToPermissionRpc } from "../shared/rpc";
import { parseWorkerQuestions, type WorkerQuestionAnswer } from "../shared/worker-questions";
import { useT } from "./i18n";
import { STATE_QUERY_KEY } from "./query";
import { Button, TextButton, cardSurface, space, TYPE, type Theme } from "./ui";
import { WorkerQuestionFields } from "./worker-question-fields";

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

export function WorkerRequestCard({ hostId, threadId, ticket, agentId, request, theme, navigation }: {
  hostId: string;
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
  const stateQuery = { queryKey: [...STATE_QUERY_KEY, hostId] };
  const mutation = useMutation({
    mutationFn: async (decision: { behavior: "allow" | "deny" } | { behavior: "answer"; answers: WorkerQuestionAnswer[] }) => {
      const result = await respond({ threadId, ticketId: ticket.id, agentId, requestId: request.id, ...decision });
      if (!result.ok) throw new Error(result.error ?? t("chat.requests.responseFailed"));
    },
    onSuccess: async () => {
      await queryClient.cancelQueries(stateQuery);
      queryClient.setQueriesData<SuperagentSnapshot>(stateQuery, (state) => state && {
        ...state,
        tickets: state.tickets.map((current) => current.id === ticket.id && current.workerAgentId === agentId ? {
          ...current, pendingRequests: current.pendingRequests?.filter((item) => item.id !== request.id) ?? [],
        } : current),
      });
    },
    onError: (error) => toast.error(error.message),
    onSettled: () => { void queryClient.invalidateQueries(stateQuery); },
  });
  const [expanded, setExpanded] = useState(false);
  const question = request.kind === "question";
  const form = question ? parseWorkerQuestions(request.input) : null;
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
    <View testID={question ? "worker-question-card" : undefined} style={{ ...cardSurface(theme), gap: space.sm, padding: space.md }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <Icon name={question ? "CircleHelp" : "Shield"} size={16} color={colors.statusWarning} />
        <Text style={{ flex: 1, color: colors.foreground, fontSize: TYPE.body.size, lineHeight: TYPE.body.lineHeight, fontWeight: "600" }}>
          {t(question ? "chat.requests.question" : "chat.requests.permission", { title: ticket.title })}
        </Text>
      </View>
      {form ? (
        <WorkerQuestionFields questions={form.questions} theme={theme} pending={mutation.isPending}
          onSubmit={(answers) => mutation.mutate({ behavior: "answer", answers })} />
      ) : (
        <Text selectable numberOfLines={question ? 3 : undefined} style={{ color: colors.foreground, fontSize: TYPE.body.size, lineHeight: TYPE.body.lineHeight }}>
          {summary}
        </Text>
      )}
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
          <Button theme={theme} label={t("chat.requests.allow")} disabled={mutation.isPending} onPress={() => mutation.mutate({ behavior: "allow" })} />
        ) : null}
        {canDeny ? (
          <Button theme={theme} label={t("chat.requests.deny")} variant="outline" disabled={mutation.isPending} onPress={() => mutation.mutate({ behavior: "deny" })} />
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
