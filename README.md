# paseo-plugin-superagent

要求 Paseo daemon 与各端客户端均为 0.15.0 或更新版本,插件服务端使用 Node.js 20 或更新版本。MCP 入口采用 SDK v2,同时兼容 `2026-07-28` 的逐请求协议和旧版 stateless Streamable HTTP 协议。

Paseo 的 Router/Worker 双层编排插件。按《Super-agent 设计探索》的架构思路,在 Paseo 原语之上实现事件驱动的 super-agent 编排层,**不依赖 DeepSeek Harness**:

- **常驻 Router agent**(轻量模型)统一评估触发事件,只裁决、不执行;除内置工具外仅可调用编排自身的只读回读工具(`superagent_list` / `superagent_read` / `superagent_search`),截断的触发/汇报/历史存根都可按 ID 找回全文(Chain of Recall),只记得零碎关键词时用 `superagent_search` 在全部记录里检索命中(空格分词 AND,最多 20 条 ID + 短摘录);
- **Worker agent**(强模型)按 Ticket 执行:worktree 隔离时每个 Ticket 一个独立 worktree 工作区;共享目录隔离时 Router 与默认 Worker 合用同一个「默认 workspace」(按工作目录创建、跨重启复用),parent 挂在 Router 名下,在 app 的 Subagents track 可见、可随时人工介入;
- **Worker 档位**:除默认 Worker 外可配置具名档位(不同模型/用途),每个档位还可指定自己的工作目录,让该档位的 Worker 在别的仓库或目录里工作;
- **订阅直通(fan-out,多对多)**:线程有活跃订阅 Worker 时,后续事件绕过 Router 程序直通**全部**订阅 Worker(零 LLM);一个可用会话都没有才交 Router 评估。Router 的 `subscribe` 动作可让别的线程里已在干活的 Worker **也跟随**当前线程(一个 Worker 订阅多个线程),跟随来的消息带 `[thread …]` 前缀,汇报回流到它订阅的每个线程;Worker 可用 `superagent_unsubscribe`(可指定 `threadId` 只退一个线程)退订、`superagent_handback` 把误投消息转回 Router;
- **语义慢路径**:观察模式旁听到的未 @ 群消息(context-only)不直通 Worker,一律交 Router 判断(默认忽略,与某个任务相关时 steer,符合主动策略时才行动);
- **权限与提问回流**:Worker 的权限请求、计划确认和结构化提问立即落盘并通知 Router。Router 根据已有授权/上下文用 `respond` 正式审批或回答;需要人的决定时,把具体操作/问题和选项回投原聊天或委派会话。请求未解决期间,线程后续消息先交 Router 判断,不向 Worker 广播,也不通过普通 steer 隐式清除请求。请求按 ID 去重,重载后由程序对账补收;等待输入期间暂停运行超时处理,响应后重新观察完成状态;
- **引用归线程 + 相邻消息内联**:IM 消息引用(回复)了已知的触发或 Router 答复(按通道回执记下的消息 id)时,归入被引用消息所在的线程,并把被引用内容内联给 Router/Worker;评估时附带本批之前 Router 没看过的最近 5 条未 @ 群聊(准入层 filtered 留痕,滚动保留 30 条);
- **投机执行**(可选,默认关):Router 依据「Router 规则」里写的主动策略对没人明确提出的事项后台派 `speculative` Worker 静默尝试(不订阅线程、同时最多 2 个),汇报首行 `DISCARD:` 由引擎静默丢弃并回收 Worker,`DELIVER:` 才交 Router 简短转述;
- **跨线程指挥**:每次评估除本线程票据外,还列出其他活跃线程的未完结票据存根,steer/cancel/retry 可跨线程执行(全局协调);
- **批处理**:同一批窗口内的触发合并进一次 Router LLM 调用;窗口一经武装不再被后续消息重置(有界合并,持续消息流不会无限推迟评估);
- **看门狗(两层)**:程序看门狗每 15 秒对账——错过完成、卡死启动、运行超时、评估重排、待执行动作补执行,进程重启后自恢复;**LLM 看门狗**(可选,默认关)是独立的 `Superagent Watchdog` 会话,按间隔收到全部未完结票据的进展摘要(会话状态、自上次巡检新增的时间线条目、静默时长、最近消息、权限等待)与引擎健康状况,判断有无实质进展/是否偏离任务,用 JSON 动作 `nudge`/`interrupt`/`cancel`/`retry`/`reeval`/`escalate` 介入(取消与上报经 Router 告诉人);维护者可在状态栏一键打开该会话直接问诊;
- **Router 只裁决(硬约束)**:Router/看门狗的权限请求由插件按策略应答——自身回读工具放行,其余工具、计划与模式切换一律拒绝;codex 系 Router/看门狗以只读沙箱创建。Worker 的退订/转回工具自动放行;
- **IM 触发源**:飞书(官方长连接)、QQ(OneBot 11 / NapCat)、钉钉、企业微信、微信(腾讯官方 ClawBot / iLink,扫码登录)接收指令,Router 答复回到原聊天;插件启动即连接,引擎启动(首个 hook/RPC)之前到达的消息先落盘,启动后补直通/评估。

