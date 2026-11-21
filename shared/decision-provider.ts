/**
 * 只裁决会话(Router / 看门狗)的 provider 限制。
 *
 * 这两个角色只把事件读成 JSON 裁决,不需要工具:它们必须能在不执行命令、不读工作区的
 * 前提下评估消息。Paseo 的权限钩子只在 provider 发出权限请求时触发,而沙箱允许的读
 * 操作不会发请求;因此"只读沙箱"挡不住读,只有真正不带工具的会话才算隔离。
 *
 * Codex 目前没有关闭工具的入口:Paseo 的 Codex providerOptions 是 strict 白名单
 * (service_tier / plan_mode / approval_policy / sandbox_mode / sandbox_workspace_write /
 * web_search / features),Codex app-server 的 ToolsV2 只覆盖 web_search,模式预设也没有
 * "无工具"档。把 Codex 配成 read-only 仍能读工作区,所以它不能担任只裁决角色。
 *
 * 其余 provider 由各自的工具限制或 agent.permission.before 钩子挡在工具之外:claude
 * 由 providerOptions.disallowedTools 加钩子、pi 由 pi 扩展裁剪工具、其余依赖权限钩子拒绝。
 */
export const DECISION_ONLY_EXCLUDED_PROVIDERS: readonly string[] = ["codex"];

/** provider 段:`provider` 或 `provider/model` 的第一个 `/` 之前。 */
export function providerNameOf(selection: string): string {
  return selection.split("/")[0]?.trim() ?? "";
}

/**
 * 该 provider 能否担任只裁决角色(Router / 看门狗)。空选择(自动挑选)返回 true:
 * 自动挑选由引擎跳过受限 provider,这里只管人显式填写或沿用的值。
 */
export function providerCanDecideOnly(selection: string): boolean {
  const name = providerNameOf(selection);
  if (!name) return true;
  return !DECISION_ONLY_EXCLUDED_PROVIDERS.includes(name);
}

/** 人填写了受限 provider 时的错误说明。 */
export function decisionOnlyProviderError(role: string, selection: string): string {
  return `${role} provider "${selection}" cannot run as a decision-only session: `
    + `"${providerNameOf(selection)}" always exposes tools, so it could read the workspace while deciding. `
    + `Use a provider whose tools the plugin can withhold (for example claude, opencode or pi), `
    + `or leave the setting empty to pick one automatically.`;
}
