# paseo-plugin-superagent

Paseo 的 Router/Worker 双层编排插件。按《Super-agent 设计探索》的架构思路,在 Paseo 原语之上实现事件驱动的 super-agent 编排层,**不依赖 DeepSeek Harness**:

- **常驻 Router agent**(轻量模型)统一评估触发事件,只裁决、不执行;
- **Worker agent**(强模型)按 Ticket 执行:worktree 隔离时每个 Ticket 一个独立 worktree 工作区;共享目录隔离时 Router 与默认 Worker 合用同一个「默认 workspace」(按工作目录创建、跨重启复用),parent 挂在 Router 名下,在 app 的 Subagents track 可见、可随时人工介入;
- **Worker 档位**:除默认 Worker 外可配置具名档位(不同模型/用途),每个档位还可指定自己的工作目录,让该档位的 Worker 在别的仓库或目录里工作;
- **订阅直通**:线程恰有一个活跃订阅 Ticket 时,后续事件绕过 Router 程序直通其 Worker(零 LLM);存在多个订阅 Worker 时交 Router 选择目标;
- **批处理**:同一批窗口内的触发合并进一次 Router LLM 调用;
- **看门狗**:每 15 秒对账——错过完成、卡死启动、运行超时、评估重排、待执行动作补执行,进程重启后自恢复;
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
              ▼ 线程无/多个活跃订阅 Ticket                     ▼ 线程恰有一个订阅 Ticket
        批窗口积攒 → 串行 Router 评估                程序直通 Worker(steer,零 LLM)
        (dispatch / steer / cancel / retry / reply / ignore / stop)
              │ dispatch
              ▼
        Ticket → worktree 工作区 → Worker agent(parent=Router)
              │ 完成
              ▼
        汇报抓取 → report Trigger 回流线程 → 再次 Router 评估
