# paseo-plugin-superagent

Paseo 的 Router/Worker 双层编排插件。按《Super-agent 设计探索》的架构思路,在 Paseo 原语之上实现事件驱动的 super-agent 编排层,**不依赖 DeepSeek Harness**:

- **常驻 Router agent**(轻量模型)统一评估触发事件,只裁决、不执行;
- **Worker agent**(强模型)按 Ticket 在隔离 worktree 工作区执行,parent 挂在 Router 名下,在 app 的 Subagents track 可见、可随时人工介入;
- **订阅直通**:线程已有活跃订阅 Ticket 时,后续事件绕过 Router 程序直通 Worker(零 LLM);
- **批处理**:同一批窗口内的触发合并进一次 Router LLM 调用;
- **看门狗**:每 15 秒对账——错过完成、卡死启动、运行超时、评估重排,进程重启后自恢复;
- **IM 触发源**:飞书(官方长连接)与 QQ(OneBot 11 / NapCat)接收指令,Router 答复回到原聊天。

## 架构

```
手动派发(app 界面 / /superagent 命令)
agent 委派(superagent_dispatch MCP 注入)──► Trigger
Worker 汇报(完成后自动回流)                  │
                                             ▼
                       fast-path(长度截断/线程归属)
                                             │
              ┌──────────────────────────────┴───────────────┐
              ▼ 线程无活跃订阅 Ticket                          ▼ 线程有活跃订阅 Ticket
        批窗口积攒 → 串行 Router 评估                程序直通 Worker(steer,零 LLM)
        (dispatch / reply / ignore / stop)
              │ dispatch
              ▼
        Ticket → worktree 工作区 → Worker agent(parent=Router)
              │ 完成
              ▼
        汇报抓取 → report Trigger 回流线程 → 再次 Router 评估
```

状态(`$PASEO_HOME/plugin-data/superagent/state.json`,原子写):`threads / triggers / tickets / decisions` + kv。所有副作用(创建 agent、发消息)发生在落盘之后;看门狗负责崩溃后对账。

## 与文章五模块的对应

| 模块 | 实现 |
|---|---|
| 双层架构 | Router = 常驻 agent(`superagent.role=router` 标签,provider 可配轻量模型,规则禁止执行与调用工具;规则随每次评估提示词下发,不依赖 provider 是否应用 systemPrompt——ACP 系如 zcode-acp 会丢弃它);Worker = 每 Ticket 独立 agent + worktree 隔离 + `superagent.ticket` 标签;层级在 app 的 Subagents track 可见 |
| 事件驱动 | Trigger 三源(手动/agent 工具/worker 汇报);fast-path 程序过滤;Thread 归属;批窗口合并评估;订阅直通;Inline & Spill 式上下文(评估提示词只带 8 条线程窗口存根 + 触发全文上限 4000 字) |
| 面向人的交互 | Paseo app 即信道:推送、attention、权限流;任意 agent 会话内 `/superagent` 或 `superagent_dispatch` 工具委派,Router 答复经 sourceAgentId 回到原会话;Worker 会话可随时人工接管 |
| 存算/环境分离 | 即 Paseo daemon 本身:daemon 在你的机器,客户端(relay E2EE)在任何地方;执行环境留在原地 |
| Watchdog | 15s 对账巡检:launch 卡死重试、运行超时 reload+判败、idle 收割汇报、评估重排、Router 丢失重建 |

## 安装

```bash
cd paseo-plugin-superagent
npm install
npm run typecheck
paseo plugin install /absolute/path/to/paseo-plugin-superagent
paseo reload   # 若 pluginsEnabled 尚未开启,先在 config.json 打开
```

侧栏出现 **Superagent** 入口;首次进入完成配置:

| 设置 | 说明 |
|---|---|
| 工作目录 | 绝对路径。Router 的 cwd,也是所有 Worker 的基础目录(**必填**)。`worktree` 隔离时必须位于 git 仓库内,否则配置卡会提示、派发会带着目录与原因失败;Router 的评估提示词里也会写明该目录与隔离方式。所有 Worker 都只在这一个目录(或其 worktree)里工作 |
| Router provider/model | 留空自动选用宿主可用默认(claude → codex → opencode → 任意)。model id 以 `paseo provider models <provider>` 列出的为准(如 `zcode-acp/builtin:bigmodel-coding-plan\GLM-5.3-Flash`,单个反斜杠);填错时 Router 评估会报出可用 id |
| Worker provider/model | 同上,建议配最强模型 |
| Worker 隔离 | `worktree`(默认,每 Ticket 独立分支工作区)/ `shared` |
| Worker 超时 / 重试次数 / 批窗口 | 引擎调参 |
| 注入委派 MCP | 开启后所有普通 agent 的会话注入 `superagent_dispatch` 工具。走**插件自持的本地 MCP server**(`127.0.0.1` 随机端口 + 随机密钥路径),不受宿主 "Paseo tools"(`mcp.injectIntoAgents`)开关影响 |
| 注入 provider | 允许注入上述 MCP 的 provider,逗号分隔(如 `codex,claude`);留空 = claude,codex,opencode,omp,copilot。不支持 MCP server 的 provider(如 pi、ACP 系)注入会导致会话启动失败,默认排除 |

## IM 触发源(飞书 / QQ / 钉钉 / 企业微信)

在配置卡打开对应开关并填入凭据与**白名单**(发送者/会话至少一项;全空不启动,防陌生人触发)。保存即热重载,无需重启 daemon。

