# pi 集成(Router / Worker / 委派入口)

[← 返回 README](../README.md) · [English](pi-EN.md)

pi(pi-coding-agent ≥ 1.5.0)可以担任 Router、看门狗、Worker 的 provider,也可以接收委派注入。pi 家族不走 MCP 注入,原因有二:Paseo→pi 的配置转换不透传 `exposure`,pi 的 MCP 工具会以默认 `codemode` 暴露(模型无法直接调用);pi 也不把工具调用送进 Paseo 权限流,「只裁决」的权限钩子对 pi 不生效。因此 pi 系会话改经 env 下发角色 MCP URL(`SUPERAGENT_PI_MCP_URL` / `SUPERAGENT_PI_ROLE`,每次 session open 都带最新 URL,跟随插件重载后的端口与密钥轮换),由随插件发行的 pi 扩展完成注册与约束:

```bash
cp pi-extension/superagent.js ~/.pi/agent/extensions/
```

这是手动复制的副本:`paseo plugin update` 只更新插件 checkout,不会更新 `~/.pi/agent/extensions/superagent.js`,扩展有变更时要重新复制。

扩展按 env 自门控,没有 `SUPERAGENT_PI_MCP_URL` 时完全休眠,不影响你自己的交互式 pi。对 Router/看门狗会话它做三件事:以 `exposure: "direct"` 注册回读 MCP(三个工具直接声明给模型);在 `before_agent_start` 把 `selectedTools` 原地裁到只剩回读工具(提示词与可执行工具集同步移除 bash/edit 等,并清空 skills 与 AGENTS.md 上下文);`tool_call` 兜底拦截一切非白名单调用(含 codemode 嵌套调用,模型会收到拒绝原因),并执行与服务端同额的调用预算(超额先拒绝并撤掉全部工具,逼模型直接裁决;拒绝后仍继续调用才中止本轮,见[架构与设计](architecture.md#设计取舍与限制)里的「调用预算」)。Worker 与普通 agent 会话只注册各自工具,不裁剪。

未安装扩展时一切照常降级:pi Router 按「回读工具不可用则仅凭提示词裁决」运行,只是没有 Chain of Recall 与硬约束;daemon 日志在首个 pi 编排会话时提示安装。约束级别说明:扩展运行在 pi 进程内,是用户态约束,比 codex 的只读沙箱弱一层,对编排层 Router 足够。Router 规则照常经 systemPrompt 送达(paseo 的 pi provider 以 `before_agent_start` 追加),同一 Thread 的评估复用原生会话;配置变化时重建。