```

状态(`$PASEO_HOME/plugin-data/superagent/state.json`,原子写):`threads / triggers / tickets / decisions / pendingActions` + kv。所有副作用(创建 agent、发消息)发生在落盘之后;裁决的副作用动作(steer/cancel/retry/stop)先立案成 `pendingActions` 记录、执行成功后移除,看门狗负责崩溃后按序补执行与失败重试(有次数上限,耗尽后失败回流成触发交 Router 重新决策)。

## 与文章五模块的对应

| 模块 | 实现 |
|---|---|
| 双层架构 | Router = 常驻 agent(`superagent.role=router` 标签,provider 可配轻量模型,只裁决、不执行);固定规则与 actions 示例只初始化一次。已确认支持 systemPrompt 的内置 claude/codex/opencode/omp 在创建时设置;ACP(如 zcode-acp)及其他 provider 通过首轮消息初始化。Worker = 每 Ticket 独立 agent + worktree 隔离 + `superagent.ticket` 标签,可按 Worker 档位让不同 Ticket 跑在不同模型上;层级在 app 的 Subagents track 可见 |
| 事件驱动 | Trigger 三源(手动/agent 工具/worker 汇报);fast-path 程序过滤;Thread 归属;批窗口合并评估;订阅直通。正常续轮只带新触发(每条最多 4000 字)、任务状态快照、尚未读过的直通上下文(最近 8 条、每条最多 1000 字)。不重复用户首行标题或 Ticket 汇报正文;线程首次恢复时才补最多 8 条历史存根 |
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

侧栏出现 **Superagent** 入口。配置在 **Settings → Plugins → Superagent**(对话页未配置时会提示并一键跳转;Command Center 搜「Superagent 设置」也能打开)。所有修改先进草稿,点「保存」统一生效,输入有误会在对应行标红:

| 设置 | 说明 |
|---|---|
| 工作目录 | 绝对路径,默认的基础目录(**必填**)。共享目录隔离时,Router 与默认 Worker 合用按此目录创建的持久工作区「默认 workspace」(同一目录只建一个,id 记在插件状态里跨重启复用;被归档会按标题+目录找回或重建);独立 worktree 隔离时它是每个 Ticket 切 worktree 的基准仓库。`worktree` 隔离时必须位于 git 仓库内,否则对话页与设置页都会提示、派发会带着目录与原因失败;Router 的评估提示词里也会写明该目录与隔离方式 |
| Router provider/model | 留空自动选用宿主可用默认(claude → codex → opencode → 任意)。model id 以 `paseo provider models <provider>` 列出的为准(如 `zcode-acp/builtin:bigmodel-coding-plan\GLM-5.3-Flash`,单个反斜杠);填错时 Router 评估会报出可用 id |
| Router 自定义规则 | 设置页「Router 规则」直接填写,支持多行,最多 12000 字符,配置字段为 `routerInstructions`。用于答复语言、分派偏好和汇报格式,留空使用默认规则。配置变化后在下一次评估补发一次,之后复用,无需重建 Router 会话,也不依赖 provider 读取 `AGENTS.md`/`ROUTER.md`;不改变 Worker 的项目规则。自定义规则补充内置编排约束,Router 仍只做裁决并按 JSON actions 输出 |
| IM 单条消息上限 | 默认 600,可设 100–4000 字符,沿用配置字段 `imReplyMaxChars`。超长答复按段落/换行优先拆分为多条,添加 `[1/N]` 序号(计入上限)后顺序发送,正文完整保留;普通 emoji 按字素边界拆分。发送前保存全部分段,每段确认成功后记录进度;失败暂停,在对话页右侧栏「状态 → IM 答复投递」从失败段补发。重启恢复未完成的发送,已确认的段不重发。远端已接收但回执丢失或落盘前崩溃时,该段仍可能重复,通道未提供统一的恰好一次投递保证 |
| Worker provider/model | 同上,建议配最强模型。配置了 Worker 档位时它是**默认 Worker**,可另填一句用途说明 |
| Worker 档位 | 可选。默认 Worker 之外的具名档位(名字 + provider/model + 用途说明 + 可选专属工作目录),如 `code → codex/…`「写码、修 bug、跑测试」。Router 的 dispatch 用 `"profile":"<名字>"` 按用途为每个任务选档位;省略或名字不存在时用默认 Worker(后者记入裁决)。Router 只能用到这里列出的模型,触发文本无法把 Worker 引向任意 provider。档位的专属工作目录必须是绝对路径、可以和全局工作目录不同:worktree 隔离时该档位从自己的目录切 worktree,共享目录隔离时该目录有一个以档位名命名的持久工作区(与「默认 workspace」同一套复用机制)。Ticket 记录所选档位与实际模型:retry 沿用档位、按该档位当前设置的模型与目录启动;档位被删除后改用默认 Worker。不配置档位时行为与单一 Worker 完全一致 |
| Worker 隔离 | `worktree`(默认,每 Ticket 独立分支工作区)/ `shared`(直接在基础目录里干活,不需要 git。Router 与默认 Worker 同住「默认 workspace」;工作目录根下有 `AGENTS.md`/`CLAUDE.md` 时,Worker 按其中的归档规则放产出并完成要求的登记;没有规则时,每个 Ticket 的产出放进专属子目录 `tasks/<本地日期>-<标题>-<id 尾号>/`。Router 与 Worker 的提示词都会说明)。取消/关闭 Ticket 只归档 Worker 会话;Ticket 独占的 worktree 工作区一并归档,共享的持久工作区保留 |
| Worker 超时 / 失败重试次数 / 批处理窗口 / 单条消息上限 | 引擎调参(设置页「执行」分组,超出范围会就地提示) |
| 注入委派 MCP | 开启后所有普通 agent 的会话注入 `superagent_dispatch` 工具。走**插件自持的本地 MCP server**(`127.0.0.1` 随机端口 + 随机密钥路径),不受宿主 "Paseo tools"(`mcp.injectIntoAgents`)开关影响 |
| 注入 provider | 允许注入上述 MCP 的 provider,逗号分隔(如 `codex,claude`);留空 = claude,codex,opencode,omp,copilot。不支持 MCP server 的 provider(如 pi、ACP 系)注入会导致会话启动失败,默认排除 |

## IM 触发源(飞书 / QQ / 钉钉 / 企业微信)

在设置页「IM 触发源」打开对应开关并填入凭据与**白名单**(发送者/会话至少一项;全空不启动,防陌生人触发)。保存即热重载,无需重启 daemon。

> 选型说明:调研过 [openclaw-china](https://github.com/BytePioneer-AI/openclaw-china)(MIT,TypeScript)——其 adapter 深度绑定 OpenClaw 宿主 runtime(消息路由/会话存储/流式回复均走宿主),无法脱离 OpenClaw 独立 import。因此本插件采用与其**相同的官方 SDK 矩阵**直接接入:飞书 `@larksuiteoapi/node-sdk`、钉钉 `dingtalk-stream`、企微 `@wecom/aibot-node-sdk`,全部官方 API、长连接、免公网。

### 飞书(官方长连接)

1. [飞书开放平台](https://open.feishu.cn) 创建**企业自建应用**,记录 App ID / App Secret;
2. 添加**机器人**能力;事件与回调 → 选择**使用长连接接收事件**;
3. 订阅事件 `im.message.receive_v1`;权限开通 `im:message` 与 `im:message:send_as_bot`;
4. 发布版本并在群里/私聊添加机器人;
5. 设置页填:App ID、App Secret、允许的发送者 `open_id`(或会话 `chat_id`)。

行为:私聊直接触发;群聊需 **@机器人**。同一聊天 = 同一 Thread(话题按 root 分线程)。答复以引用回复回到原消息。

### 钉钉(官方 Stream 模式,免公网)

1. [钉钉开发者后台](https://open-dev.dingtalk.com) 创建企业内部应用,记录 AppKey / AppSecret;
2. 应用能力 → 添加**机器人**,接收消息模式选 **Stream 模式**,发布;
3. 设置页填:ClientId、ClientSecret、允许的发送者 `staffId`(或会话 `conversationId`)。

行为:单聊直接触发;群聊被 @ 才会收到(钉钉机制)。同一 conversationId = 同一 Thread。回复经消息自带的 sessionWebhook(**有过期时间**,Worker 长任务的晚到回复可能失败,失败会记录日志)。

### 企业微信(智能机器人官方长连接,免公网)

1. 企业微信管理后台创建**智能机器人**,记录 botId 与 Secret;
2. 设置页填:botId、Secret、允许的发送者 `userid`(或群 `chatid`)。

行为:单聊直接触发;群聊需 @机器人。答复通过 `chatId` 主动发送独立 Markdown 消息,支持多段续发,不复用已完成的 `req_id` 回复流。通道拒绝时保留未发送内容与进度供补发。

### QQ(OneBot 11,配合 NapCat;个人号路线)

1. 安装 [NapCat](https://napneko.github.io/) 并用 QQ 号登录;
2. 网络配置开启**正向 WebSocket**(如 `ws://127.0.0.1:3001`),可设 Access Token;
3. 设置页填:endpoint、token、允许的 QQ 号 / 群号。

