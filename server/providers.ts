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
