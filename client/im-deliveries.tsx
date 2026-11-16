import { useState } from "react";
import { Text, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/ui";
import type { SuperagentSnapshot } from "../shared/model";
import { relativeTime } from "../shared/labels";
import { superagentRetryImDeliveryRpc } from "../shared/rpc";
import { STATE_QUERY_KEY } from "./query";
import { TYPE } from "../shared/design";
import { Button, Card, space, type Theme } from "./ui";
import { useT } from "./i18n";

type Delivery = SuperagentSnapshot["imDeliveries"][number];

/**
 * 还没送达的 IM 回复(发送中或中途失败)。已全部发出的回复在对话里就能看到,不在这里重复;
 * 因此这一栏平时为空,出现时多半是需要补发的失败。
 */
export function undeliveredReplies(deliveries: Delivery[]): Delivery[] {
  return deliveries.filter((item) => item.status !== "sent");
}

export function ImDeliveries({ deliveries, theme, hostId }: { deliveries: Delivery[]; theme: Theme; hostId: string }) {
  return <View style={{ gap: space.sm }}>{deliveries.map((item) => <DeliveryCard key={item.id} item={item} theme={theme} hostId={hostId} />)}</View>;
}

function DeliveryCard({ item, theme, hostId }: { item: Delivery; theme: Theme; hostId: string }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const retry = useRpc(superagentRetryImDeliveryRpc);
  const client = useQueryClient();
  const toast = useToast();
  const send = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await retry({ deliveryId: item.id });
      if (!result.ok) throw new Error(result.error || t("sidebar.im.resendFailed"));
      toast.show(t("sidebar.im.resent"), { variant: "success" });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("sidebar.im.resendFailed"));
    } finally {
      setBusy(false);
      void client.invalidateQueries({ queryKey: [...STATE_QUERY_KEY, hostId] });
    }
  };
  const failed = item.status === "failed";
  const status = failed
    ? t("sidebar.im.partFailed", { current: item.nextPart + 1, total: item.totalParts })
    : t("sidebar.im.sending", { current: item.nextPart, total: item.totalParts });
  const caption = { fontSize: TYPE.caption.size, lineHeight: TYPE.caption.lineHeight };
  return <Card theme={theme} state={failed ? "failed" : "rest"} style={{ paddingTop: space.sm + 2, paddingBottom: space.md, paddingHorizontal: space.md, gap: space.xs + 2 }}>
    <Text numberOfLines={2} style={{ color: theme.colors.foreground, fontSize: TYPE.body.size, lineHeight: TYPE.body.lineHeight, fontWeight: "500" }}>
      {item.preview || item.title}
    </Text>
    <Text style={{ ...caption, color: failed ? theme.colors.statusDanger : theme.colors.foregroundMuted }}>
      {t(`sidebar.channel.${item.channel}`)} · {relativeTime(item.updatedAt, t)} · {status}
    </Text>
    {item.preview ? (
      <Text numberOfLines={1} style={{ ...caption, color: theme.colors.foregroundMuted }}>{t("sidebar.im.conversation", { title: item.title })}</Text>
    ) : null}
    {failed ? <View style={{ alignItems: "flex-start", gap: space.sm, marginTop: space.xs }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: TYPE.captionRead.size, lineHeight: TYPE.captionRead.lineHeight }}>
        {t("sidebar.im.note")}
      </Text>
      <Button theme={theme} variant="outline" size="xs" icon="RefreshCw" label={busy ? t("sidebar.im.resending") : t("sidebar.im.resendFrom", { part: item.nextPart + 1 })} disabled={busy} onPress={() => void send()} />
    </View> : null}
  </Card>;
}