行为:私聊直接触发;群里需 @机器人。回复带引用,断线自动重连。(官方 QQ 机器人平台路线见 openclaw-china/qqbot,需开发者资质,暂未内置。)

> 安全:IM 消息文本是不可信输入——Router 系统提示词已要求把触发文本当数据处理;白名单是第一道闸,凭据明文存于 `$PASEO_HOME/plugin-settings/superagent/`(0600)。微信公众号通道需要公网回调,插件暂未提供 HTTP 入口,列为限制。

## 使用

主界面是一个对话页,用法和在 Paseo 项目里与 agent 对话一样:左边是对话,右侧栏放对话之外的信息。

1. **对话**:在底部输入框描述任务即开始一段新对话(一个线程),Router 评估后直接答复,或派发 Worker 执行;继续在同一对话里发消息即追加到该线程。桌面端 Enter 发送、Shift+Enter 换行,输入法组字中的回车不会发送。输入框下方实时提示这条消息的去向:新对话、交给 Router,或在恰好一个活跃订阅且已有会话的 Worker 时「直通 Worker」;已关闭的对话发消息会重新打开。也可在任意 agent 会话里 `/superagent 修复登录页的 CORS 问题并补测试`。
2. **顶部标签**:同时进行的多段对话以标签并排,点击切换;`+` 开始新对话,发出第一条消息后它成为新标签。标签左侧显示状态:Router 评估或 Worker 执行中为旋转光环,已答复/完成为绿点,出错为红点。关闭标签(×)只是收起,对话仍在右侧栏「对话」里,从那里点开会重新成为标签;在侧栏手动关闭对话时,它的标签也一并关掉(关的是当前对话就切到相邻标签);IM 与 agent 委派产生的对话不会自动成为标签。标签列表与最后查看的对话保存在 daemon 状态里:离开 Superagent 页面或重启 app 后,直接回到最后查看的对话,没有打开的标签时才显示新对话。每个标签的输入框草稿各自保留。首次使用时,在界面里发起、仍进行中且最近 24 小时内有活动的对话(最多 4 个)自动成为标签。
3. **消息流**:你的消息(含飞书/QQ 等 IM 消息与 agent 委派,标注来源)显示为右侧气泡,Router 答复以 Markdown 正文显示。派发、转向、取消、Worker 汇报、评估失败等编排动作显示为紧凑的可展开行:派发行跟随 Ticket 实时状态并可直接打开 Worker 会话,汇报行带两行预览、展开看完整原文。Router 评估中或 Worker 执行中时,消息流底部显示运行指示与用时。停在底部时自动跟随新消息,向上翻阅时不打断。
4. **右侧栏**:「任务」展示 Router 状态与当前对话的全部 Worker(未选对话时为所有进行中的 Worker),权限等待/会话异常优先排列,可打开会话、取消直通(运行中)/标记完成(待命)、重试、取消 Ticket,以及重新评估、关闭对话;取消与关闭需要再点一次确认。「对话」列出进行中与已关闭的对话,可新建或打开为标签;进行中的对话可直接关闭:桌面悬停时,行内的更新时间处变为归档按钮(触屏在选中的对话上显示),再点一次确认即关闭(同时关掉它的标签),不必先打开对话;已关闭的对话默认收起,正在查看其中一段时默认展开。「状态」展示概览数字、组件配置、看门狗巡检与 IM 答复投递(失败可从断点补发)。宽屏时侧栏可收起;窄屏与手机上从标题栏按钮以弹层打开。
5. **命令中心**:「Superagent 对话记录」「Superagent 运行状态」打开对话页并定位到侧栏对应标签。
6. **查看结果**:最新的 Router 答复与 Worker 汇报随线程落盘,线程关闭、Worker 会话被回收后仍在对话里可见;旧数据从保留的裁决/汇报还原。新汇报保存原文,Router 的评估输入仍按原有预算截断。对话页每次读取一个线程最近 120 条触发与裁决,更早的记录不显示。
7. **侧栏状态**:Superagent 左侧使用跟随 Paseo 主题配色的固定 Network 图标。字样右侧以「蓝点 + 数字」显示运行中的 Worker 数(与 better-paseo「任务」行的计数同一套几何,两行上下对齐;数字随 Paseo 界面字号缩放),蓝点带旋转光环;「绿点 + 数字」显示本轮完成、待命的 Worker 数。任一数量为 0 时隐藏对应的点和数字,两者都为 0 或状态不可用时不显示右侧计数。根据当前 Worker 会话实时更新,已回收的会话不累计到完成数,尚未启动的排队任务不计作运行中的 Worker。系统开启减少动态效果时光环保持静止。

