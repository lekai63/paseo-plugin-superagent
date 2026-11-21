# Pi 集成

[← 返回 README](../README.md) · [English](pi-EN.md)

pi 家族（`pi`、`pi/<model>`）作为 Worker provider 或委派注入对象时，与其他 provider 走同一条标准 MCP 注入：插件在 `session_open` 时把本地 MCP server（`127.0.0.1` 随机端口 + 随机密钥路径，按 URL query 区分角色）写进会话的 `mcpServers`，无需安装任何扩展。

- **Worker**：拿到 `superagent_unsubscribe` / `superagent_handback`（退订直通、消息转回）。
- **普通 pi 会话**：在设置「注入 provider」里显式填 `pi` 后，拿到 `superagent_dispatch` 委派工具（默认名单不含 pi）。

与 pi 自身 MCP 设计的关系：pi 不经扩展通道强行把工具 `exposure: "direct"` 声明给模型，而是遵从 pi 默认的 **codemode** 档——工具经 codemode 脚本按需调用（懒加载，不占工具声明位）。插件为此在 MCP server 上按角色下发 `instructions`（pi 会在系统提示的 `mcp_servers` 区段以其首行描述该 server），Worker 的首条 prompt 也写明了这一调用形态。

MCP 注入要求 pi ≥ 1.5（daemon 检测到 pi 自带 `/mcp` 才走内置注入通道）。老 pi 主机上带工具的会话会启动失败，与其他不支持 MCP 的 provider 行为一致，此时升级 pi 或改用其他 Worker provider。插件重载后端口与密钥轮换，URL 在下次 `session_open` 时自动刷新。

**Worker 模式**：Paseo 的 pi provider 没有可选模式（`modes: []`，`setMode` 直接报错），所以设置页在 provider 选 pi 时不再使用快照，而是读取本机 [pi-permission-modes](https://pi.dev/packages/pi-permission-modes) 扩展的模式清单（daemon 读 `PI_CODING_AGENT_DIR` 或 `~/.pi/agent` 下的 `permission-mode/permission-mode.json`，与扩展内置的 default/plan/build/yolo 合并；扩展从 `settings.json` 的 `packages` 或 `npm/node_modules` 判断是否安装）。选中的模式经 `PI_PERMISSION_MODE` 环境变量传给 Worker，Paseo 通过 `launchEnv` 在会话恢复时保留它。扩展未安装时只剩「Paseo 默认」，Worker 按 pi 自己的 `defaultMode` 启动。
