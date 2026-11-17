import { z } from "zod";

/**
 * pi 的权限模式来自 pi-permission-modes 扩展(https://pi.dev/packages/pi-permission-modes):
 * 模式定义在 `$PI_CODING_AGENT_DIR/permission-mode/permission-mode.json`(默认
 * `~/.pi/agent/permission-mode/permission-mode.json`),由扩展在会话启动时按
 * `--perm` 旗标 / 会话记忆 / `PI_PERMISSION_MODE` 环境变量决定初始模式。
 *
 * Paseo 的 pi provider 不上报任何模式(`modes: []`,setMode 直接抛错),所以 provider
 * 选 pi 时「Worker 模式」改读这里的清单;Worker 启动时把选中的模式经
 * `PI_PERMISSION_MODE` 传给 pi 进程。扩展未安装时回退到 Paseo 默认(不传环境变量)。
 */

export const PI_PROVIDER = "pi";

/** pi-permission-modes 读取的初始模式环境变量。 */
export const PI_PERMISSION_MODE_ENV = "PI_PERMISSION_MODE";

/** npm 包名 / pi settings.json 里 packages 的来源前缀。 */
export const PI_PERMISSION_MODES_PACKAGE = "pi-permission-modes";

export const PiPermissionModeSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
});

export type PiPermissionMode = z.infer<typeof PiPermissionModeSchema>;

export const PiPermissionModesSchema = z.object({
  /** pi-permission-modes 是否安装;false 时设置页只剩「Paseo 默认」。 */
  available: z.boolean(),
  modes: z.array(PiPermissionModeSchema),
  /** 扩展配置的默认模式;留空时选择「Paseo 默认」实际就是它。 */
  defaultModeId: z.string().nullable(),
});

export type PiPermissionModes = z.infer<typeof PiPermissionModesSchema>;

export const UNAVAILABLE_PI_PERMISSION_MODES: PiPermissionModes = {
  available: false,
  modes: [],
  defaultModeId: null,
};

/** 扩展自带的四个内置模式(扩展未初始化配置时生效)。 */
export const STOCK_PI_PERMISSION_MODES: readonly PiPermissionMode[] = [
  { id: "default", label: "Default" },
  { id: "plan", label: "Plan Mode" },
  { id: "build", label: "Build" },
  { id: "yolo", label: "YOLO" },
];

/** provider 选择(`provider` 或 `provider/model`)是否属于 pi 家族。 */
export function isPiProviderSelection(selection: string): boolean {
  return selection.split("/", 1)[0].trim() === PI_PROVIDER;
}

const UNSAFE_MODE_IDS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_MODE_ID_CHARS = 200;

function usableModeId(id: string): boolean {
  return id.length > 0 && id.length <= MAX_MODE_ID_CHARS && !/\s/.test(id) && !UNSAFE_MODE_IDS.has(id);
}

function modeLabel(id: string, definition: unknown): string | null {
  if (typeof definition === "string" && definition.trim()) return definition.trim();
  if (!definition || typeof definition !== "object") return null;
  const raw = definition as { label?: unknown; name?: unknown };
  for (const candidate of [raw.label, raw.name]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}

function modeEntries(value: unknown): [string, unknown][] {
  if (Array.isArray(value)) {
    const entries: [string, unknown][] = [];
    for (const item of value) {
      if (typeof item === "string") entries.push([item, {}]);
      else if (item && typeof item === "object") {
        const id = (item as { id?: unknown }).id;
        if (typeof id === "string") entries.push([id, item]);
      }
    }
    return entries;
  }
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).filter(([id]) => !UNSAFE_MODE_IDS.has(id));
}

/**
 * 把扩展配置归一成可展示的模式清单。与扩展自己的合并规则一致:用户配置覆盖同名
 * 内置模式的 label,`cycleOrder` 里的模式排在最前,其余按内置顺序 + 配置声明顺序;
 * 配置里的 `defaultMode` 不在清单中时退回清单首个模式。
 */
export function normalizePiPermissionModes(raw: unknown): {
  modes: PiPermissionMode[];
  defaultModeId: string | null;
} {
  const config =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const overrides = new Map<string, PiPermissionMode>();
  const declared: string[] = [];
  for (const [id, definition] of modeEntries(config.modes)) {
    if (!usableModeId(id)) continue;
    if (!declared.includes(id)) declared.push(id);
    const stock = STOCK_PI_PERMISSION_MODES.find((mode) => mode.id === id);
    overrides.set(id, { id, label: modeLabel(id, definition) ?? stock?.label ?? id });
  }

  const modes: PiPermissionMode[] = [];
  const seen = new Set<string>();
  const push = (id: string) => {
    if (seen.has(id)) return;
    const stock = STOCK_PI_PERMISSION_MODES.find((mode) => mode.id === id);
    const custom = overrides.get(id);
    if (!custom && !stock) return;
    seen.add(id);
    modes.push({ id, label: custom?.label ?? stock?.label ?? id });
  };
  const cycleOrder = Array.isArray(config.cycleOrder)
    ? config.cycleOrder.filter((id): id is string => typeof id === "string")
    : [];
  for (const id of cycleOrder) push(id);
  for (const mode of STOCK_PI_PERMISSION_MODES) push(mode.id);
  for (const id of declared) push(id);

  const requested = typeof config.defaultMode === "string" ? config.defaultMode : "";
  const defaultModeId = modes.some((mode) => mode.id === requested)
    ? requested
    : (modes[0]?.id ?? null);
  return { modes, defaultModeId };
}
