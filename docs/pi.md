# Pi 集成（Worker 与委派）

[← 返回 README](../README-CN.md) · [English](pi-EN.md)

Pi Worker 和普通 Pi 会话可使用随附扩展接收 Superagent 工具。插件在会话启动时通过环境变量提供本地 MCP URL，扩展将工具直接注册给模型。

```bash
cp pi-extension/superagent.js ~/.pi/agent/extensions/
```

这是手动复制的副本:`paseo plugin update` 只更新插件 checkout,不会更新 `~/.pi/agent/extensions/superagent.js`,扩展有变更时要重新复制。

没有 `SUPERAGENT_PI_MCP_URL` 时扩展保持休眠。Worker 可退订或转回，启用委派注入的普通 Pi 会话可派发任务。


**Worker 模式**:Paseo 的 pi provider 没有可选模式(`modes: []`,`setMode` 直接报错),所以设置页在 provider 选 pi 时不再使用快照,而是读取本机 [pi-permission-modes](https://pi.dev/packages/pi-permission-modes) 扩展的模式清单(daemon 读 `PI_CODING_AGENT_DIR` 或 `~/.pi/agent` 下的 `permission-mode/permission-mode.json`,与扩展内置的 default/plan/build/yolo 合并;扩展从 `settings.json` 的 `packages` 或 `npm/node_modules` 判断是否安装)。选中的模式在创建 Worker 时写入 `PI_PERMISSION_MODE` 环境变量,扩展在会话启动时读取,并在 Paseo 恢复会话时随 launchEnv 沿用;未安装该扩展时设置页只剩「Paseo 默认」,Worker 按 pi 自己的 `defaultMode` 启动(不传环境变量)。
