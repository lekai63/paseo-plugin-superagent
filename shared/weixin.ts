import { z } from "zod";

/** 微信通道(iLink 扫码登录)的状态契约:服务端 RPC 与设置页共用。 */

export const WEIXIN_LOGIN_PHASES = [
  "idle",
  "starting",
  "waiting",
  "scanned",
  "need_verify",
  "verifying",
  "confirmed",
  "failed",
] as const;

export const WeixinLoginSnapshotSchema = z.object({
  phase: z.enum(WEIXIN_LOGIN_PHASES),
  /** 扫码内容(URL):手机上也可直接在微信里打开。 */
  qrUrl: z.string().nullable(),
  /** 二维码点阵,每行一个 0/1 字符串。 */
  qrModules: z.array(z.string()).nullable(),
  message: z.string().nullable(),
});
export type WeixinLoginSnapshot = z.infer<typeof WeixinLoginSnapshotSchema>;

export const WeixinStatusSchema = z.object({
  /** 已保存的 bot 账号;凭证本身不出 daemon。 */
  account: z
    .object({ botId: z.string(), userId: z.string().nullable(), savedAt: z.string() })
    .nullable(),
  login: WeixinLoginSnapshotSchema,
  /** 通道运行状态;未启动(未启用、未登录或未保存设置)时为 null。 */
  source: z
    .object({
      state: z.enum(["starting", "polling", "retrying", "paused", "stopped"]),
      lastError: z.string().nullable(),
      lastPollAt: z.string().nullable(),
      lastInboundAt: z.string().nullable(),
      pausedUntil: z.string().nullable(),
    })
    .nullable(),
});
export type WeixinStatus = z.infer<typeof WeixinStatusSchema>;

/** 登录进行中的阶段:设置页据此加快轮询、显示二维码。 */
export function weixinLoginActive(phase: WeixinLoginSnapshot["phase"]): boolean {
  return phase === "starting" || phase === "waiting" || phase === "scanned" || phase === "need_verify" || phase === "verifying";
}
