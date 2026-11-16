import qrcode from "qrcode-generator";
import { clearTimeout, setTimeout } from "node:timers";
import type { WeixinLoginSnapshot } from "../shared/weixin";
import {
  isAbortError,
  weixinGet,
  weixinPost,
  WEIXIN_API_BASE,
  type QrCodeResponse,
  type QrStatusResponse,
} from "./weixin-api";
import type { WeixinAccount } from "./weixin-store";
import { t } from "./i18n";

/**
 * 微信扫码登录(iLink get_bot_qrcode → get_qrcode_status 长轮询)。
 * 设置页经 RPC 发起并轮询快照;需要验证码时由用户在设置页输入。
 * 同一时间只有一个登录会话,新的发起会取消旧的。
 */

const BOT_TYPE = "3";
const LOGIN_TIMEOUT_MS = 8 * 60_000;
const QR_FETCH_TIMEOUT_MS = 15_000;
const QR_POLL_TIMEOUT_MS = 35_000;
const POLL_INTERVAL_MS = 1_000;
/** 二维码过期/验证码被锁时最多换几次码(含首次),与官方插件一致。 */
const MAX_QR_CODES = 3;

export interface WeixinLoginDeps {
  /** 已保存的账号:随取码请求带上 token,服务端据此识别「已绑定本机」。 */
  loadAccount(): Promise<WeixinAccount | null>;
  /** 扫码确认后保存凭证并(重新)启动通道;抛错视为登录失败。 */
  onConfirmed(account: WeixinAccount): Promise<void>;
}

interface Session {
  abort: AbortController;
  qrcode: string;
  qrUrl: string;
  qrModules: string[];
  codes: number;
  baseUrl: string;
  pendingCode: string | null;
  wakeForCode: (() => void) | null;
}

