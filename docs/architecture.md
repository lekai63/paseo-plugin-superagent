# 架构与设计

[← 返回 README](../README-CN.md) · [English](architecture-EN.md)

## 能力一览

Paseo 的 Router/Worker 双层编排插件。按《Super-agent 设计探索》的架构思路,在 Paseo 原语之上实现事件驱动的 super-agent 编排层,**不依赖 DeepSeek Harness**:

- **每个活跃 Thread 一个 Router agent**(轻量模型)统一评估触发事件,只裁决、不执行;除内置工具外仅可调用编排自身的只读回读工具(`superagent_list` / `superagent_read` / `superagent_search`),截断的触发/汇报/历史存根都可按 ID 找回全文(Chain of Recall),只记得零碎关键词时用 `superagent_search` 在全部记录里检索命中(空格分词 AND,最多 20 条 ID + 短摘录);
- **Worker agent**(强模型)按 Ticket 执行:worktree 隔离时每个 Ticket 一个独立 worktree 工作区;共享目录隔离时默认 Worker 使用普通的「默认 workspace」,Router 与看门狗另用后台工作区(按工作目录创建、跨重启复用),parent 挂在 Router 名下,在 app 的 Subagents track 可见、可随时人工介入;
- **Worker 档位**:除默认 Worker 外可配置具名档位(不同模型/用途),每个档位还可指定自己的工作目录,让该档位的 Worker 在别的仓库或目录里工作;
- **订阅直通(fan-out,多对多)**:线程有活跃订阅 Worker 时,后续事件绕过 Router 程序直通**全部**订阅 Worker(零 LLM);一个可用会话都没有才交 Router 评估。Router 的 `subscribe` 动作可让别的线程里已在干活的 Worker **也跟随**当前线程(一个 Worker 订阅多个线程),跟随来的消息带 `[thread …]` 前缀,汇报回流到它订阅的每个线程;Worker 可用 `superagent_unsubscribe`(可指定 `threadId` 只退一个线程)退订、`superagent_handback` 把误投消息转回 Router;
- **语义慢路径**:观察模式旁听到的未 @ 群消息(context-only)不直通 Worker,一律交 Router 判断(默认忽略,与某个任务相关时 steer,符合主动策略时才行动);
- **权限与提问回流**:Worker 的权限请求、计划确认和结构化提问立即落盘并通知 Router。Router 根据已有授权/上下文用 `respond` 正式审批或回答;需要人的决定时,把具体操作/问题和选项回投原聊天或委派会话。请求未解决期间,线程后续消息先交 Router 判断,不向 Worker 广播,也不通过普通 steer 隐式清除请求。请求按 ID 去重,重载后由程序对账补收;等待输入期间暂停运行超时处理,响应后重新观察完成状态;
- **引用归线程 + 相邻消息内联**:IM 消息引用(回复)了已知的触发或 Router 答复(按通道回执记下的消息 id)时,归入被引用消息所在的线程,并把被引用内容内联给 Router/Worker;评估时附带本批之前 Router 没看过的最近 5 条未 @ 群聊(准入层 filtered 留痕,滚动保留 30 条);
- **投机执行**(可选,默认关):Router 依据「Router 规则」里写的主动策略对没人明确提出的事项后台派 `speculative` Worker 静默尝试(不订阅线程、同时最多 2 个),汇报首行 `DISCARD:` 由引擎静默丢弃并回收 Worker,`DELIVER:` 才交 Router 简短转述;
- **跨线程指挥**:通过 `superagent_search` / `superagent_list` 找线程,用 `superagent_read` 读详情后执行 steer/cancel/retry,不自动把其他线程状态塞入当前会话;
- **批处理**:同一批窗口内的触发合并进一次 Router LLM 调用;窗口一经武装不再被后续消息重置(有界合并,持续消息流不会无限推迟评估);
- **看门狗(两层)**:程序看门狗每 15 秒对账——错过完成、卡死启动、运行超时、评估重排、待执行动作补执行,进程重启后自恢复;**LLM 看门狗**(可选,默认关)是独立的 `Superagent Watchdog` 会话,按间隔收到全部未完结票据的进展摘要(会话状态、自上次巡检新增的时间线条目、静默时长、最近消息、权限等待)与引擎健康状况,判断有无实质进展/是否偏离任务,用 JSON 动作 `nudge`/`interrupt`/`cancel`/`retry`/`reeval`/`escalate` 介入(取消与上报经 Router 告诉人);维护者可在状态栏一键打开该会话直接问诊;
- **Router 只裁决(硬约束)**:Router/看门狗的权限请求由插件按策略应答——自身回读工具放行,其余工具、计划与模式切换一律拒绝;codex 系 Router/看门狗以只读沙箱创建,pi 系由 pi 扩展裁剪工具并拦截调用(见 [pi 集成](pi.md))。Worker 的退订/转回工具自动放行;
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
LLM 看门狗(独立会话,定时)── 巡检摘要 ──► nudge/interrupt/cancel/retry/reeval/escalate(上报经 Router 告诉人)
```

状态(`$PASEO_HOME/plugin-data/superagent/state.json`,原子写):`threads / triggers / tickets / decisions / pendingActions` + kv。Ticket 的 `pendingRequests` 保留待处理请求及问题选项。所有副作用(创建 agent、发消息)发生在落盘之后;裁决的副作用动作(steer/respond/cancel/retry/stop)先立案成 `pendingActions` 记录、执行成功后移除,看门狗负责崩溃后按序补执行与失败重试(有次数上限,耗尽后失败回流成触发交 Router 重新决策)。`respond` 绑定 Worker 会话和请求 ID,重复执行不会误答其他请求,也不扩大持久授权范围。

## 与文章五模块的对应

| 模块 | 实现 |
|---|---|
| 双层架构 | Router = 每活跃 Thread 一个持久 agent(只裁决由权限钩子硬约束:非自身工具一律拒绝,codex 系只读沙箱,pi 系由 pi 扩展裁剪工具)(`superagent.role=router` 标签,provider 可配轻量模型,只裁决、不执行,唯一可用的工具是编排自身的只读回读);固定规则与 actions 示例只初始化一次。已确认支持 systemPrompt 的内置 claude/codex/opencode/omp/pi 在创建时设置;ACP(如 zcode-acp)及其他 provider 通过首轮消息初始化。Worker = 每 Ticket 独立 agent + worktree 隔离 + `superagent.ticket` 标签,可按 Worker 档位让不同 Ticket 跑在不同模型上;层级在 app 的 Subagents track 可见。跨线程指挥:通过 superagent_search / superagent_list 找线程、superagent_read 读详情,steer/cancel/retry 可指向其票据,裁决仍记录在本线程 |
| 事件驱动 | Trigger 三源(手动/agent 工具/worker 汇报)+ 五个 IM 通道;fast-path 程序过滤(白名单之外,未 @ 群消息记 filtered 留痕,观察模式下作上下文候选,且一律走 Router 语义判断、不直通 Worker);IM Thread 按渠道、机器人账号、聊天会话和北京时间日期划分;同日引用继续当前 Thread,跨日引用只带上下文、不重开旧 Thread;批窗口合并评估(窗口有界,不随后续消息重置,按线程合并);订阅 fan-out 直通,多对多(Router `subscribe` 让 Worker 跟随其他线程,汇报回流到每个订阅线程)。Inline:被引用消息内联、最近 5 条未 @ 相邻群聊内联。投机执行(可选):`speculative` 派发,DELIVER/DISCARD 交付或静默丢弃,并发上限 2。正常续轮只带新触发(每条最多 4000 字,截断处标注回读指针)、任务状态快照、尚未读过的直通上下文(最近 8 条、每条最多 1000 字)。Chain of Recall:提示词里的触发/票据/线程/裁决均带 ID,历史存根也保留 ID,Router 用 `superagent_read` 按 ID 找回完整未截断记录(线程回读内联最近 10 条消息与 5 条裁决的 ID、跟随它的其他线程票据;票据回读内联跟随的线程与 Worker 会话最近 3 条消息,沿引用逐跳展开)、用 `superagent_list` 总览活跃线程(最近 10 个)、用 `superagent_search` 按关键词检索全部记录;Worker 汇报回流时截断的文本附带票据回读指针,汇报首行被要求写成含关键实体(路径/ID/命令)的自足结论句(存根与检索都取开头)。内置记忆纪律:跨轮承诺必须落 ticket 或 reply,stop/跨线程裁决目标不明时先 `superagent_list` 对账。不重复用户首行标题或 Ticket 汇报正文;线程首次恢复时才补最多 8 条历史存根 |
| 面向人的交互 | Paseo app 即信道:推送、attention、权限流;任意 agent 会话内 `/superagent` 或 `superagent_dispatch` 工具委派,Router 答复经 sourceAgentId 回到原会话;Worker 会话可随时人工接管。多渠道输出风格:IM 来源线程的评估提示词带渠道风格小节(答复保持简短、长内容派 Worker 后转述摘要与产物位置),超长答复仍按段落自动分段回投 直通误投自愈:Worker 调 `superagent_handback` 把不属于自己的消息转回 Router 重新路由(继承原 IM/agent 回投目标),`superagent_unsubscribe` 退订后续直通 |
| 存算/环境分离 | 即 Paseo daemon 本身:daemon 在你的机器,客户端(relay E2EE)在任何地方;执行环境留在原地。状态落盘(state.json)+ 重启自恢复是单机形态的「计算与状态分离」;云端无状态计算与端侧 daemon 受宿主形态限制不做(见 [设计取舍与限制](#设计取舍与限制)) |
| Watchdog | 程序层 15s 对账:launch 卡死重试、运行超时 reload+判败、idle 收割汇报、评估重排、Router 丢失重建;LLM 层(可选)独立 `Superagent Watchdog` 会话按间隔判断进展与偏离,经 JSON 动作介入,维护者可直接在该会话问诊 |

## 设计取舍与限制

- **会话与提示缓存**:Thread 与 Router 映射和已读游标随插件状态持久化,插件重启后继续原生会话。固定规则、工具定义与顺序保持稳定,新事件追加在历史后;压缩后补恢复窗口。pi 适配器会移除 Paseo 冻结提示词中位于角色规则之前的通用编程提示词、项目上下文和临时目录,保留角色规则及其后的 daemon 指令。缓存命中率以 provider usage 为准。
- **调用预算**:Router 单次评估(包含一次格式纠正)和看门狗单次巡检最多执行 12 次回读,同名工具相同参数最多 3 次;每次回读结果都附带已用次数。超额是软限制:超出的调用被拒绝(不执行),拒绝原因要求模型立即给出裁决,pi 扩展同时撤掉全部工具。拒绝后仍继续调用(超过 4 次)才中断本轮;Router 随后在同一会话补一轮「不再回读、立即裁决」(提示首行带预算耗尽标记,pi 扩展据此不提供工具),保留已回读的上下文。补救仍失败才记为评估错误,错误文案注明回读预算耗尽,留下异常标记,下次重建恢复。超时和错误返回不能执行历史裁决。检索无命中时提示不要反复换词;检索结果不含调用方本线程的待评估触发与线程本身(已在提示词里)。
- **界面实时刷新**:对话页与侧栏经 Paseo 0.16 的插件订阅 `superagent.state_events` 接收状态变化:引擎状态(落盘记录、评估/巡检进行中、设置)一变,合并 150 ms 后推一个版本号,界面只在版本与缓存的快照不同时重读 `superagent.state`。推送在线时轮询放宽到 30 秒兜底(刷新程序看门狗时间这类不推送的字段);旧版 app 没有订阅接口、订阅被关闭(插件重载、daemon 重启)时回到每 3 秒轮询,5 秒后重新订阅。Worker/Router 会话状态仍直接读 daemon。
- **评估串行**:各 Thread 的 Router 会话独立,引擎仍串行评估,避免并发消费同一批触发和副作用。
- **失败退避(分两类)**:unparsed(Router 输出无法解析)连续 3 次后看门狗不再自动重排,需在对话右侧栏「任务」里点「重新评估」手动重试——防止 Router 持续劣化时烧 token 的失控循环;基础设施异常(provider 未就绪、目录不可用等瞬时故障)不计入熔断,按看门狗节奏持续重查约 5 分钟(20 个周期),对齐文章「瞬时故障持续重查直到恢复」。
- **权限等待**:Worker 的权限请求走 Paseo 原生权限流(app 内批准);等待期间 Ticket 保持运行,不误判完成。
- **外部 Trigger 源**:飞书/QQ 已支持;GitHub/Slack 轮询源是下一扩展点(Paseo Hub 触发器亦可作为上游把事件投给 `superagent.dispatch`)。
- **文件预览**:药丸类型由 `superagent.stat_files` 一次查完一段对话里的所有路径(最多 200 个,结果缓存 1 分钟);预览经 `superagent.read_file` RPC 由 daemon 只读读取任意绝对路径(`~` 展开为 daemon 用户主目录),不限于工作区——能连上 daemon 的客户端本就可以让 agent 执行命令,不算新增权限。文本最多读 256 KB(超出只显示开头)、图片不超过 4 MB、目录最多列 500 项;设备、管道等特殊文件不读;开头 8000 字节含 NUL 的按二进制处理,只显示大小。只认答复里指向绝对路径的链接,相对路径、行内代码与代码块里的路径不识别;不能编辑,也不会跳转到宿主的文件标签页(插件 SDK 0.15 没有打开文件的接口)。宿主 Modal 的桌面卡片固定最宽 520 且插件无法调整,桌面 Web 的预览因此改用 RN Modal 自画、外观仿照宿主的弹窗。
- **裁决解析**:Router 必须回 fenced JSON;解析失败记录 `unparsed` 决策并保留触发供重试,在本轮剩余超时预算内纠正一次;仍失败才保留触发供下一轮新会话重试。
- **取消语义**:取消 Ticket 归档 Worker agent,Ticket 独占的 worktree 工作区一并归档(soft delete,可从 History 找回);共享的持久工作区(「默认 workspace」/档位工作区)保留,继续服务后续 Ticket。Router 与看门狗另用持久后台工作区。
- **委派 MCP 通道**:`superagent_dispatch` 经插件自持 MCP server 注入(不走 daemon 的插件 agent tools 目录,因此宿主关闭 "Paseo tools" 不影响委派)。代价:插件重载后端口与密钥轮换,已打开会话中的旧 URL 在下次 session_open 刷新前调用会报连接错误;不支持 MCP server 的 provider 默认不注入(可用"注入 provider"设置覆盖)。
- **编排角色工具**:Router 的 `superagent_list`/`superagent_read`/`superagent_search` 与 Worker 的 `superagent_unsubscribe`/`superagent_handback` 走同一自持 endpoint,按 URL 角色参数区分工具集,在每次会话启动时经 session_open 注入(创建时的 agent config 不携带任何 MCP 配置:保存配置与插件注入同名冲突、预授权又要求 server 同请求存在,均会被 daemon 拒绝)。需要权限确认的 provider 上,插件的权限钩子会自动批准 Worker 的退订/转回与 Router/看门狗的回读工具,拒绝 Router/看门狗的其他工具;Worker 的其余权限照常交给人。回读与检索是只读的引擎状态视图,不含 IM 凭据;`superagent_list` 最多列最近 10 个活跃线程 × 每线程 8 张未完结票、`superagent_search` 最多回 20 条命中(均带截断标注);状态清理(300 触发/200 裁决/40 关闭线程)后旧 ID 回读返回"不存在"。pi 系会话的工具注册与只裁决约束由 pi 扩展承担(env 下发 URL,扩展以 direct exposure 注册并裁剪工具),见 [pi 集成](pi.md)。
- **直通误投**:直通给唯一订阅 Worker 的消息若与其工单无关,Worker 用 `superagent_handback` 转回 Router 重新路由(可同时退订);Router 规则要求不得把同一条消息再 steer 回转出它的 Worker,防循环。
- **受宿主(Paseo/插件机制)限制而放弃**:
  - 云端无状态计算 + 状态入库(§5.1 的弹性形态):插件运行在单个 daemon 子进程里,只能做到「状态落盘 + 重启自恢复」;
  - 端侧轻量 daemon / BYOM / 按任务切换执行设备 / 间歇在线设备上线后补跑(§5.2):插件拿到的 Paseo API 只对应本机 daemon;
  - 主系统之外的独立控制回路:LLM 看门狗是独立会话,但驱动它的定时器与引擎同进程;
  - 看门狗在线改写提示词/触发规则:插件服务端只能读、不能写插件设置,改规则仍在设置页完成;
  - 无头重启后自启动:宿主不在插件启动时提供 Paseo 句柄,引擎在首个 hook/RPC 时启动(IM 已提前连上并排队消息,不丢);
- **按需求放弃**:GitHub/邮件/CI 等非 IM 触发源,仅支持现有五个 IM 通道;
- **暂不做(成本高)**:跨线程合并成一次 Router 调用的批处理(当前按线程合并,与官方原型一致);按群/会话粒度的准入档位(当前按通道开关观察模式);钉钉/企微的引用回复解析(通道不回传可用的消息 id)。
