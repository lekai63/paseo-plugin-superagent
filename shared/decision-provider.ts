/** Codex 的只读沙箱允许无需权限请求的读操作，因此排除在 Router 与看门狗之外。 */
export function isDecisionProviderExcluded(selection: string): boolean {
  return selection.split("/", 1)[0].trim() === "codex";
}
