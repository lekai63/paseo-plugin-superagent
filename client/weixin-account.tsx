import { useState } from "react";
import { Text, View } from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRpc } from "@getpaseo/plugin/client";
import { copyText, ExternalLink, SettingsAction, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import type { RpcInput } from "@getpaseo/plugin";
import { superagentWeixinAccountRpc, superagentWeixinStatusRpc } from "../shared/rpc";
import { weixinLoginActive, type WeixinStatus } from "../shared/weixin";
import type { Translate } from "../shared/i18n";
import { useT } from "./i18n";
import { Button, fontSize, radius, space, type Theme } from "./ui";

/**
 * 设置页「微信」卡片里的账号区:扫码登录、验证码、退出登录与通道运行状态。
 * 登录与设置保存相互独立:扫码成功即把凭证写到 daemon 本机,通道是否启动仍看已保存的开关。
 */

const QR_CELL = 5;
const QR_QUIET = 4;

function clock(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * 二维码按行绘制:同色连续格合并成一段,避免逐格一个 View。始终白底黑块,深色主题下也能扫。
 * 模块顶层不调用任何 React API(加载即执行会在宿主里闪退,见 README 的 iOS 排查)。
 */
function QrMatrix({ modules }: { modules: string[] }) {
  return (
    <View style={{ alignSelf: "center", padding: QR_CELL * QR_QUIET, backgroundColor: "#ffffff", borderRadius: radius.md }}>
      {modules.map((row, rowIndex) => {
        const runs: { dark: boolean; length: number }[] = [];
        for (const cell of row) {
          const dark = cell === "1";
          const last = runs[runs.length - 1];
          if (last && last.dark === dark) last.length += 1;
          else runs.push({ dark, length: 1 });
        }
        return (
          <View key={rowIndex} style={{ flexDirection: "row", height: QR_CELL }}>
            {runs.map((run, index) => (
              <View key={index} style={{ width: run.length * QR_CELL, height: QR_CELL, backgroundColor: run.dark ? "#000000" : "#ffffff" }} />
            ))}
          </View>
        );
      })}
    </View>
  );
}

function sourceLine(status: WeixinStatus, savedEnabled: boolean, t: Translate): string {
  const source = status.source;
  if (!source) return savedEnabled ? t("weixin.sourceNotRunning") : t("weixin.sourceNotEnabled");
  switch (source.state) {
    case "starting":
      return t("weixin.sourceStarting");
    case "polling":
      return source.lastInboundAt ? t("weixin.sourcePollingLast", { time: clock(source.lastInboundAt) }) : t("weixin.sourcePolling");
    case "retrying":
      return t("weixin.sourceRetrying", { error: source.lastError ?? t("weixin.networkError") });
    case "paused":
      return source.lastError ?? t("weixin.sourcePaused", { time: clock(source.pausedUntil) });
    case "stopped":
      return source.lastError ?? t("weixin.sourceStopped");
  }
}

export function WeixinAccountPanel({ hostId, theme, savedEnabled }: { hostId: string; theme: Theme; savedEnabled: boolean }) {
  const t = useT();
  const fetchStatus = useRpc(superagentWeixinStatusRpc);
  const act = useRpc(superagentWeixinAccountRpc);
  const client = useQueryClient();
  const toast = useToast();
  const key = ["superagent", "weixin", hostId];
  const status = useQuery({
    queryKey: key,
    queryFn: () => fetchStatus({}),
    // 扫码进行中快速刷新进度,其余时间低频看通道状态。
    refetchInterval: (query) => (weixinLoginActive(query.state.data?.login.phase ?? "idle") ? 1500 : 10_000),
    retry: 1,
  });
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");

  const run = async (input: RpcInput<typeof superagentWeixinAccountRpc>) => {
    if (busy) return;
    setBusy(true);
    try {
      client.setQueryData(key, await act(input));
    } catch (error) {
      toast.show(error instanceof Error ? error.message : t("weixin.actionFailed"), { variant: "error" });
    } finally {
      setBusy(false);
    }
  };

  if (status.isPending) {
    return <SettingsAction label={t("weixin.accountLabel")} hint={t("weixin.readingHint")} actionLabel={t("weixin.scanLogin")} disabled onPress={() => {}} />;
  }
  if (!status.data) {
    return (
      <SettingsAction
        label={t("weixin.readFailed")}
        hint={t("weixin.readFailedHint")}
        actionLabel={t("weixin.retry")}
        onPress={() => void status.refetch()}
      />
    );
  }

  const { account, login } = status.data;
  const active = weixinLoginActive(login.phase);
  const muted = { color: theme.colors.foregroundMuted, fontSize: fontSize.sm, lineHeight: 18 } as const;

  return (
    <>
      <SettingsAction
        label={account ? t("weixin.loggedIn", { botId: account.botId }) : t("weixin.notLoggedIn")}
        hint={
          account
            ? `${account.userId ? t("weixin.scannerAllowed", { userId: account.userId }) : ""}${sourceLine(status.data, savedEnabled, t)}`
            : t("weixin.loginHint")
        }
        error={!active && login.phase === "failed" ? login.message : null}
        actionLabel={active ? t("weixin.newCode") : account ? t("weixin.rescan") : t("weixin.scanLogin")}
        disabled={busy || login.phase === "starting"}
        onPress={() => void run({ action: "login" })}
      />
      {active ? (
        <View style={{ padding: space.lg, gap: space.md }}>
          {login.qrModules ? <QrMatrix modules={login.qrModules} /> : null}
          <Text style={{ color: theme.colors.foreground, fontSize: fontSize.base, lineHeight: 20, textAlign: "center" }}>
            {login.message ?? t("weixin.scanPrompt")}
          </Text>
          {login.qrUrl ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "center", alignItems: "center", gap: space.sm }}>
              <Text style={muted}>{t("weixin.onPhone")}</Text>
              <ExternalLink href={login.qrUrl}>{t("weixin.openInWeixin")}</ExternalLink>
              <Button
                theme={theme}
                size="xs"
                variant="ghost"
                icon="Copy"
                label={t("weixin.copyLink")}
                onPress={() => {
                  copyText(login.qrUrl ?? "").then(
                    () => toast.show(t("weixin.linkCopied"), { variant: "success" }),
                    () => toast.show(t("weixin.copyFailed"), { variant: "error" }),
                  );
                }}
              />
            </View>
          ) : null}
          {login.phase === "need_verify" || login.phase === "verifying" ? (
            <View style={{ flexDirection: "row", gap: space.sm, alignItems: "center" }}>
              <TextInput
                accessibilityLabel={t("weixin.codeLabel")}
                value={code}
                onChangeText={setCode}
                keyboardType="number-pad"
                placeholder={t("weixin.codePlaceholder")}
                placeholderTextColor={theme.colors.foregroundMuted}
                editable={login.phase === "need_verify" && !busy}
                style={{
                  flex: 1, height: 32, paddingHorizontal: space.md, borderWidth: 1, borderColor: theme.colors.border,
                  borderRadius: radius.md, backgroundColor: theme.colors.surface0, color: theme.colors.foreground, fontSize: fontSize.base,
                }}
              />
              <Button
                theme={theme}
                variant="primary"
                label={t("weixin.submit")}
                disabled={busy || login.phase !== "need_verify" || !code.trim()}
                onPress={() => {
                  void run({ action: "verify", code: code.trim() });
                  setCode("");
                }}
              />
            </View>
          ) : null}
          <View style={{ alignItems: "center" }}>
            <Button theme={theme} size="xs" variant="ghost" label={t("weixin.cancel")} disabled={busy} onPress={() => void run({ action: "cancel" })} />
          </View>
        </View>
      ) : null}
      {!active && login.phase === "confirmed" && login.message ? (
        <View style={{ paddingHorizontal: space.lg, paddingBottom: space.md }}>
          <Text style={{ color: theme.colors.statusSuccess, fontSize: fontSize.sm, lineHeight: 18 }}>{login.message}</Text>
        </View>
      ) : null}
      {account && !active ? (
        <SettingsAction
          label={t("weixin.logoutLabel")}
          hint={t("weixin.logoutHint")}
          actionLabel={t("weixin.logoutAction")}
          disabled={busy}
          onPress={() => void run({ action: "logout" })}
        />
      ) : null}
    </>
  );
}