## 架构

```
手动派发(app 界面 / /superagent 命令)
agent 委派(superagent_dispatch MCP 注入)──► Trigger
Worker 汇报(完成后自动回流)                  │
Worker 转回(superagent_handback 误投回流)    │
                                             ▼
                       fast-path(长度截断/线程归属)
                                             │
              ┌──────────────────────────────┴───────────────┐
              ▼ 无可用订阅 / context-only 旁听消息              ▼ 有订阅(含跟随本线程的 Worker)
        批窗口积攒 → 串行 Router 评估                程序直通全部订阅 Worker(steer,零 LLM)
        (dispatch[speculative] / steer / cancel /          │ 不该由它处理:handback 转回 Router
         retry / subscribe / reply / ignore / stop)         ▼ 不再接收后续:unsubscribe 退订
        ▲ 评估中可按 ID 回读全文/检索记录/跨线程票据    Ticket → worktree 工作区 → Worker agent
        │ (superagent_read / list / search)                 │ 完成
        │ dispatch                                          ▼
        └──────────────► Ticket → worktree 工作区 ──► 汇报抓取 → report Trigger 回流 → 再次 Router 评估

steer/cancel/retry/subscribe 的目标也可以是「其他活跃线程」里列出的票据(跨线程指挥,裁决记录在本线程)
LLM 看门狗(独立会话,定时)── 巡检摘要 ──► nudge/interrupt/cancel/retry/reeval/escalate(上报经 Router 告诉人)
```

状态(`$PASEO_HOME/plugin-data/superagent/state.json`,原子写):`threads / triggers / tickets / decisions / pendingActions` + kv。Ticket 的 `pendingRequests` 保留待处理请求及问题选项。所有副作用(创建 agent、发消息)发生在落盘之后;裁决的副作用动作(steer/respond/cancel/retry/stop)先立案成 `pendingActions` 记录、执行成功后移除,看门狗负责崩溃后按序补执行与失败重试(有次数上限,耗尽后失败回流成触发交 Router 重新决策)。`respond` 绑定 Worker 会话和请求 ID,重复执行不会误答其他请求,也不扩大持久授权范围。

## 与文章五模块的对应

