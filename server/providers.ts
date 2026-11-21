/**
 * provider/model 设置校验:对照 daemon 的 provider 快照把用户填写的 `provider/model`
 * 解析成真实可用的选择。
 *
 * 典型坑:ACP 系 provider 的 model id 自带反斜杠(如 zcode-acp 的
 * `builtin:bigmodel-coding-plan\GLM-5.3-Flash`),从 config.json 复制时会带上 JSON
 * 转义变成 `\\`;未知 model 传给 ACP agent 只会得到一句 "Internal error"。
 */

export interface ProviderSnapshotEntryLike {
  provider: string;
  enabled?: boolean;
  status?: string;
  models?: ReadonlyArray<{ id: string; isDefault?: boolean }> | null;
  modes?: ReadonlyArray<{ id: string }> | null;
}

/** 扩展档:模型自带 thinking 档位清单时,设置校验能提前发现非法档位。 */
export interface ProviderThinkingEntryLike extends ProviderSnapshotEntryLike {
  models?: ReadonlyArray<{
    id: string;
    isDefault?: boolean;
    thinkingOptions?: ReadonlyArray<{ id: string }> | null;
  }> | null;
}

/**
 * 显式 thinking 档位必须属于所选 provider 的模型。与 validateProviderMode 同风格:
 * 快照未就绪/provider 未上报 thinking 清单/模型不在快照中时不在插件层拦截,交由 Paseo 创建时兜底。
 */
export function validateProviderThinkingOption(
  selection: string,
  thinkingOptionId: string,
  entries: ReadonlyArray<ProviderThinkingEntryLike>,
): void {
  if (!thinkingOptionId) return;
  const [provider, modelId] = selection.split("/");
  const entry = entries.find((candidate) => candidate.provider === provider);
  if (!entry || entry.status !== "ready" || !entry.models) return;
  // provider/model 二段式只看该模型;裸 provider 看任一模型(允许 model 级差异)。
  const candidates = modelId ? entry.models.filter((model) => model.id === modelId) : entry.models;
  if (modelId && candidates.length === 0) return;
  const reported = candidates.filter((model) => Array.isArray(model.thinkingOptions));
  if (reported.length === 0) return; // 该模型/provider 未上报 thinking 清单:创建时兜底
  if (reported.some((model) => model.thinkingOptions!.some((option) => option.id === thinkingOptionId))) return;
  const available = [...new Set(reported.flatMap((model) => model.thinkingOptions!.map((option) => option.id)))].join(", ") || "none";
  throw new Error(
    `thinking option "${thinkingOptionId}" is not offered by provider "${selection}" (available: ${available})`,
  );
}

/** 显式模式必须属于当前 provider;清单尚未就绪时交由 Paseo 在创建时校验。 */
export function validateProviderMode(
  selection: string,
  modeId: string,
  entries: ReadonlyArray<ProviderSnapshotEntryLike>,
): void {
  if (!modeId) return;
  const provider = selection.split("/", 1)[0];
  const entry = entries.find((candidate) => candidate.provider === provider);
  if (!entry || entry.status !== "ready" || !entry.modes) return;
  if (!entry.modes.some((mode) => mode.id === modeId)) {
    const available = entry.modes.map((mode) => mode.id).join(", ") || "none";
    throw new Error(`mode "${modeId}" is not offered by provider "${provider}" (available: ${available})`);
  }
}

export type ProviderSelectionResult =
  | { selection: string; note?: string }
  | { error: string };

export function resolveProviderSelection(
  raw: string,
  entries: ReadonlyArray<ProviderSnapshotEntryLike>,
): ProviderSelectionResult {
  const trimmed = raw.trim();
  const separator = trimmed.indexOf("/");
  const provider = (separator === -1 ? trimmed : trimmed.slice(0, separator)).trim();
  const model = separator === -1 ? "" : trimmed.slice(separator + 1).trim();
  if (!provider) return { error: `expected "provider/model", got "${trimmed}"` };

  const entry = entries.find((candidate) => candidate.provider === provider);
  if (!entry) {
    const known = entries.map((candidate) => candidate.provider).join(", ") || "none";
    return { error: `provider "${provider}" is not available on this host (known: ${known})` };
  }
  if (entry.enabled === false) return { error: `provider "${provider}" is disabled on this host` };

  const models = entry.models ?? [];
  if (models.length === 0) {
    // 快照没有模型清单时无从校验,显式填写的 model 原样放行。
    if (model) return { selection: `${provider}/${model}` };
    return {
      error: `provider "${provider}" reports no models (status: ${entry.status ?? "unknown"}); set it as "provider/model"`,
    };
  }

  if (!model) {
    const fallback = models.find((candidate) => candidate.isDefault) ?? models[0];
    return { selection: `${provider}/${fallback.id}` };
  }
  if (models.some((candidate) => candidate.id === model)) {
    return { selection: `${provider}/${model}` };
  }

  const collapsed = model.replace(/\\{2,}/g, "\\");
  if (collapsed !== model && models.some((candidate) => candidate.id === collapsed)) {
    return {
      selection: `${provider}/${collapsed}`,
      note: `model "${model}" normalized to "${collapsed}" (collapsed escaped backslashes)`,
    };
  }

  const available = models.map((candidate) => candidate.id).join(", ");
  return { error: `model "${model}" is not offered by provider "${provider}" (available: ${available})` };
}

/**
 * 先按首选顺序选择 provider，再回退到快照中的第一个候选。
 */
export function pickPreferredProvider<T extends ProviderSnapshotEntryLike>(
  entries: ReadonlyArray<T>,
  preferred: readonly string[],
): T | undefined {
  for (const provider of preferred) {
    const entry = entries.find((candidate) => candidate.provider === provider);
    if (entry) return entry;
  }
  return entries[0];
}

export interface WorkerProfileLike {
  name: string;
}

export interface WorkerProfileChoice {
  /** 选中的档位名;null = 默认 Worker。 */
  profile: string | null;
  /** 请求的档位不存在而退回默认 Worker 时的说明(记入裁决,供人审计)。 */
  note: string | null;
}

/**
 * 把 Router 在 dispatch 里填写的档位名对到设置名单上。省略、`default` 与未知名字都落到
 * 默认 Worker:Router 永远只能用到人配置过的 provider,名字写错不会让派发失败。
 */
export function matchWorkerProfile(
  requested: string | null | undefined,
  profiles: ReadonlyArray<WorkerProfileLike>,
  defaultName = "default",
): WorkerProfileChoice {
  const wanted = requested?.trim().toLowerCase() ?? "";
  if (!wanted || wanted === defaultName) return { profile: null, note: null };
  const match = profiles.find((profile) => profile.name === wanted);
  if (match) return { profile: match.name, note: null };
  const known = profiles.map((profile) => profile.name).join(", ") || "none";
  return {
    profile: null,
    note: `unknown worker profile "${truncateName(requested ?? "")}" (configured: ${known}); used the default worker`,
  };
}

function truncateName(name: string): string {
  const trimmed = name.trim();
  return trimmed.length > 40 ? `${trimmed.slice(0, 39)}…` : trimmed;
}
