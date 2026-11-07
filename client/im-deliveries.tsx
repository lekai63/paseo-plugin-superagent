import { useState } from "react";
import { Text, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/ui";
import type { SuperagentSnapshot } from "../shared/model";
import { superagentRetryImDeliveryRpc } from "../shared/rpc";
import { STATE_QUERY_KEY } from "./query";
import { Button, Card, fontSize, space, type Theme } from "./ui";

type Delivery = SuperagentSnapshot["imDeliveries"][number];
const CHANNELS = { feishu: "飞书", qq: "QQ", dingtalk: "钉钉", wecom: "企业微信", weixin: "微信" };

export function ImDeliveries({ deliveries, theme, hostId }: { deliveries: Delivery[]; theme: Theme; hostId: string }) {
  const visible = [...deliveries.filter((item) => item.status !== "sent"), ...deliveries.filter((item) => item.status === "sent").slice(0, 5)];
  return <View style={{ gap: space.sm }}>{visible.map((item) => <DeliveryCard key={item.id} item={item} theme={theme} hostId={hostId} />)}</View>;
}

function DeliveryCard({ item, theme, hostId }: { item: Delivery; theme: Theme; hostId: string }) {
  const [busy, setBusy] = useState(false);
  const retry = useRpc(superagentRetryImDeliveryRpc);
  const client = useQueryClient();
  const toast = useToast();
  const send = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await retry({ deliveryId: item.id });
      if (!result.ok) throw new Error(result.error || "补发失败");
      toast.show("剩余答复已发送", { variant: "success" });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "补发失败");
    } finally {
      setBusy(false);
      void client.invalidateQueries({ queryKey: [...STATE_QUERY_KEY, hostId] });
    }
  };
  const status = item.status === "sent" ? "已全部发送"
    : item.status === "failed" ? `第 ${item.nextPart + 1} 条发送失败,进度已保留` : "正在发送";
  return <Card theme={theme} style={{ padding: space.lg, gap: space.sm }}>
    <Text numberOfLines={2} style={{ color: theme.colors.foreground, fontSize: fontSize.base }}>{item.title}</Text>
    <Text style={{ color: item.status === "failed" ? theme.colors.statusDanger : theme.colors.foregroundMuted, fontSize: fontSize.sm }}>
      {CHANNELS[item.channel]} · {status} · 已发送 {item.nextPart}/{item.totalParts} 条
    </Text>
    {item.status === "failed" ? <View style={{ alignItems: "flex-start", gap: space.sm }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.sm }}>检查 IM 连接与回复窗口后,可继续发送剩余内容。</Text>
      <Button theme={theme} variant="outline" icon="RefreshCw" label={busy ? "补发中..." : `从第 ${item.nextPart + 1} 条补发`} disabled={busy} onPress={() => void send()} />
    </View> : null}
  </Card>;
}