| 模块 | 实现 |
|---|---|
| 双层架构 | Router = 常驻 agent(只裁决由权限钩子硬约束:非自身工具一律拒绝,codex 系只读沙箱)(`superagent.role=router` 标签,provider 可配轻量模型,只裁决、不执行,唯一可用的工具是编排自身的只读回读);固定规则与 actions 示例只初始化一次。已确认支持 systemPrompt 的内置 claude/codex/opencode/omp 在创建时设置;ACP(如 zcode-acp)及其他 provider 通过首轮消息初始化。Worker = 每 Ticket 独立 agent + worktree 隔离 + `superagent.ticket` 标签,可按 Worker 档位让不同 Ticket 跑在不同模型上;层级在 app 的 Subagents track 可见。跨线程指挥:评估提示词列出其他活跃线程的未完结票据,steer/cancel/retry 可指向它们,裁决仍记录在本线程 |
| 事件驱动 | Trigger 三源(手动/agent 工具/worker 汇报)+ 四 IM 通道;fast-path 程序过滤(白名单之外,未 @ 群消息记 filtered 留痕,观察模式下作上下文候选,且一律走 Router 语义判断、不直通 Worker);Thread 归属(引用回复归入被引用消息的线程);批窗口合并评估(窗口有界,不随后续消息重置,按线程合并);订阅 fan-out 直通,多对多(Router `subscribe` 让 Worker 跟随其他线程,汇报回流到每个订阅线程)。Inline:被引用消息内联、最近 5 条未 @ 相邻群聊内联。投机执行(可选):`speculative` 派发,DELIVER/DISCARD 交付或静默丢弃,并发上限 2。正常续轮只带新触发(每条最多 4000 字,截断处标注回读指针)、任务状态快照、尚未读过的直通上下文(最近 8 条、每条最多 1000 字)。Chain of Recall:提示词里的触发/票据/线程/裁决均带 ID,历史存根也保留 ID,Router 用 `superagent_read` 按 ID 找回完整未截断记录(线程回读内联最近 10 条消息与 5 条裁决的 ID、跟随它的其他线程票据;票据回读内联跟随的线程与 Worker 会话最近 3 条消息,沿引用逐跳展开)、用 `superagent_list` 总览活跃线程(最近 10 个)、用 `superagent_search` 按关键词检索全部记录;Worker 汇报回流时截断的文本附带票据回读指针,汇报首行被要求写成含关键实体(路径/ID/命令)的自足结论句(存根与检索都取开头)。内置记忆纪律:跨轮承诺必须落 ticket 或 reply,stop/跨线程裁决目标不明时先 `superagent_list` 对账。不重复用户首行标题或 Ticket 汇报正文;线程首次恢复时才补最多 8 条历史存根 |
| 面向人的交互 | Paseo app 即信道:推送、attention、权限流;任意 agent 会话内 `/superagent` 或 `superagent_dispatch` 工具委派,Router 答复经 sourceAgentId 回到原会话;Worker 会话可随时人工接管。多渠道输出风格:IM 来源线程的评估提示词带渠道风格小节(答复保持简短、长内容派 Worker 后转述摘要与产物位置),超长答复仍按段落自动分段回投 直通误投自愈:Worker 调 `superagent_handback` 把不属于自己的消息转回 Router 重新路由(继承原 IM/agent 回投目标),`superagent_unsubscribe` 退订后续直通 |
| 存算/环境分离 | 即 Paseo daemon 本身:daemon 在你的机器,客户端(relay E2EE)在任何地方;执行环境留在原地。状态落盘(state.json)+ 重启自恢复是单机形态的「计算与状态分离」;云端无状态计算与端侧 daemon 受宿主形态限制不做(见下文) |
| Watchdog | 程序层 15s 对账:launch 卡死重试、运行超时 reload+判败、idle 收割汇报、评估重排、Router 丢失重建;LLM 层(可选)独立 `Superagent Watchdog` 会话按间隔判断进展与偏离,经 JSON 动作介入,维护者可直接在该会话问诊 |

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
| Router provider/model | 设置页从 daemon 的 provider 快照中下拉选取(model id 原样带入,含 ACP 系的反斜杠 id;清单读取失败或所选 provider 未上报模型时退回手填)。留空自动选用宿主可用默认(claude → codex → opencode → 任意);填错时 Router 评估会报出可用 id |
| Router 自定义规则 | 设置页「Router 规则」直接填写,支持多行,最多 12000 字符,配置字段为 `routerInstructions`。用于答复语言、分派偏好和汇报格式,留空使用默认规则。配置变化后在下一次评估补发一次,之后复用,无需重建 Router 会话,也不依赖 provider 读取 `AGENTS.md`/`ROUTER.md`;不改变 Worker 的项目规则。自定义规则补充内置编排约束,Router 仍只做裁决并按 JSON actions 输出 |
| IM 单条消息上限 | 默认 600,可设 100–4000 字符,沿用配置字段 `imReplyMaxChars`。超长答复按段落/换行优先拆分为多条,添加 `[1/N]` 序号(计入上限)后顺序发送,正文完整保留;普通 emoji 按字素边界拆分。发送前保存全部分段,每段确认成功后记录进度;失败暂停,在对话页右侧栏「状态 → 未送达的 IM 回复」从失败段补发(这一栏只列发送中与发送失败的回复,全部发出后即消失)。重启恢复未完成的发送,已确认的段不重发。远端已接收但回执丢失或落盘前崩溃时,该段仍可能重复,通道未提供统一的恰好一次投递保证 |
| Worker provider/model | 同上,建议配最强模型。配置了 Worker 档位时它是**默认 Worker**,可另填一句用途说明 |
| Worker 模式(可选) | 默认 Worker 与每个具名档位都可独立选择模式,候选直接来自所选 provider 的快照(含 ACP 动态模式),与 Paseo 输入框的模式 ID 一致。选「Paseo 默认」时不传 `modeId`,按 Paseo 默认行为启动;具名档位留空也不继承默认 Worker 的模式。切换 provider 会清空旧模式,同一 provider 更换模型会保留模式。模式随首条任务一起传入,修改用于新建或重试的 Worker,不修改运行中的会话;不支持的模式会在启动前报出可用 ID,不会静默退回默认模式 |
| Worker 档位 | 可选。默认 Worker 之外的具名档位(名字 + provider/model + 用途说明 + 可选专属工作目录),如 `code → codex/…`「写码、修 bug、跑测试」。Router 的 dispatch 用 `"profile":"<名字>"` 按用途为每个任务选档位;省略或名字不存在时用默认 Worker(后者记入裁决)。Router 只能用到这里列出的模型,触发文本无法把 Worker 引向任意 provider。档位的专属工作目录必须是绝对路径、可以和全局工作目录不同:worktree 隔离时该档位从自己的目录切 worktree,共享目录隔离时该目录有一个以档位名命名的持久工作区(与「默认 workspace」同一套复用机制)。Ticket 记录所选档位与实际模型:retry 沿用档位、按该档位当前设置的模型与目录启动;档位被删除后改用默认 Worker。不配置档位时行为与单一 Worker 完全一致 |
| Worker 隔离 | `worktree`(默认,每 Ticket 独立分支工作区)/ `shared`(直接在基础目录里干活,不需要 git。Router 与默认 Worker 同住「默认 workspace」;工作目录根下有 `AGENTS.md`/`CLAUDE.md` 时,Worker 按其中的归档规则放产出并完成要求的登记;没有规则时,每个 Ticket 的产出放进专属子目录 `tasks/<本地日期>-<标题>-<id 尾号>/`。Router 与 Worker 的提示词都会说明)。取消/关闭 Ticket 只归档 Worker 会话;Ticket 独占的 worktree 工作区一并归档,共享的持久工作区保留 |
| Worker 超时 / 失败重试次数 / 批处理窗口 / 单条消息上限 | 引擎调参(设置页「执行」分组,超出范围会就地提示) |
| 投机执行 | 「主动与巡检」分组,默认关。开启后 Router 规则里出现投机执行说明,Router 可依据你在「Router 规则」里写的主动策略(如「群里有人反馈问题时,静默复现并尝试简单修复」)派发 `speculative` Worker;同时最多 2 个,超出的投机派发直接丢弃并记入裁决 |
| LLM 看门狗 | 「主动与巡检」分组,默认关。看门狗模型留空沿用 Router 的模型;巡检间隔 5–240 分钟(默认 30)。没有未完结任务、也没有异常时跳过,不调用模型(Router 会话已释放、下次评估自动重建不算异常);维护者正在和看门狗会话对话时本次巡检让路 |
| 注入委派 MCP | 开启后所有普通 agent 的会话注入 `superagent_dispatch` 工具。走**插件自持的本地 MCP server**(`127.0.0.1` 随机端口 + 随机密钥路径),不受宿主 "Paseo tools"(`mcp.injectIntoAgents`)开关影响。同一 endpoint 还按角色给编排自身的会话下发工具:Router 拿 `superagent_list`/`superagent_read`/`superagent_search`(只读回读与检索),Worker 拿 `superagent_unsubscribe`/`superagent_handback`(会话控制)——这部分不受本开关控制。角色工具在**每次会话启动时经 session_open 注入**——不能写进 agent 保存配置:同名 mcpServer 与插件注入冲突会被 daemon 拒绝,`toolPolicy` 预授权引用的 server 又必须出现在同一请求里,两条都走不通 |
| 注入 provider | 允许注入上述 MCP 的 provider 家族,逗号分隔(如 `codex,claude`);留空 = claude,codex,opencode,omp,copilot。不支持 MCP server 的 provider(如 pi)注入会导致会话启动失败,默认排除;Router/Worker 的角色工具注入同样按「默认名单 ∪ 此名单」的家族门控(provider 带 model 限定时按 `/` 前的家族判断;插件型 provider 如 zcode-acp 由 daemon 统一声明支持 MCP,想给它注入就在此配置) |

