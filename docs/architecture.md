# 架构与设计

[← 返回 README](../README-CN.md) · [English](architecture-EN.md)

## 能力一览

Paseo 的 Router/Worker 双层编排插件。按《Super-agent 设计探索》的架构思路,在 Paseo 原语之上实现事件驱动的 super-agent 编排层,**不依赖 DeepSeek Harness**:

- **Router 按线程评估**。每轮向独立推理 API 发送新触发、任务状态、保存的线程记忆和有界历史。模型返回 JSON 裁决，可用 `superagent_list/read/search` 只读回读已有记录。
- **Worker agent** 按 Ticket 执行。worktree 隔离时每个 Ticket 有独立工作区，共享隔离按目录和档位复用工作区。Superagent 根据 Ticket 关联和打开 Worker。
- **Worker 档位**:除默认 Worker 外可配置具名档位(不同模型/用途),每个档位还可指定自己的工作目录,让该档位的 Worker 在别的仓库或目录里工作;
- **订阅直通(fan-out,多对多)**:线程有活跃订阅 Worker 时,后续事件绕过 Router 程序直通**全部**订阅 Worker(零 LLM);一个可用会话都没有才交 Router 评估。Router 的 `subscribe` 动作可让别的线程里已在干活的 Worker **也跟随**当前线程(一个 Worker 订阅多个线程),跟随来的消息带 `[thread …]` 前缀,汇报回流到它订阅的每个线程;Worker 可用 `superagent_unsubscribe`(可指定 `threadId` 只退一个线程)退订、`superagent_handback` 把误投消息转回 Router;
- **语义慢路径**:观察模式旁听到的未 @ 群消息(context-only)不直通 Worker,一律交 Router 判断(默认忽略,与某个任务相关时 steer,符合主动策略时才行动);
- **权限与提问回流**:Worker 的权限请求、计划确认和结构化提问立即落盘。权限请求(`question` 以外的所有类型)必须由人决定:引擎直接把请求按 provider 原文、附一个由票据与请求 ID 派生的短批准码回投原聊天或委派会话,不交 Router。只有来自人的 `/approve <批准码>` 或 `/deny <批准码> [原因]`(对话页、`/superagent` 斜杠命令,或白名单 IM 发送者在通知所在聊天里 @ 机器人发出),或在 Worker 会话里直接处理,才能解决它;命令由引擎执行、不调用模型,一次批准只放行这一个请求、这一次。Router 可以拒绝权限请求,但永远不能批准:Router 对此类请求给出的 `allow` 在立案裁决和重放落盘动作时都会被引擎拒绝,改为把请求和批准码发给人。结构化提问交 Router,由它依据已有上下文用 `respond` 回答,或回投原聊天问人。请求未解决期间,线程后续消息先交 Router 判断,不向 Worker 广播,也不通过普通 steer 隐式清除请求。请求按 ID 去重,重载后由程序对账补收;等待输入期间暂停运行超时处理,响应后重新观察完成状态;
- **引用归线程 + 相邻消息内联**:IM 消息引用(回复)了已知的触发或 Router 答复(按通道回执记下的消息 id)时,归入被引用消息所在的线程,并把被引用内容内联给 Router/Worker;评估时附带本批之前 Router 没看过的最近 5 条未 @ 群聊(准入层 filtered 留痕,滚动保留 30 条);
- **投机执行**(可选,默认关):Router 依据「Router 规则」里写的主动策略对没人明确提出的事项后台派 `speculative` Worker 静默尝试(不订阅线程、同时最多 2 个),汇报首行 `DISCARD:` 由引擎静默丢弃并回收 Worker,`DELIVER:` 才交 Router 简短转述;
- **跨线程指挥**:通过 `superagent_search` / `superagent_list` 找线程,用 `superagent_read` 读详情后执行 steer/cancel/retry,不自动把其他线程状态塞入当前会话;
- **批处理**:同一批窗口内的触发合并进一次 Router LLM 调用;窗口一经武装不再被后续消息重置(有界合并,持续消息流不会无限推迟评估);
- **看门狗分两层**。程序层每 15 秒补收 Worker 完成、回收超时运行、恢复评估和待执行动作。可选的 LLM 层将活动增量、未完成工单、权限等待和近期干预组成摘要，调用推理 API 判断进展。插件核对当前目标后应用裁决。
- **推理边界**。Router 和 LLM 看门狗通过插件提供的函数回读编排记录。工作区和 Worker 动作留在 Paseo。传给推理端的数据可以包含用户消息、IM 内容、Worker 汇报和路径。
- **IM 触发源**:飞书(官方长连接)、QQ(OneBot 11 / NapCat)、钉钉、企业微信、微信(腾讯官方 ClawBot / iLink,扫码登录)接收指令,Router 答复回到原聊天;插件启动即连接,引擎启动(首个 hook/RPC)之前到达的消息先落盘,启动后补直通/评估。