/** 扫码内容 → 点阵(每行一个 0/1 字符串),客户端按行绘制,不依赖图片解码。 */
export function qrModules(text: string): string[] {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const size = qr.getModuleCount();
  const rows: string[] = [];
  for (let row = 0; row < size; row++) {
    let line = "";
    for (let col = 0; col < size; col++) line += qr.isDark(row, col) ? "1" : "0";
    rows.push(line);
  }
  return rows;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

const IDLE: WeixinLoginSnapshot = { phase: "idle", qrUrl: null, qrModules: null, message: null };

export class WeixinLogin {
  private session: Session | null = null;
  /** 正在取码的那次发起:取码期间被取消或被新的发起顶替时中止。 */
  private starting: AbortController | null = null;
  private state: WeixinLoginSnapshot = IDLE;

  constructor(
    private readonly deps: WeixinLoginDeps,
    private readonly pollIntervalMs = POLL_INTERVAL_MS,
  ) {}

  snapshot(): WeixinLoginSnapshot {
    return { ...this.state };
  }

  async start(): Promise<WeixinLoginSnapshot> {
    this.cancel();
    const abort = new AbortController();
    this.starting = abort;
    this.state = { ...IDLE, phase: "starting", message: t("server.weixinLogin.fetching") };
    let qr: { qrcode: string; qrUrl: string };
    try {
      qr = await this.fetchQr(abort.signal);
    } catch (error) {
      if (this.starting === abort) {
        this.starting = null;
        this.state = { ...IDLE, phase: "failed", message: t("server.weixinLogin.fetchFailed", { error: error instanceof Error ? error.message : String(error) }) };
      }
      return this.snapshot();
    }
    if (this.starting !== abort) return this.snapshot();
    this.starting = null;
    const session: Session = {
      abort,
      ...qr,
      qrModules: qrModules(qr.qrUrl),
      codes: 1,
      baseUrl: WEIXIN_API_BASE,
      pendingCode: null,
      wakeForCode: null,
    };
    this.session = session;
    this.show(session, "waiting", t("server.weixinLogin.scan"));
    void this.run(session).catch((error) => {
      console.error("[superagent] weixin login loop failed", error);
      this.finish(session, "failed", t("server.weixinLogin.loopFailed"));
    });
    return this.snapshot();
  }

  verify(code: string): WeixinLoginSnapshot {
    const session = this.session;
    const trimmed = code.trim();
    if (!session || this.state.phase !== "need_verify" || !trimmed) return this.snapshot();
    session.pendingCode = trimmed;
    this.show(session, "verifying", t("server.weixinLogin.verifying"));
    session.wakeForCode?.();
    return this.snapshot();
  }

  cancel(): WeixinLoginSnapshot {
    const starting = this.starting;
    if (starting) {
      this.starting = null;
      starting.abort();
      this.state = { ...IDLE, message: t("server.weixinLogin.cancelled") };
    }
    const session = this.session;
    if (session) {
      this.session = null;
      session.abort.abort();
      session.wakeForCode?.();
      this.state = { ...IDLE, message: t("server.weixinLogin.cancelled") };
    }
    return this.snapshot();
  }

  private show(session: Session, phase: WeixinLoginSnapshot["phase"], message: string): void {
    if (this.session !== session) return;
    this.state = { phase, qrUrl: session.qrUrl, qrModules: session.qrModules, message };
  }

  private finish(session: Session, phase: "confirmed" | "failed", message: string): void {
    if (this.session !== session) return;
    this.session = null;
    session.abort.abort();
    this.state = { ...IDLE, phase, message };
  }

  private async fetchQr(signal: AbortSignal): Promise<{ qrcode: string; qrUrl: string }> {
    const existing = await this.deps.loadAccount().catch(() => null);
    const response = await weixinPost<QrCodeResponse>(
      WEIXIN_API_BASE,
      `ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`,
      { local_token_list: existing ? [existing.token] : [] },
      { timeoutMs: QR_FETCH_TIMEOUT_MS, signal },
    );
    if (!response.qrcode || !response.qrcode_img_content) throw new Error(t("server.weixinLogin.noQr"));
    return { qrcode: response.qrcode, qrUrl: response.qrcode_img_content };
  }

  /** 网关超时、网络抖动都按「继续等待」处理,与官方插件一致。 */
  private async pollStatus(session: Session, code: string | null): Promise<QrStatusResponse> {
    let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(session.qrcode)}`;
    if (code) endpoint += `&verify_code=${encodeURIComponent(code)}`;
    try {
      return await weixinGet<QrStatusResponse>(session.baseUrl, endpoint, {
        timeoutMs: QR_POLL_TIMEOUT_MS,
        signal: session.abort.signal,
      });
    } catch (error) {
      if (!isAbortError(error)) console.warn(`[superagent] weixin login status poll failed: ${error instanceof Error ? error.message : String(error)}`);
      return { status: "wait" };
    }
  }

  private waitForCode(session: Session, deadline: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, Math.max(0, deadline - Date.now()));
      function done() {
        clearTimeout(timer);
        session.wakeForCode = null;
        resolve();
      }
      session.wakeForCode = done;
    });
  }

  private async run(session: Session): Promise<void> {
    const { signal } = session.abort;
    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    let awaitingCode = false;
    while (!signal.aborted && Date.now() < deadline) {
      if (awaitingCode && !session.pendingCode) {
        await this.waitForCode(session, deadline);
        continue;
      }
      const sentCode = session.pendingCode;
      const status = await this.pollStatus(session, sentCode);
      if (signal.aborted) return;
      switch (status.status) {
        case "scaned":
          awaitingCode = false;
          session.pendingCode = null;
          this.show(session, "scanned", t("server.weixinLogin.scanned"));
          break;
        case "need_verifycode":
          // 这次请求还没带上刚输入的验证码:立即带上重试,不算输错。
          if (!sentCode && session.pendingCode) continue;
          awaitingCode = true;
          session.pendingCode = null;
          this.show(session, "need_verify", t(sentCode ? "server.weixinLogin.codeMismatch" : "server.weixinLogin.enterCode"));
          continue;
        case "expired":
        case "verify_code_blocked": {
          awaitingCode = false;
          session.pendingCode = null;
          session.codes += 1;
          if (session.codes > MAX_QR_CODES) {
            this.finish(session, "failed", t("server.weixinLogin.qrExhausted"));
            return;
          }
          try {
            const qr = await this.fetchQr(signal);
            Object.assign(session, qr, { qrModules: qrModules(qr.qrUrl), baseUrl: WEIXIN_API_BASE });
          } catch (error) {
            if (signal.aborted) return;
            this.finish(session, "failed", t("server.weixinLogin.refreshFailed", { error: error instanceof Error ? error.message : String(error) }));
            return;
          }
          this.show(session, "waiting", t(status.status === "expired" ? "server.weixinLogin.qrExpired" : "server.weixinLogin.codeBlocked"));
          break;
        }
        case "scaned_but_redirect":
          if (status.redirect_host) session.baseUrl = `https://${status.redirect_host}`;
          break;
        case "binded_redirect": {
          const existing = await this.deps.loadAccount().catch(() => null);
          if (existing) this.finish(session, "confirmed", t("server.weixinLogin.boundLocal"));
          else this.finish(session, "failed", t("server.weixinLogin.boundElsewhere"));
          return;
        }
        case "confirmed": {
          if (!status.bot_token || !status.ilink_bot_id) {
            this.finish(session, "failed", t("server.weixinLogin.noCredentials"));
            return;
          }
          const account: WeixinAccount = {
            botId: status.ilink_bot_id,
            token: status.bot_token,
            baseUrl: status.baseurl?.trim() || WEIXIN_API_BASE,
            userId: status.ilink_user_id ?? null,
            savedAt: new Date().toISOString(),
          };
          try {
            await this.deps.onConfirmed(account);
          } catch (error) {
            console.error("[superagent] weixin account save failed", error);
            this.finish(session, "failed", t("server.weixinLogin.saveFailed"));
            return;
          }
          this.finish(session, "confirmed", t("server.weixinLogin.loggedIn", { botId: account.botId }));
          return;
        }
        default:
          break;
      }
      await sleep(this.pollIntervalMs, signal);
    }
    if (!signal.aborted) this.finish(session, "failed", t("server.weixinLogin.timeout"));
  }
}
