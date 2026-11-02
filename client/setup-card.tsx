import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { useSettings, type PluginHostProps } from "@getpaseo/plugin/client";
import type { SettingsState } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { superagentSettings, type SuperagentSettingsValues } from "../shared/settings";

type Ready = Extract<SettingsState<typeof superagentSettings.schema>, { status: "ready" }>;

/** 配置卡:provider/工作目录/隔离方式等。未配置时置顶显示。 */
export function SetupCard(props: PluginHostProps & { required: boolean }) {
  const { theme, layout, required } = props;
  const settings = useSettings(superagentSettings);
  const gap = layout.compact ? 8 : 12;

  if (settings.status !== "ready") {
    return (
      <SettingsCard>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>
          设置加载中…(首次使用需完成配置)
        </Text>
      </SettingsCard>
    );
  }

  return <SetupForm settings={settings} theme={theme} gap={gap} required={required} />;
}

function SetupForm({
  settings,
  theme,
  gap,
  required,
}: {
  settings: Ready;
  theme: PluginHostProps["theme"];
  gap: number;
  required: boolean;
}) {
  const [draft, setDraft] = useState<SuperagentSettingsValues>(settings.values);
  const [open, setOpen] = useState(required);
  const change = useCallback(<K extends keyof SuperagentSettingsValues>(key: K, value: SuperagentSettingsValues[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  }, []);
  const save = useCallback(async () => {
    await settings.save(draft, settings.revision);
  }, [draft, settings]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings.values);

  if (!open) {
    return (
      <SettingsCard>
        <SettingsAction
          label={`工作目录 ${settings.values.workingDir || "(未配置)"}`}
          actionLabel="配置"
          onPress={() => setOpen(true)}
        />
      </SettingsCard>
    );
  }

  return (
    <SettingsCard>
      {required && (
        <Text style={{ color: theme.colors.statusWarning, fontSize: 13, marginBottom: gap }}>
          完成以下配置后 Superagent 才能工作。provider 留空将自动选用宿主上可用的默认。
        </Text>
      )}
      <SettingsInput
        label="工作目录(绝对路径,Worker worktree 的基准仓库)"
        initialValue={draft.workingDir}
        onChangeText={(value) => change("workingDir", value)}
        disabled={settings.saving}
      />
      <SettingsInput
        label="Router provider/model(留空自动)"
        initialValue={draft.routerProvider}
        onChangeText={(value) => change("routerProvider", value)}
        disabled={settings.saving}
      />
      <SettingsInput
        label="Worker provider/model(留空自动)"
        initialValue={draft.workerProvider}
        onChangeText={(value) => change("workerProvider", value)}
        disabled={settings.saving}
      />
      <SettingsSelect
        label="Worker 隔离"
        value={draft.workerIsolation}
        options={[
          { label: "Worktree 独立工作区", value: "worktree" },
          { label: "共享目录", value: "shared" },
        ]}
        onValueChange={(value) => change("workerIsolation", value)}
        disabled={settings.saving}
      />
      <SettingsInput
        label="Worker 超时(分钟)"
        initialValue={String(draft.workerTimeoutMin)}
        onChangeText={(value) => change("workerTimeoutMin", Number.parseInt(value, 10) || 0)}
        disabled={settings.saving}
      />
      <SettingsSwitch
        label="向所有 agent 注入 superagent 委派 MCP(独立于 Paseo tools 开关)"
        value={draft.agentToolEnabled}
        onValueChange={(value) => change("agentToolEnabled", value)}
        disabled={settings.saving}
      />
      {draft.agentToolEnabled && (
        <SettingsInput
          label="注入的 provider(逗号分隔;留空 = claude,codex,opencode,omp,copilot)"
          initialValue={draft.agentToolProviders}
          onChangeText={(value) => change("agentToolProviders", value)}
          disabled={settings.saving}
        />
      )}
      <SettingsSwitch
        label="飞书触发源(长连接;私聊直答,群聊需 @ 机器人)"
        value={draft.feishuEnabled}
        onValueChange={(value) => change("feishuEnabled", value)}
        disabled={settings.saving}
      />
      {draft.feishuEnabled && (
        <>
          <SettingsInput
            label="飞书 App ID"
            initialValue={draft.feishuAppId}
            onChangeText={(value) => change("feishuAppId", value)}
            disabled={settings.saving}
          />
          <SettingsInput
            label="飞书 App Secret"
            initialValue={draft.feishuAppSecret}
            onChangeText={(value) => change("feishuAppSecret", value)}
            disabled={settings.saving}
          />
          <SettingsInput
            label="允许的发送者 open_id(逗号分隔)"
            initialValue={draft.feishuAllowUsers}
            onChangeText={(value) => change("feishuAllowUsers", value)}
            disabled={settings.saving}
          />
          <SettingsInput
            label="允许的会话 chat_id(逗号分隔)"
            initialValue={draft.feishuAllowChats}
            onChangeText={(value) => change("feishuAllowChats", value)}
            disabled={settings.saving}
          />
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
            白名单为空时不会启动(防陌生人触发)。保存后自动重连。
          </Text>
        </>
      )}
      <SettingsSwitch
        label="QQ 触发源(OneBot 11 / NapCat 正向 WebSocket)"
        value={draft.qqEnabled}
        onValueChange={(value) => change("qqEnabled", value)}
        disabled={settings.saving}
      />
      {draft.qqEnabled && (
        <>
          <SettingsInput
            label="OneBot WebSocket 地址(如 ws://127.0.0.1:3001)"
            initialValue={draft.qqEndpoint}
            onChangeText={(value) => change("qqEndpoint", value)}
            disabled={settings.saving}
          />
          <SettingsInput
            label="OneBot Access Token(可为空)"
            initialValue={draft.qqToken}
            onChangeText={(value) => change("qqToken", value)}
            disabled={settings.saving}
          />
          <SettingsInput
            label="允许的发送者 QQ 号(逗号分隔)"
            initialValue={draft.qqAllowUsers}
            onChangeText={(value) => change("qqAllowUsers", value)}
            disabled={settings.saving}
          />
          <SettingsInput
            label="允许的群号(逗号分隔;群里需 @ 机器人)"
            initialValue={draft.qqAllowGroups}
            onChangeText={(value) => change("qqAllowGroups", value)}
            disabled={settings.saving}
          />
        </>
      )}
      <SettingsSwitch
        label="钉钉触发源(Stream 模式长连接,免公网;群里被 @ 触发)"
        value={draft.dingtalkEnabled}
        onValueChange={(value) => change("dingtalkEnabled", value)}
        disabled={settings.saving}
      />
      {draft.dingtalkEnabled && (
        <>
          <SettingsInput
            label="钉钉 AppKey(ClientId)"
            initialValue={draft.dingtalkClientId}
            onChangeText={(value) => change("dingtalkClientId", value)}
            disabled={settings.saving}
          />
          <SettingsInput
            label="钉钉 AppSecret(ClientSecret)"
            initialValue={draft.dingtalkClientSecret}
            onChangeText={(value) => change("dingtalkClientSecret", value)}
            disabled={settings.saving}
          />
          <SettingsInput
            label="允许的发送者 staffId(逗号分隔)"
            initialValue={draft.dingtalkAllowUsers}
            onChangeText={(value) => change("dingtalkAllowUsers", value)}
            disabled={settings.saving}
          />
          <SettingsInput
            label="允许的会话 conversationId(逗号分隔)"
            initialValue={draft.dingtalkAllowChats}
            onChangeText={(value) => change("dingtalkAllowChats", value)}
            disabled={settings.saving}
          />
        </>
      )}
      <SettingsSwitch
        label="企业微信触发源(智能机器人长连接,免公网)"
        value={draft.wecomEnabled}
        onValueChange={(value) => change("wecomEnabled", value)}
        disabled={settings.saving}
      />
      {draft.wecomEnabled && (
        <>
          <SettingsInput
            label="企微机器人 botId"
            initialValue={draft.wecomBotId}
            onChangeText={(value) => change("wecomBotId", value)}
            disabled={settings.saving}
          />
          <SettingsInput
            label="企微机器人 Secret"
            initialValue={draft.wecomSecret}
            onChangeText={(value) => change("wecomSecret", value)}
            disabled={settings.saving}
          />
          <SettingsInput
            label="允许的发送者 userid(逗号分隔)"
            initialValue={draft.wecomAllowUsers}
            onChangeText={(value) => change("wecomAllowUsers", value)}
            disabled={settings.saving}
          />
          <SettingsInput
            label="允许的群 chatid(逗号分隔;群里需 @ 机器人)"
            initialValue={draft.wecomAllowChats}
            onChangeText={(value) => change("wecomAllowChats", value)}
            disabled={settings.saving}
          />
        </>
      )}
      <SettingsAction
        label={dirty ? "有未保存的修改" : "设置与宿主同步"}
        actionLabel={settings.saving ? "保存中…" : "保存"}
        disabled={settings.saving || !dirty}
        onPress={() => void save()}
      />
      {settings.saveError && (
        <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{settings.saveError}</Text>
      )}
      <SettingsAction
        label="收起配置"
        actionLabel="收起"
        onPress={() => {
          setDraft(settings.values);
          setOpen(false);
        }}
      />
    </SettingsCard>
  );
}