## 架构图

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
LLM 看门狗（独立推理，定时）── 巡检摘要 ──► nudge/interrupt/cancel/retry/reeval/escalate(上报经 Router 告诉人)
```

状态(`$PASEO_HOME/plugin-data/superagent/state.json`,原子写):`threads / triggers / tickets / decisions / pendingActions` + kv。Ticket 的 `pendingRequests` 保留待处理请求及问题选项。所有副作用(创建 agent、发消息)发生在落盘之后;裁决的副作用动作(steer/respond/cancel/retry/stop)先立案成 `pendingActions` 记录、执行成功后移除,看门狗负责崩溃后按序补执行与失败重试(有次数上限,耗尽后失败回流成触发交 Router 重新决策)。`respond` 绑定 Worker 会话和请求 ID,重复执行不会误答其他请求,也不扩大持久授权范围。

## 与文章五模块的对应

| 模块 | 实现 |
|---|---|
| 双层架构 | Router 通过独立 API 返回裁决。Worker 是按票据创建的 Paseo agent，通过 `superagent.ticket` 和工单状态关联。跨线程操作可先回读目标。 |
| 事件驱动 | Trigger 三源(手动/agent 工具/worker 汇报)+ 五个 IM 通道;fast-path 程序过滤(白名单之外,未 @ 群消息记 filtered 留痕,观察模式下作上下文候选,且一律走 Router 语义判断、不直通 Worker);IM Thread 按渠道、机器人账号、聊天会话和北京时间日期划分;同日引用继续当前 Thread,跨日引用只带上下文、不重开旧 Thread;批窗口合并评估(窗口有界,不随后续消息重置,按线程合并);订阅 fan-out 直通,多对多(Router `subscribe` 让 Worker 跟随其他线程,汇报回流到每个订阅线程)。Inline:被引用消息内联、最近 5 条未 @ 相邻群聊内联。投机执行(可选):`speculative` 派发,DELIVER/DISCARD 交付或静默丢弃,并发上限 2。评估携带本轮新触发、任务快照和有界上下文。Chain of Recall:提示词里的触发/票据/线程/裁决均带 ID,历史存根也保留 ID,Router 用 `superagent_read` 按 ID 找回完整未截断记录(线程回读内联最近 10 条消息与 5 条裁决的 ID、跟随它的其他线程票据;票据回读内联跟随的线程与 Worker 会话最近 3 条消息,沿引用逐跳展开)、用 `superagent_list` 总览活跃线程(最近 10 个)、用 `superagent_search` 按关键词检索全部记录;Worker 汇报回流时截断的文本附带票据回读指针,汇报首行被要求写成含关键实体(路径/ID/命令)的自足结论句(存根与检索都取开头)。内置记忆纪律:跨轮承诺必须落 ticket 或 reply,stop/跨线程裁决目标不明时先 `superagent_list` 对账。不重复用户首行标题或 Ticket 汇报正文;历史存根追加式保留(最多 40 条,超限一次裁到 24 条,评估提示词因此获得跨轮稳定前缀,提升前缀缓存命中) |
| 面向人的交互 | Paseo app 即信道:推送、attention、权限流;任意 agent 会话内 `/superagent` 或 `superagent_dispatch` 工具委派,Router 答复回到原委派会话;Worker 会话可随时人工接管。多渠道输出风格:IM 来源线程的评估提示词带渠道风格小节(答复保持简短、长内容派 Worker 后转述摘要与产物位置),超长答复仍按段落自动分段回投 直通误投自愈:Worker 调 `superagent_handback` 把不属于自己的消息转回 Router 重新路由(继承原 IM/agent 回投目标),`superagent_unsubscribe` 退订后续直通 |
| 存算/环境分离 | 即 Paseo daemon 本身:daemon 在你的机器,客户端(relay E2EE)在任何地方;执行环境留在原地。状态落盘(state.json)+ 重启自恢复是单机形态的「计算与状态分离」;云端无状态计算与端侧 daemon 受宿主形态限制不做(见 [设计取舍与限制](#设计取舍与限制)) |
| Watchdog | 程序层负责恢复与执行。LLM 层通过有界巡检摘要判断任务进展，并记录最近结果和调用用量。 |

## 设计取舍与限制

- **上下文与记忆**。每轮重建上下文，包含当前批次、工单状态、线程历史存根（追加式保留，最多 40 条，超限一次裁到 24 条）和最近 8 条直通消息。Router 可在成功裁决时更新最多 12 条带触发 ID 的持久记忆。提示词布局面向前缀缓存：固定规则、消息头部与追加式线程历史构成跨轮字节稳定的最长公共前缀；summary、线程记忆与票据快照等每轮可变内容排在历史之后。缓存命中由推理服务统计。
- **调用预算**。一轮最多 12 次回读，同一函数同一参数最多 3 次。插件限制回读文本总量。预算用完时，取消工具列表并要求模型给出裁决。准备、请求、回读和一次格式纠正共享同一截止时间，过期结果不能进入动作执行。
- **界面实时刷新**:对话页与侧栏经 Paseo 0.16 的插件订阅 `superagent.state_events` 接收状态变化:引擎状态(落盘记录、评估/巡检进行中、设置)一变,合并 150 ms 后推一个版本号,界面只在版本与缓存的快照不同时重读 `superagent.state`。推送在线时轮询放宽到 30 秒兜底(刷新程序看门狗时间这类不推送的字段);旧版 app 没有订阅接口、订阅被关闭(插件重载、daemon 重启)时回到每 3 秒轮询,5 秒后重新订阅。Worker 会话状态读 daemon，Router 与巡检状态来自插件快照。
- **评估串行**。引擎逐线程处理触发批次，并在提交前重新核对线程与触发状态。
- **失败退避(分两类)**:unparsed(Router 输出无法解析)连续 3 次后看门狗不再自动重排,需在对话右侧栏「任务」里点「重新评估」手动重试——防止 Router 持续劣化时烧 token 的失控循环;基础设施异常(provider 未就绪、目录不可用等瞬时故障)不计入熔断,按看门狗节奏持续重查约 5 分钟(20 个周期),对齐文章「瞬时故障持续重查直到恢复」。
- **权限等待**:Worker 的权限请求走 Paseo 原生权限流,由人在 app 内或用 `/approve <批准码>` 批准;等待期间 Ticket 保持运行,不误判完成。
- **外部 Trigger 源**:飞书/QQ 已支持;GitHub/Slack 轮询源是下一扩展点(Paseo Hub 触发器亦可作为上游把事件投给 `superagent.dispatch`)。
- **文件预览**:药丸类型由 `superagent.stat_files` 一次查完一段对话里的所有路径(最多 200 个,结果缓存 1 分钟);预览经 `superagent.read_file` RPC 由 daemon 只读读取任意绝对路径(`~` 展开为 daemon 用户主目录),不限于工作区——能连上 daemon 的客户端本就可以让 agent 执行命令,不算新增权限。文本最多读 256 KB(超出只显示开头)、图片不超过 4 MB、目录最多列 500 项;设备、管道等特殊文件不读;开头 8000 字节含 NUL 的按二进制处理,只显示大小。只认答复里指向绝对路径的链接,相对路径、行内代码与代码块里的路径不识别;不能编辑,也不会跳转到宿主的文件标签页(插件 SDK 0.15 没有打开文件的接口)。宿主 Modal 的桌面卡片固定最宽 520 且插件无法调整,桌面 Web 的预览因此改用 RN Modal 自画、外观仿照宿主的弹窗。
- **裁决解析**。插件校验 JSON 结构与动作约束。在总时限内发一次格式纠正，仍失败时记录 `unparsed` 并保留触发。
- **取消语义**:取消 Ticket 归档 Worker agent,Ticket 独占的 worktree 工作区一并归档(soft delete,可从 History 找回);共享的持久工作区(「默认 workspace」/档位工作区)保留,继续服务后续 Ticket。
- **委派 MCP 通道**:`superagent_dispatch` 经插件自持 MCP server 注入(不走 daemon 的插件 agent tools 目录,因此宿主关闭 "Paseo tools" 不影响委派)。代价:插件重载后端口与密钥轮换,已打开会话中的旧 URL 在下次 session_open 刷新前调用会报连接错误;不支持 MCP server 的 provider 默认不注入(可用"注入 provider"设置覆盖)。
- **编排工具**。推理端的回读由插件直接调用本地记录视图。Worker 的退订和转回以及普通 Agent 的委派继续经本地 MCP 注入。
- **直通误投**:直通给唯一订阅 Worker 的消息若与其工单无关,Worker 用 `superagent_handback` 转回 Router 重新路由(可同时退订);Router 规则要求不得把同一条消息再 steer 回转出它的 Worker,防循环。
- **受宿主(Paseo/插件机制)限制而放弃**:
  - 云端无状态计算 + 状态入库(§5.1 的弹性形态):插件运行在单个 daemon 子进程里,只能做到「状态落盘 + 重启自恢复」;
  - 端侧轻量 daemon / BYOM / 按任务切换执行设备 / 间歇在线设备上线后补跑(§5.2):插件拿到的 Paseo API 只对应本机 daemon;
  - 主系统之外的独立控制回路。巡检定时器与引擎同进程，推理由配置的 API 承担。
  - 看门狗在线改写提示词/触发规则:插件服务端只能读、不能写插件设置,改规则仍在设置页完成;
  - 无头重启后自启动:宿主不在插件启动时提供 Paseo 句柄,引擎在首个 hook/RPC 时启动(IM 已提前连上并排队消息,不丢);
- **按需求放弃**:GitHub/邮件/CI 等非 IM 触发源,仅支持现有五个 IM 通道;
- **暂不做(成本高)**:跨线程合并成一次 Router 调用的批处理(当前按线程合并,与官方原型一致);按群/会话粒度的准入档位(当前按通道开关观察模式);钉钉/企微的引用回复解析(通道不回传可用的消息 id)。
