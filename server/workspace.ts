import type { PaseoApi, PaseoWorkspaceHandle } from "@getpaseo/client";
import { resolve } from "node:path";

/**
 * 共享隔离的持久目录工作区:同一个基础目录只保留一个 workspace,Router 与
 * shared 隔离的 Worker 都在里面建 agent,而不是每次启动都让 daemon 新开一个。
 *
 * 复用顺序:kv 记住的 id(daemon 的 workspace 跨重启持久)→ 按「标题 + 目录」在
 * 活跃工作区里找回 → 新建。标题匹配限定在同一目录,避免误并入人在其他目录
 * 打开的同名工作区;反过来,其他目录上的同名工作区也不会被抢占。
 */

export interface SharedWorkspaceLookup {
  handle: PaseoWorkspaceHandle;
  /** 是否就是 kv 记住的工作区(false = 找回或新建,引擎应更新登记)。 */
  remembered: boolean;
}

export async function ensureSharedWorkspace(
  paseo: PaseoApi,
  rememberedId: string | null | undefined,
  directory: string,
  title: string,
): Promise<SharedWorkspaceLookup> {
  const dir = resolve(directory);
  if (rememberedId) {
    const handle = paseo.workspaces.ref(rememberedId);
    const descriptor = await handle.refresh().catch((error) => {
      console.error("[superagent] shared workspace refresh failed", error);
      return null;
    });
    if (descriptor && !descriptor.archivingAt && resolve(descriptor.workspaceDirectory) === dir) {
      return { handle, remembered: true };
    }
  }
  const found = await findWorkspaceByTitle(paseo, title, dir);
  if (found) return { handle: paseo.workspaces.ref(found.id), remembered: false };
  try {
    const handle = await paseo.workspaces.create({
      title,
      source: { kind: "directory", path: dir },
    });
    return { handle, remembered: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`shared workspace creation failed (directory ${dir}, title "${title}"): ${message}`, {
      cause: error,
    });
  }
}

/** 在活跃工作区里按「已解析标题 + 目录」找回;archiving 中的不算。翻页扫完全部列表。 */
async function findWorkspaceByTitle(
  paseo: PaseoApi,
  title: string,
  dir: string,
): Promise<{ id: string } | null> {
  let cursor: string | undefined;
  try {
    do {
      const result = await paseo.workspaces.list({
        page: { limit: 200, ...(cursor ? { cursor } : {}) },
      });
      const match = result.entries.find(
        (entry) => !entry.archivingAt && entry.name === title && resolve(entry.workspaceDirectory) === dir,
      );
      if (match) return match;
      cursor = result.pageInfo.nextCursor ?? undefined;
    } while (cursor);
  } catch (error) {
    console.error("[superagent] workspace list failed, creating a fresh shared workspace", error);
  }
  return null;
}