> 选型说明:调研过 [openclaw-china](https://github.com/BytePioneer-AI/openclaw-china)(MIT,TypeScript)——其 adapter 深度绑定 OpenClaw 宿主 runtime(消息路由/会话存储/流式回复均走宿主),无法脱离 OpenClaw 独立 import。因此本插件采用与其**相同的官方 SDK 矩阵**直接接入:飞书 `@larksuiteoapi/node-sdk`、钉钉 `dingtalk-stream`、企微 `@wecom/aibot-node-sdk`,全部官方 API、长连接、免公网。

### 飞书(官方长连接)

1. [飞书开放平台](https://open.feishu.cn) 创建**企业自建应用**,记录 App ID / App Secret;
2. 添加**机器人**能力;事件与回调 → 选择**使用长连接接收事件**;
3. 订阅事件 `im.message.receive_v1`;权限开通 `im:message` 与 `im:message:send_as_bot`;
4. 发布版本并在群里/私聊添加机器人;
5. 配置卡填:App ID、App Secret、允许的发送者 `open_id`(或会话 `chat_id`)。

行为:私聊直接触发;群聊需 **@机器人**。同一聊天 = 同一 Thread(话题按 root 分线程)。答复以引用回复回到原消息。

### 钉钉(官方 Stream 模式,免公网)

1. [钉钉开发者后台](https://open-dev.dingtalk.com) 创建企业内部应用,记录 AppKey / AppSecret;
2. 应用能力 → 添加**机器人**,接收消息模式选 **Stream 模式**,发布;
3. 配置卡填:ClientId、ClientSecret、允许的发送者 `staffId`(或会话 `conversationId`)。

行为:单聊直接触发;群聊被 @ 才会收到(钉钉机制)。同一 conversationId = 同一 Thread。回复经消息自带的 sessionWebhook(**有过期时间**,Worker 长任务的晚到回复可能失败,失败会记录日志)。

### 企业微信(智能机器人官方长连接,免公网)

1. 企业微信管理后台创建**智能机器人**,记录 botId 与 Secret;
2. 配置卡填:botId、Secret、允许的发送者 `userid`(或群 `chatid`)。

行为:单聊直接触发;群聊需 @机器人。回复为流式帧(单次完成)。**req_id 回复窗口有限**,晚到的 Worker 汇报回复可能被企微拒绝——长任务建议依赖 app 界面/推送查看结果,IM 内主要收 Router 的即时裁决与 ack。

### QQ(OneBot 11,配合 NapCat;个人号路线)

1. 安装 [NapCat](https://napneko.github.io/) 并用 QQ 号登录;
2. 网络配置开启**正向 WebSocket**(如 `ws://127.0.0.1:3001`),可设 Access Token;
3. 配置卡填:endpoint、token、允许的 QQ 号 / 群号。

行为:私聊直接触发;群里需 @机器人。回复带引用,断线自动重连。(官方 QQ 机器人平台路线见 openclaw-china/qqbot,需开发者资质,暂未内置。)

> 安全:IM 消息文本是不可信输入——Router 系统提示词已要求把触发文本当数据处理;白名单是第一道闸,凭据明文存于 `$PASEO_HOME/plugin-settings/superagent/`(0600)。微信公众号通道需要公网回调,插件暂未提供 HTTP 入口,列为限制。

## 使用

1. **派发**:界面"派发任务"卡片,或任意 agent 会话里 `/superagent 修复登录页的 CORS 问题并补测试`。
2. **观察**:线程卡片展开看 Router 裁决、Ticket 状态、触发历史;点 Worker id 直接跳转会话;Router 也可从顶栏打开。
3. **追加**:线程卡片输入框追加消息——有订阅 Worker 时直通,否则回到 Router。
4. **干预**:取消/重试 Ticket、退订直通、关闭线程(取消活跃 Worker 并归档其工作区)。

## 设计取舍与限制

- **Router 会话即记忆**:批处理上下文是组装的提示词(线程窗口存根),不是独立的向量库;超长历史会按存根压缩。
- **评估串行**:单个 Router agent 全局串行评估(避免相互打断);高并发线程会排队。
- **失败退避**:线程连续 3 次评估失败(unparsed/异常)后看门狗不再自动重排,需在界面点"立即评估"手动重试——防止 Router 持续劣化时烧 token 的失控循环。
- **权限等待**:Worker 的权限请求走 Paseo 原生权限流(app 内批准);等待期间 Ticket 保持运行,不误判完成。
- **外部 Trigger 源**:飞书/QQ 已支持;GitHub/Slack 轮询源是下一扩展点(Paseo Hub 触发器亦可作为上游把事件投给 `superagent.dispatch`)。
- **裁决解析**:Router 必须回 fenced JSON;解析失败记录 `unparsed` 决策并保留触发供重试,不做模型侧重问。
- **取消语义**:取消 Ticket 归档 Worker agent 及其 worktree 工作区(soft delete,可从 History 找回)。
- **委派 MCP 通道**:`superagent_dispatch` 经插件自持 MCP server 注入(不走 daemon 的插件 agent tools 目录,因此宿主关闭 "Paseo tools" 不影响委派)。代价:插件重载后端口与密钥轮换,已打开会话中的旧 URL 在下次 session_open 刷新前调用会报连接错误;不支持 MCP server 的 provider 默认不注入(可用"注入 provider"设置覆盖)。
- **未实现**:投机执行、多对多订阅(当前为线程内单 Worker 直通)、跨主机派发(可经 CLI `--host` 自行组合)。

## 开发

```bash
npm install
npm run typecheck
```

目录:`shared/`(领域模型 + RPC 契约 + 设置,两端共用)、`server/`(store/router/workers/engine)、`client/`(screen/setup/dispatch/thread 卡片)。引擎细节见 `server/engine.ts` 头注。

`npm test` 使用 Node.js 24+ 的内置测试运行器与现有 TypeScript 依赖,验证 Worker 续跑、投递失败回退、取消竞态、重启恢复与飞书连接清理;不连接真实 provider 或 IM 服务。