## IM 触发源(飞书 / QQ / 钉钉 / 企业微信 / 微信)

在设置页「IM 触发源」打开对应开关并填入凭据与**白名单**(发送者/会话至少一项;全空不启动,防陌生人触发;微信的扫码人自动在白名单内)。保存即热重载,无需重启 daemon。

**分级准入**:白名单命中但未 @ 机器人的群消息(飞书/QQ)默认记为**已过滤**留痕(对话气泡显示「已过滤 · 群消息未 @ 机器人」,不评估、不直通、每线程上限 30 条);打开该通道的**群聊观察模式**后,这类消息改为上下文触发交给 Router 判断(可忽略,也可按需行动)——对齐文章「观察公共聊天、未被点名也可介入」的候选档。钉钉/企微的未 @ 群消息在平台侧就不会投递,无此档位。

> 选型说明:调研过 [openclaw-china](https://github.com/BytePioneer-AI/openclaw-china)(MIT,TypeScript)——其 adapter 深度绑定 OpenClaw 宿主 runtime(消息路由/会话存储/流式回复均走宿主),无法脱离 OpenClaw 独立 import。因此本插件采用与其**相同的官方 SDK 矩阵**直接接入:飞书 `@larksuiteoapi/node-sdk`、钉钉 `dingtalk-stream`、企微 `@wecom/aibot-node-sdk`,全部官方 API、长连接、免公网。微信同理:腾讯官方插件 [`@tencent-weixin/openclaw-weixin`](https://github.com/Tencent/openclaw-weixin) 以 openclaw 为 peer 依赖、走 OpenClaw 的渠道运行时,因此按其公开的 iLink 协议([protocol.md](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md))直接调用同一官方接口 `ilinkai.weixin.qq.com`。

### 飞书(官方长连接)

1. [飞书开放平台](https://open.feishu.cn) 创建**企业自建应用**,记录 App ID / App Secret;
2. 添加**机器人**能力;事件与回调 → 选择**使用长连接接收事件**;
3. 订阅事件 `im.message.receive_v1`;权限开通 `im:message` 与 `im:message:send_as_bot`;
4. 发布版本并在群里/私聊添加机器人;
5. 设置页填:App ID、App Secret、允许的发送者 `open_id`(或会话 `chat_id`)。

行为:私聊直接触发;群聊需 **@机器人**(或打开「群聊观察模式」收上下文)。同一聊天 = 同一 Thread(话题按 root 分线程)。答复以引用回复回到原消息。

### 钉钉(官方 Stream 模式,免公网)

1. [钉钉开发者后台](https://open-dev.dingtalk.com) 创建企业内部应用,记录 AppKey / AppSecret;
2. 应用能力 → 添加**机器人**,接收消息模式选 **Stream 模式**,发布;
3. 设置页填:ClientId、ClientSecret、允许的发送者 `staffId`(或会话 `conversationId`)。

行为:单聊直接触发;群聊被 @ 才会收到(钉钉机制)。同一 conversationId = 同一 Thread。回复经消息自带的 sessionWebhook(**有过期时间**,Worker 长任务的晚到回复可能失败,失败会记录日志)。

### 企业微信(智能机器人官方长连接,免公网)

1. 企业微信管理后台创建**智能机器人**,记录 botId 与 Secret;
2. 设置页填:botId、Secret、允许的发送者 `userid`(或群 `chatid`)。

行为:单聊直接触发;群聊需 @机器人。答复通过 `chatId` 主动发送独立 Markdown 消息,支持多段续发,不复用已完成的 `req_id` 回复流。通道拒绝时保留未发送内容与进度供补发。

### 微信(腾讯官方 ClawBot / iLink,扫码登录,免公网)

1. 设置页打开「微信」,点**扫码登录**,用手机微信扫描设置页里的二维码并在手机上确认(在手机上打开设置页时可点「在微信中打开链接」;要求输入验证码时,把手机微信显示的数字填进设置页);
2. 按需在「另外允许的用户」里填其他人的微信用户 ID(`xxx@im.wechat`)——扫码人自动允许,可以留空;
3. 保存设置。之后换号或凭证失效时点「重新扫码」,不用改设置;「退出登录」删除本机凭证并停止通道。

行为:仅私聊(官方插件同样未开放群聊;白名单内用户的群消息记为已过滤「微信群消息暂不支持」)。同一用户 = 同一 Thread。收消息走 `getupdates` 长轮询,游标落盘,重启后从断点续收;回复带入站消息的 `context_token`(按用户取最新一枚,重启后回落到触发记录里保存的那枚)。支持文本与语音转写,图片/文件等纯媒体消息暂不处理;引用回复按 `ref_msg` 的消息 id 归回线程。服务端返回 `-14`(会话失效)时按官方插件的做法暂停 1 小时再试,设置页显示原因。

凭证(bot token)只保存在 daemon 主机的 `$PASEO_HOME/plugin-data/superagent/weixin/account.json`(0600),不进插件设置,客户端只看得到 bot ID 与扫码人 ID。使用须遵守腾讯《微信ClawBot功能使用条款》;腾讯可随时限流或终止该能力,不宜作为唯一的通知通道。

### QQ(OneBot 11,配合 NapCat;个人号路线)

1. 安装 [NapCat](https://napneko.github.io/) 并用 QQ 号登录;
2. 网络配置开启**正向 WebSocket**(如 `ws://127.0.0.1:3001`),可设 Access Token;
3. 设置页填:endpoint、token、允许的 QQ 号 / 群号。

行为:私聊直接触发;群里需 @机器人(或打开「群聊观察模式」收上下文)。回复带引用,断线自动重连。(官方 QQ 机器人平台路线见 openclaw-china/qqbot,需开发者资质,暂未内置。)

> 安全:IM 消息文本是不可信输入——Router 系统提示词已要求把触发文本当数据处理;白名单是第一道闸,凭据明文存于 `$PASEO_HOME/plugin-settings/superagent/`(0600),微信 bot token 另存于 `$PASEO_HOME/plugin-data/superagent/weixin/`(0600)。微信公众号通道需要公网回调,插件暂未提供 HTTP 入口,列为限制。

## 使用

主界面是一个对话页,用法和在 Paseo 项目里与 agent 对话一样:左边是对话,右侧栏放对话之外的信息。

1. **对话**:在底部输入框描述任务即开始一段新对话(一个线程),Router 评估后直接答复,或派发 Worker 执行;继续在同一对话里发消息即追加到该线程。桌面端发送键跟随 Paseo 全局设置(Settings → General):默认 Enter 发送、Shift+Enter 换行,设为 Cmd/Ctrl+Enter 后裸 Enter 换行;输入法组字中的回车不会发送。输入框下方实时提示这条消息的去向:新对话、交给 Router,或在有活跃订阅且已有会话的 Worker 时「直通 Worker」(多个订阅时全部直通);已关闭的对话发消息会重新打开。也可在任意 agent 会话里 `/superagent 修复登录页的 CORS 问题并补测试`。
2. **顶部标签**:同时进行的多段对话以标签并排,点击切换;`+` 开始新对话,发出第一条消息后它成为新标签。标签左侧显示状态:Router 评估或 Worker 执行中为旋转光环,已答复/完成为绿点,出错为红点。关闭标签(×)只是收起,对话仍在右侧栏「对话」里,从那里点开会重新成为标签;在侧栏手动关闭对话时,它的标签也一并关掉(关的是当前对话就切到相邻标签);IM 与 agent 委派产生的对话不会自动成为标签。标签列表与最后查看的对话保存在 daemon 状态里:离开 Superagent 页面或重启 app 后,直接回到最后查看的对话,没有打开的标签时才显示新对话。每个标签的输入框草稿各自保留。首次使用时,在界面里发起、仍进行中且最近 24 小时内有活动的对话(最多 4 个)自动成为标签。
3. **消息流**:你的消息(含飞书/QQ 等 IM 消息与 agent 委派,标注来源)显示为右侧气泡,下方一行是来源、投递状态、时间与复制;Router 答复以 Markdown 正文显示,下方页脚为复制 · Router · 时间。答复(以及展开的 Worker 汇报)里链接到绝对路径的文件(如 ``[`report.md`](/abs/report.md)``、`file://`、`:行号`/`#L10-L20`)会在正文下方列成一排文件药丸(按磁盘上的真实类型区分:文件夹是琥珀色图块并带右箭头,文件按类型换图标并显示行号,已不存在的划掉),点开预览(桌面 Web 是最宽 1080 的弹窗,手机与平板用宿主弹层):Markdown 按 Markdown 渲染,其余文本放进代码块(Web 端有高亮),带行号时先显示引用附近的片段,图片直接显示,目录可逐级点进去;可复制路径、重新读取。宿主 Markdown 在插件页面里没有工作区上下文,正文里的链接本身点了没有反应,所以用药丸代替。派发、转向、取消、Worker 汇报、评估失败等编排动作显示为紧凑的可展开行:派发行跟随 Ticket 实时状态并可直接打开 Worker 会话,汇报行带两行预览、展开看完整原文。Router 评估中或 Worker 执行中时,消息流底部显示运行指示与用时。停在底部时自动跟随新消息,向上翻阅时不打断。

   版式借鉴 [better-paseo](https://github.com/RoundRedDot/better-paseo) 重绘的 agent 会话(`shared/design.ts`、`client/theme-tokens.ts`):内容列宽度、气泡与输入框字号跟随 Paseo「外观」里的内容宽度与正文字号(气泡 = 正文字号 × 1.4 行高,与宿主一致);界面文字用固定刻度(标签 13/18、元信息 12/16,会换行的说明多给行距);动作行桌面 26、触屏 28 高,已结束的行退为次要色,运行中的行显示蓝色呼吸点,悬停或展开时恢复全对比,连续的行只隔 4;侧栏卡片是带细线与轻阴影的抬起卡片,失败/待处理换色洗,按钮为细线描边。所有派生色都由宿主主题混出。Router 答复使用宿主内置 Markdown,其行高(1.4×)由 Paseo 决定。
4. **右侧栏**:「任务」展示 Router 状态与当前对话的全部 Worker(未选对话时为所有进行中的 Worker),权限等待/会话异常优先排列,可打开会话、取消直通(运行中)/标记完成(待命)、重试、取消 Ticket,以及重新评估、关闭对话;取消与关闭需要再点一次确认。「对话」列出进行中与已关闭的对话,可新建或打开为标签;进行中的对话可直接关闭:桌面悬停时,行内的更新时间处变为归档按钮(触屏在选中的对话上显示),再点一次确认即关闭(同时关掉它的标签),不必先打开对话;已关闭的对话默认收起,正在查看其中一段时默认展开。「状态」展示概览数字、组件配置、看门狗巡检,以及有回复没送达时的「未送达的 IM 回复」(以回复开头认出是哪条,失败可从断点补发)。宽屏时侧栏可收起;窄屏与手机上从标题栏按钮以弹层打开。
5. **命令中心**:「Superagent 对话记录」「Superagent 运行状态」打开对话页并定位到侧栏对应标签。
6. **查看结果**:最新的 Router 答复与 Worker 汇报随线程落盘,线程关闭、Worker 会话被回收后仍在对话里可见;旧数据从保留的裁决/汇报还原。新汇报保存原文,Router 的评估输入仍按原有预算截断。对话页每次读取一个线程最近 120 条触发与裁决,更早的记录不显示。
7. **侧栏状态**:Superagent 左侧使用跟随 Paseo 主题配色的固定 Network 图标。字样右侧以「蓝点 + 数字」显示运行中的 Worker 数(与 better-paseo「任务」行的计数同一套几何,两行上下对齐;数字随 Paseo 界面字号缩放),蓝点带旋转光环;「绿点 + 数字」显示本轮完成、待命的 Worker 数。任一数量为 0 时隐藏对应的点和数字,两者都为 0 或状态不可用时不显示右侧计数。根据当前 Worker 会话实时更新,已回收的会话不累计到完成数,尚未启动的排队任务不计作运行中的 Worker。系统开启减少动态效果时光环保持静止。没有 Worker 在运行/待命时,同一位置改显 Router 会话的状态点:蓝点 + 旋转光环 = 评估运行中,绿点 = 运行完毕待查看(requiresAttention/finished),琥珀点 = 等待权限输入,红点 = 出错,灰点 = 空闲(跑完已看、尚未释放);Router 已关闭时不显示任何图形(空白)。Router 会话按创建时打上的 `superagent.role=router` 标签枚举,状态重置后残留的旧 Router 一并计入:多个 Router 处于同一状态时按宿主 agent 状态序(权限 > 出错 > 运行 > 完成待查看 > 空闲)取最紧急的一种并显示数量,仅 1 个时不显示数字。

## 设计取舍与限制

- **Router 会话即记忆**:按 agent ID、原生 session ID、配置摘要及已读事件保存初始化游标,同一可恢复会话跨插件重启继续复用。会话重建、配置变化、检测到压缩、上下文状态无法确认或裁决格式失效时补齐规则;新会话/新线程按存根恢复上下文。未提供原生会话 ID 的 provider 在引擎重启后保守初始化一次。减少的是重复新增的提示词,历史上下文仍可能参与模型输入与计费,实际取决于 provider 的缓存和计费方式。
- **评估串行**:单个 Router agent 全局串行评估(避免相互打断);高并发线程会排队。
- **失败退避(分两类)**:unparsed(Router 输出无法解析)连续 3 次后看门狗不再自动重排,需在对话右侧栏「任务」里点「重新评估」手动重试——防止 Router 持续劣化时烧 token 的失控循环;基础设施异常(provider 未就绪、目录不可用等瞬时故障)不计入熔断,按看门狗节奏持续重查约 5 分钟(20 个周期),对齐文章「瞬时故障持续重查直到恢复」。
- **权限等待**:Worker 的权限请求走 Paseo 原生权限流(app 内批准);等待期间 Ticket 保持运行,不误判完成。
- **外部 Trigger 源**:飞书/QQ 已支持;GitHub/Slack 轮询源是下一扩展点(Paseo Hub 触发器亦可作为上游把事件投给 `superagent.dispatch`)。
- **文件预览**:药丸类型由 `superagent.stat_files` 一次查完一段对话里的所有路径(最多 200 个,结果缓存 1 分钟);预览经 `superagent.read_file` RPC 由 daemon 只读读取任意绝对路径(`~` 展开为 daemon 用户主目录),不限于工作区——能连上 daemon 的客户端本就可以让 agent 执行命令,不算新增权限。文本最多读 256 KB(超出只显示开头)、图片不超过 4 MB、目录最多列 500 项;设备、管道等特殊文件不读;开头 8000 字节含 NUL 的按二进制处理,只显示大小。只认答复里指向绝对路径的链接,相对路径、行内代码与代码块里的路径不识别;不能编辑,也不会跳转到宿主的文件标签页(插件 SDK 0.15 没有打开文件的接口)。宿主 Modal 的桌面卡片固定最宽 520 且插件无法调整,桌面 Web 的预览因此改用 RN Modal 自画、外观仿照宿主的弹窗。
- **裁决解析**:Router 必须回 fenced JSON;解析失败记录 `unparsed` 决策并保留触发供重试,不做模型侧重问。
- **取消语义**:取消 Ticket 归档 Worker agent,Ticket 独占的 worktree 工作区一并归档(soft delete,可从 History 找回);共享的持久工作区(「默认 workspace」/档位工作区)保留,继续服务 Router 与后续 Ticket。
- **委派 MCP 通道**:`superagent_dispatch` 经插件自持 MCP server 注入(不走 daemon 的插件 agent tools 目录,因此宿主关闭 "Paseo tools" 不影响委派)。代价:插件重载后端口与密钥轮换,已打开会话中的旧 URL 在下次 session_open 刷新前调用会报连接错误;不支持 MCP server 的 provider 默认不注入(可用"注入 provider"设置覆盖)。
- **编排角色工具**:Router 的 `superagent_list`/`superagent_read`/`superagent_search` 与 Worker 的 `superagent_unsubscribe`/`superagent_handback` 走同一自持 endpoint,按 URL 角色参数区分工具集,在每次会话启动时经 session_open 注入(创建时的 agent config 不携带任何 MCP 配置:保存配置与插件注入同名冲突、预授权又要求 server 同请求存在,均会被 daemon 拒绝)。需要权限确认的 provider 上,插件的权限钩子会自动批准 Worker 的退订/转回与 Router/看门狗的回读工具,拒绝 Router/看门狗的其他工具;Worker 的其余权限照常交给人。回读与检索是只读的引擎状态视图,不含 IM 凭据;`superagent_list` 最多列最近 10 个活跃线程 × 每线程 8 张未完结票、`superagent_search` 最多回 20 条命中(均带截断标注);状态清理(300 触发/200 裁决/40 关闭线程)后旧 ID 回读返回"不存在"。
- **直通误投**:直通给唯一订阅 Worker 的消息若与其工单无关,Worker 用 `superagent_handback` 转回 Router 重新路由(可同时退订);Router 规则要求不得把同一条消息再 steer 回转出它的 Worker,防循环。
- **受宿主(Paseo/插件机制)限制而放弃**:
  - 云端无状态计算 + 状态入库(§5.1 的弹性形态):插件运行在单个 daemon 子进程里,只能做到「状态落盘 + 重启自恢复」;
  - 端侧轻量 daemon / BYOM / 按任务切换执行设备 / 间歇在线设备上线后补跑(§5.2):插件拿到的 Paseo API 只对应本机 daemon;
  - 主系统之外的独立控制回路:LLM 看门狗是独立会话,但驱动它的定时器与引擎同进程;
  - 看门狗在线改写提示词/触发规则:插件服务端只能读、不能写插件设置,改规则仍在设置页完成;
  - 无头重启后自启动:宿主不在插件启动时提供 Paseo 句柄,引擎在首个 hook/RPC 时启动(IM 已提前连上并排队消息,不丢);
- **按需求放弃**:GitHub/邮件/CI 等非 IM 触发源,仅支持现有五个 IM 通道;
- **暂不做(成本高)**:跨线程合并成一次 Router 调用的批处理(当前按线程合并,与官方原型一致);按群/会话粒度的准入档位(当前按通道开关观察模式);钉钉/企微的引用回复解析(通道不回传可用的消息 id)。

## 开发

```bash
npm install
npm run typecheck
```

目录:`shared/`(领域模型 + RPC 契约 + 设置,两端共用;execution 提供直通判定与会话状态推导)、`server/`(store/router/workers/engine)、`client/`(对话页 chat-screen、顶部标签 chat-tab-bar 与其本机副本 chat-tabs-store、消息流 chat-messages、输入框 chat-composer、右侧栏 chat-sidebar、设置页 settings-screen,以及 ui.tsx 里的按钮/徽标/提示条等小型原语;`shared/chat.ts` 把线程的触发与裁决排成对话)。引擎细节见 `server/engine.ts` 头注。

`npm test` 使用 Node.js 24+ 的内置测试运行器与现有 TypeScript 依赖,验证 Worker 续跑、投递失败回退、取消竞态、重启恢复与飞书连接清理;不连接真实 provider 或 IM 服务。

### iOS 闪退排查:避免整包导入 React Native

本插件曾出现启用后 iOS 连接 daemon 即闪退、Web 正常、禁用插件后恢复的故障。将 React Native 整包导入改为按需导入后,已在 Paseo 0.15.0 的 iOS 客户端确认解决。

触发点是 `client/host-font-scale.ts` 中的命名空间导入:

```ts
// 避免:会生成复制 React Native 全部导出的互操作代码。
import * as ReactNative from "react-native";
```

Paseo 0.15.0 的插件编译器为兼容 Hermes,会把 esbuild 的 `get: () => from[key]` 改为 `value: from[key]`。原本延迟读取的导出因此变成立即读取。React Native 通过 getter 延迟初始化模块,整包复制会提前加载插件未使用的 `PushNotificationIOS`、`DevMenu` 等模块;某个模块缺少原生实现时,初始化异常可能被 Metro 上报为 fatal error,导致整个 iOS app 退出。Web 不走相同的原生模块初始化路径,因此仅验证 Web 无法发现此问题。

修复方式是只导入实际使用的模块,避免生成整包复制代码:

```ts
import { NativeModules, Platform, TurboModuleRegistry } from "react-native";

const platform = Platform.OS;
```

该问题发生在插件 bundle 加载阶段,早于组件渲染和业务函数调用,函数内部的 `try/catch` 覆盖不到导入阶段。也应避免通过对象展开或遍历整个 React Native 导出对象再次触发全部 getter。原生存储访问只在 iOS/Android 分支执行,模块不可用时保留平台默认字号;浏览器 API 集中在 `client/web.ts`,每个入口先判断 `Platform.OS === "web"`。

回归测试 `tests/client-loading.test.mjs` 按上述编译规则生成 bundle,为未使用的原生模块设置抛错 getter,验证插件加载和注册不会访问它们,并覆盖 iOS/Android/Web 字号读取及异常回退:

```bash
node --import ./tests/register-typescript.mjs --test tests/client-loading.test.mjs
```

排查同类故障时,先检查实际下发 bundle 的导入代码与原生模块初始化路径,再结合 iOS 真机验证;只通过 TypeScript 检查或 Web 测试不足以确认跨端兼容。
