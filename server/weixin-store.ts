import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { resolvePaseoHome } from "./store";

/**
 * 微信通道的本机持久化:扫码得到的 bot 凭证与长轮询游标。
 * 凭证不进插件设置——只留在 daemon 所在主机(0600),客户端只能看到账号 ID。
 *
 *   $PASEO_HOME/plugin-data/superagent/weixin/account.json  bot 凭证
 *   $PASEO_HOME/plugin-data/superagent/weixin/sync.json     get_updates_buf 游标(按 botId)
 */

const AccountSchema = z.object({
  botId: z.string().min(1),
  token: z.string().min(1),
  baseUrl: z.string().url(),
  /** 扫码人的微信用户 ID:自动放进白名单。 */
  userId: z.string().nullish(),
  savedAt: z.string(),
});
export type WeixinAccount = z.infer<typeof AccountSchema>;

const CursorSchema = z.object({ botId: z.string(), cursor: z.string() });

function weixinDir(): string {
  return path.join(resolvePaseoHome(), "plugin-data", "superagent", "weixin");
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf-8"));
  } catch {
    return null;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(value), { encoding: "utf-8", mode: 0o600 });
  await rename(tmp, file);
  await chmod(file, 0o600).catch(() => {});
}

export async function loadWeixinAccount(): Promise<WeixinAccount | null> {
  const parsed = AccountSchema.safeParse(await readJson(path.join(weixinDir(), "account.json")));
  return parsed.success ? parsed.data : null;
}

export async function saveWeixinAccount(account: WeixinAccount): Promise<void> {
  const previous = await loadWeixinAccount();
  await writeJson(path.join(weixinDir(), "account.json"), account);
  // 换了 bot 账号,旧游标作废。
  if (previous && previous.botId !== account.botId) await rm(path.join(weixinDir(), "sync.json"), { force: true });
}

export async function clearWeixinAccount(): Promise<void> {
  await rm(path.join(weixinDir(), "account.json"), { force: true });
  await rm(path.join(weixinDir(), "sync.json"), { force: true });
}

export async function loadWeixinCursor(botId: string): Promise<string> {
  const parsed = CursorSchema.safeParse(await readJson(path.join(weixinDir(), "sync.json")));
  return parsed.success && parsed.data.botId === botId ? parsed.data.cursor : "";
}

export async function saveWeixinCursor(botId: string, cursor: string): Promise<void> {
  await writeJson(path.join(weixinDir(), "sync.json"), { botId, cursor });
}
