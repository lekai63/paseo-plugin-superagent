import { randomBytes } from "node:crypto";
import { clearTimeout, setTimeout } from "node:timers";

/**
 * 微信 iLink Bot 协议(腾讯官方 ClawBot 通道)的最小 HTTP 客户端。
 * 协议依据 Tencent/openclaw-weixin 的 docs/protocol.md 与 src/api:HTTPS + JSON,
 * Bot 接口 POST、扫码状态 GET;官方包把 openclaw 列为 peer 依赖,无法独立引入,
 * 因此这里按同一协议直接调用(与飞书/钉钉/企微走"同一官方通道、不经 OpenClaw"的取舍一致)。
 */

/** 扫码登录固定从这里开始;登录成功后以服务端返回的 baseurl 为准。 */
export const WEIXIN_API_BASE = "https://ilinkai.weixin.qq.com";
/** 官方插件的 iLink 应用 ID(package.json 的 ilink_appid)。 */
const ILINK_APP_ID = "bot";
/** 所实现的协议版本:对齐参考的官方实现 @tencent-weixin/openclaw-weixin 2.4.10。 */
const PROTOCOL_VERSION = "2.4.10";
/** base_info.bot_agent:只用于对端日志归因,如实标明接入方。 */
const BOT_AGENT = "PaseoSuperagent/0.1.0";

export const WeixinMessageType = { USER: 1, BOT: 2 } as const;
export const WeixinItemType = { TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 } as const;
export const WeixinMessageState = { FINISH: 2 } as const;
/** getupdates 返回此码表示 bot token 失效(官方插件暂停该账号一小时)。 */
export const WEIXIN_STALE_TOKEN_ERRCODE = -14;

/** 微信 CDN 上的一份加密媒体。 */
export interface WeixinCdnMedia {
  encrypt_query_param?: string;
  /** base64:图片为 16 字节原始密钥,文件/语音/视频为 32 位十六进制字符串。 */
  aes_key?: string;
  /** 服务端给出的完整下载地址;缺省时用 encrypt_query_param 拼。 */
  full_url?: string;
}

export interface WeixinMessageItem {
  type?: number;
  msg_id?: string;
  text_item?: { text?: string };
  voice_item?: { text?: string; media?: WeixinCdnMedia };
  /** aeskey:16 字节密钥的十六进制形式,入站解密优先于 media.aes_key。 */
  image_item?: { media?: WeixinCdnMedia; aeskey?: string };
  /** len:明文字节数(十进制字符串)。 */
  file_item?: { media?: WeixinCdnMedia; file_name?: string; len?: string };
  video_item?: { media?: WeixinCdnMedia };
  ref_msg?: { svr_id?: string; title?: string; message_item?: WeixinMessageItem };
}

export interface WeixinMessage {
  /** uint64,经 parseWeixinJson 无损转成字符串。 */
  message_id?: string;
  from_user_id?: string;
  to_user_id?: string;
  group_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: WeixinMessageItem[];
  context_token?: string;
  create_time_ms?: number;
}

export interface GetUpdatesResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

export interface SendMessageResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  message_id?: string;
}

export interface QrCodeResponse {
  qrcode?: string;
  /** 扫码内容(一个 URL):既用来生成二维码,也可直接在手机微信里打开。 */
  qrcode_img_content?: string;
}

export type QrStatus =
  | "wait"
  | "scaned"
  | "confirmed"
  | "expired"
  | "scaned_but_redirect"
  | "need_verifycode"
  | "verify_code_blocked"
  | "binded_redirect";

export interface QrStatusResponse {
  status?: QrStatus;
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  /** 扫码人的微信用户 ID(xxx@im.wechat):默认放进白名单。 */
  ilink_user_id?: string;
  redirect_host?: string;
}

export function baseInfo(): { channel_version: string; bot_agent: string } {
  return { channel_version: PROTOCOL_VERSION, bot_agent: BOT_AGENT };
}

/** iLink-App-ClientVersion:0x00MMNNPP 按十进制字符串发送。 */
function clientVersion(version: string): string {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map((part) => Number.parseInt(part, 10) || 0);
  return String(((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff));
}

/** X-WECHAT-UIN:随机 uint32 的十进制字符串再 base64,每次请求都换。 */
function randomUin(): string {
  return Buffer.from(String(randomBytes(4).readUInt32BE(0)), "utf-8").toString("base64");
}

function appHeaders(): Record<string, string> {
  return { "iLink-App-Id": ILINK_APP_ID, "iLink-App-ClientVersion": clientVersion(PROTOCOL_VERSION) };
}

function postHeaders(token?: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomUin(),
    ...appHeaders(),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

const LOSSLESS_ID_FIELDS = /(?<=[{,]\s*)"(message_id|msg_id|svr_id)"(\s*:\s*)(-?\d+)/g;

/**
 * 解析 iLink JSON,并把 uint64 消息 id 先加引号再交给 JSON.parse,避免精度丢失。
 * 只改对象键:JSON 字符串里的引号必然带反斜杠转义,`{"` / `,"` 不会出现在字符串内容里。
 */
export function parseWeixinJson<T>(raw: string): T {
  return JSON.parse(raw.replace(LOSSLESS_ID_FIELDS, '"$1"$2"$3"')) as T;
}

export interface RequestOptions {
  token?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** 超时与外部取消合并;超时以 AbortError 抛出,由调用方区分。 */
async function request(url: URL, init: RequestInit, label: string, options: RequestOptions): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  timer.unref?.();
  const external = options.signal;
  const onAbort = () => controller.abort();
  if (external?.aborted) controller.abort();
  external?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    // 响应体可能回显凭据,错误里只带状态码。
    if (!response.ok) throw new Error(`weixin ${label} failed: HTTP ${response.status}`);
    return text;
  } finally {
    clearTimeout(timer);
    external?.removeEventListener("abort", onAbort);
  }
}

function endpointUrl(baseUrl: string, endpoint: string): URL {
  return new URL(endpoint, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
}

export async function weixinPost<T>(
  baseUrl: string,
  endpoint: string,
  body: Record<string, unknown>,
  options: RequestOptions,
): Promise<T> {
  const text = await request(
    endpointUrl(baseUrl, endpoint),
    { method: "POST", headers: postHeaders(options.token), body: JSON.stringify(body) },
    endpoint,
    options,
  );
  return parseWeixinJson<T>(text || "{}");
}

export async function weixinGet<T>(baseUrl: string, endpoint: string, options: RequestOptions): Promise<T> {
  const text = await request(endpointUrl(baseUrl, endpoint), { method: "GET", headers: appHeaders() }, endpoint, options);
  return parseWeixinJson<T>(text || "{}");
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
