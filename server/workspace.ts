import type { PaseoApi, PaseoAgent, PaseoWorkspaceHandle } from "@getpaseo/client";
import { resolve } from "node:path";

/**
 * 持久目录工作区:同一个基础目录分别保留普通与后台 workspace。Router/看门狗
 * 使用后台工作区,shared 隔离的 Worker 使用普通工作区,避免一起隐藏 Worker。
 *
 * 复用顺序:kv 记住的 id(daemon 的 workspace 跨重启持久)→ 按「标题 + 目录」在
 * 活跃工作区里找回 → 新建。标题匹配限定在同一目录,避免误并入人在其他目录
 * 打开的同名工作区;反过来,其他目录上的同名工作区也不会被抢占。
 */

export const BACKGROUND_WORKSPACE_TITLE = "Superagent 后台";

/** 后台属性只在创建工作区时指定;旧前台角色会话在下次使用时换建。 */
export async function agentUsesBackgroundWorkspace(paseo: PaseoApi, agent: PaseoAgent): Promise<boolean> {
  if (!agent.workspaceId) return false;
  const workspace = await paseo.workspaces.ref(agent.workspaceId).refresh();
  if (!workspace) throw new Error(`agent workspace ${agent.workspaceId} is unavailable`);
  return workspace.background === true;
}

/**
 * 旧角色与 shared Worker 曾同处普通工作区;归档父 agent 会级联归档同区子 agent。
 * 换建前先解除全部子会话的父子关系,票据与引擎的观察/直通仍按原 agent ID 继续。
 * 先收齐分页再 detach,避免修改标签令后续页游标失效;失败则保留旧角色等待重试。
 */
export async function detachRoleChildren(paseo: PaseoApi, parentId: string): Promise<void> {
  const children = new Set<string>();
  let cursor: string | undefined;
  do {
    const result = await paseo.agents.list({
      filter: { includeBackground: true, labels: { "paseo.parent-agent-id": parentId } },
      page: { limit: 200, ...(cursor ? { cursor } : {}) },
    });
    for (const { agent } of result.entries) {
      if (!agent.archivedAt) children.add(agent.id);
    }
    cursor = result.pageInfo.nextCursor ?? undefined;
  } while (cursor);
  for (const id of children) await paseo.agents.ref(id).detach();
}

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
  background = false,
): Promise<SharedWorkspaceLookup> {
  const dir = resolve(directory);
  if (rememberedId) {
    const handle = paseo.workspaces.ref(rememberedId);
    const descriptor = await handle.refresh().catch((error) => {
      console.error("[superagent] shared workspace refresh failed", error);
      return null;
    });
    if (descriptor && !descriptor.archivingAt && resolve(descriptor.workspaceDirectory) === dir
      && (descriptor.background === true) === background) {
      return { handle, remembered: true };
    }
  }
  const found = await findWorkspaceByTitle(paseo, title, dir, background);
  if (found) return { handle: paseo.workspaces.ref(found.id), remembered: false };
  try {
    const handle = await paseo.workspaces.create({
      title,
      background,
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
  background: boolean,
): Promise<{ id: string } | null> {
  let cursor: string | undefined;
  try {
    do {
      const result = await paseo.workspaces.list({
        filter: { includeBackground: background },
        page: { limit: 200, ...(cursor ? { cursor } : {}) },
      });
      const match = result.entries.find(
        (entry) => !entry.archivingAt && entry.name === title && resolve(entry.workspaceDirectory) === dir
          && (entry.background === true) === background,
      );
      if (match) return match;
      cursor = result.pageInfo.nextCursor ?? undefined;
    } while (cursor);
  } catch (error) {
    console.error("[superagent] workspace list failed, creating a fresh shared workspace", error);
  }
  return null;
}
