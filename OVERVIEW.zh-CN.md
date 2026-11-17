# Superagent

Superagent 让 Paseo 成为事件驱动的编排器。每个活跃对话有一个 Router agent 读取新消息并决定怎么处理;需要动手的工作交给 Worker agent,在独立的 worktree 或共享目录里执行,完成后汇报回对话。

## 工作方式

- **Router**:每个对话一个 Router 会话,适合用轻量模型。它以 JSON 动作作答:派发 Worker、转向或取消 Worker、重试、回答 Worker 的权限请求或提问、让 Worker 订阅本对话、答复、忽略或结束。除插件自身的只读回读与检索工具外,Router 调用的其他工具都会被权限钩子拒绝。
- **Worker**:每个 Ticket 启动一个 Worker 会话,适合用更强的模型,挂在 Router 名下。Worker 在 app 里可见,可随时人工接管。具名 Worker 档位让 Router 按任务选择不同的 provider、模型、模式、thinking 档位或工作目录。
- **直通**:Worker 订阅了某个对话时,后续消息不经模型直接送达它。
- **看门狗**:内置检查每 15 秒运行一次,找回错过的完成、卡住的启动、超时与待执行动作,daemon 重启后同样生效。可选的 LLM 看门狗按间隔检查任务进展。
- **触发来源**:插件对话页、任意 agent 会话里的 `/superagent` 斜杠命令、可选注入到 agent 会话的 `superagent_dispatch` 工具,以及可选的 IM 通道:飞书、钉钉、企业微信、微信(腾讯 ClawBot / iLink)与 QQ(OneBot 11,经 NapCat)。

## 配置

- daemon 与各端客户端需要 Paseo 0.16.0 或更新版本;daemon 主机需要 Node.js 20 或更新版本及 npm。
- 打开 **Settings → Plugins → Superagent**,填写工作目录(daemon 主机上的绝对路径)。`worktree` 隔离要求它位于 git 仓库内,`shared` 隔离不需要。
- 为 Router 与默认 Worker 选择 provider 与模型;留空时按 claude → codex → opencode → 其他的顺序自动选用可用的 provider。
- 各 IM 通道默认关闭。开启时需要对应平台的机器人凭据,以及发送者或会话白名单;白名单为空的通道不会启动。微信通过扫描设置页里的二维码登录。
- 用 pi 担任 Router 或 Worker 时,需要把随插件发行的 pi 扩展复制到 pi 的扩展目录。具体步骤与安装来源见 README。

界面为英文;Paseo 设为简体中文时显示简体中文。

## 数据与权限

- 对话消息、IM 消息、Worker 汇报以及已下载附件的本机路径会作为提示词发给你配置的 agent provider。
- 状态保存在 `$PASEO_HOME/plugin-data/superagent/`。IM 凭据以明文保存在插件设置文件中(权限 0600);微信 bot 凭证单独保存在 `$PASEO_HOME/plugin-data/superagent/weixin/`(0600)。
- 开启的 IM 通道会连接飞书开放平台、钉钉 Stream、企业微信机器人服务或 `ilinkai.weixin.qq.com`,或你指定的 NapCat WebSocket。附件下载到 daemon 主机上的收件目录(单个文件上限 100 MB)。压缩包只列清单、不解压;列出 `.7z`/`.rar` 时调用本机已安装的 `7z`。
- 插件在 `127.0.0.1` 的随机端口与随机路径上运行本地 MCP server,为自身的会话提供工具。
- 对话页可经 daemon 只读、限量地预览答复里链接的任意绝对路径。
- Worker 按其 provider 与模式的权限行事;权限请求由 Router 回答或转告给你。

## 限制

- Router 评估逐个串行执行。
- daemon 启动后,编排引擎在第一个 hook 或 RPC 到来时启动;在此之前到达的 IM 消息先落盘排队。
- 钉钉与企业微信的回复无法按引用归入线程;微信只支持私聊。
- pi 扩展是手动复制的副本,不随插件更新。