## 设计取舍与限制

- **Router 会话即记忆**:按 agent ID、原生 session ID、配置摘要及已读事件保存初始化游标,同一可恢复会话跨插件重启继续复用。会话重建、配置变化、检测到压缩、上下文状态无法确认或裁决格式失效时补齐规则;新会话/新线程按存根恢复上下文。未提供原生会话 ID 的 provider 在引擎重启后保守初始化一次。减少的是重复新增的提示词,历史上下文仍可能参与模型输入与计费,实际取决于 provider 的缓存和计费方式。
- **评估串行**:单个 Router agent 全局串行评估(避免相互打断);高并发线程会排队。
- **失败退避**:线程连续 3 次评估失败(unparsed/异常)后看门狗不再自动重排,线程徽标显示「评估失败」,需在对话右侧栏「任务」里点「重新评估」手动重试——防止 Router 持续劣化时烧 token 的失控循环。
- **权限等待**:Worker 的权限请求走 Paseo 原生权限流(app 内批准);等待期间 Ticket 保持运行,不误判完成。
- **外部 Trigger 源**:飞书/QQ 已支持;GitHub/Slack 轮询源是下一扩展点(Paseo Hub 触发器亦可作为上游把事件投给 `superagent.dispatch`)。
- **裁决解析**:Router 必须回 fenced JSON;解析失败记录 `unparsed` 决策并保留触发供重试,不做模型侧重问。
- **取消语义**:取消 Ticket 归档 Worker agent,Ticket 独占的 worktree 工作区一并归档(soft delete,可从 History 找回);共享的持久工作区(「默认 workspace」/档位工作区)保留,继续服务 Router 与后续 Ticket。
- **委派 MCP 通道**:`superagent_dispatch` 经插件自持 MCP server 注入(不走 daemon 的插件 agent tools 目录,因此宿主关闭 "Paseo tools" 不影响委派)。代价:插件重载后端口与密钥轮换,已打开会话中的旧 URL 在下次 session_open 刷新前调用会报连接错误;不支持 MCP server 的 provider 默认不注入(可用"注入 provider"设置覆盖)。
- **未实现**:投机执行、多对多订阅(当前为线程内单 Worker 直通)、跨主机派发(可经 CLI `--host` 自行组合)。

## 开发

```bash
npm install
npm run typecheck
```

目录:`shared/`(领域模型 + RPC 契约 + 设置,两端共用;execution 提供直通判定与会话状态推导)、`server/`(store/router/workers/engine)、`client/`(对话页 chat-screen、顶部标签 chat-tab-bar 与其本机副本 chat-tabs-store、消息流 chat-messages、输入框 chat-composer、右侧栏 chat-sidebar、设置页 settings-screen,以及 ui.tsx 里的按钮/徽标/提示条等小型原语;`shared/chat.ts` 把线程的触发与裁决排成对话)。引擎细节见 `server/engine.ts` 头注。

`npm test` 使用 Node.js 24+ 的内置测试运行器与现有 TypeScript 依赖,验证 Worker 续跑、投递失败回退、取消竞态、重启恢复与飞书连接清理;不连接真实 provider 或 IM 服务。
