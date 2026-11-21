# 设置项

[← 返回 README](../README-CN.md) · [English](configuration-EN.md)

安装后侧栏出现 **Superagent** 入口。配置在 **Settings → Plugins → Superagent**(对话页未配置时会提示并一键跳转;Command Center 搜「Superagent 设置」也能打开)。设置按**基础 / 模型 / 规则 / 执行 / IM 触发源**分成五个标签页;所有修改进同一份草稿,切换标签页不会丢,点「保存」统一生效,输入有误会在对应行标红:

| 设置 | 说明 |
|---|---|
| Router 评估超时 | `routerEvalTimeoutMin`，默认 10 分钟，可设 1–60 分钟。准备、推理、回读与一次格式纠正共享总时限，准备最多 1 分钟。超时会取消请求并丢弃迟到裁决。API 错误从 15 秒起指数退避，间隔最高 5 分钟，最多 20 次。连续三轮解析失败会暂停自动评估。 |
| 对话空闲过期 | `threadIdleTimeoutMin`,默认 1440 分钟(24 小时),可设 5–43200 分钟。没有待处理工作时自动关闭 Thread 并回收遗留会话;有效入站、Worker 汇报与实际会话活动续期,巡检不续期。运行任务、待处理审批、跨线程活动或未送达回复会暂缓关闭。关闭后的新消息可重新激活仍被保留的线程;历史沿用现有保留上限。IM 跨日收口规则继续生效 |
| Worker 待命回收 | `workerIdleTimeoutMin`,默认 1440 分钟(24 小时),可设 1–43200 分钟。长期空闲的 waiting 票据完结并退订全部线程,保留汇报,归档 Worker 与其独占工作区;共享工作区保留。回收意图落盘,失败后看门狗继续清理。有新消息、待执行动作、实际运行或审批时暂缓;Worker 本轮结束后仍留着后台 shell/监控(Paseo 0.16 上报的 `backgroundWork`)时也暂缓,等它们结束再回收。审批/问题等待超过 24 小时提醒一次,保留请求供人工处理 |
| 工作目录 | daemon 上的绝对路径。派发默认 Worker 时需要填写。共享隔离按目录复用工作区，worktree 隔离要求路径位于 Git 仓库内。 |
| 推理 API 基础地址和 Router 模型 | `inferenceBaseUrl` 与 `routerModel`。使用支持函数调用的 Chat Completions API，地址包含版本路径，例如 `https://inference.example/v1`。插件补上 `/chat/completions`。需要 Bearer 鉴权时，在「推理 API 密钥」字段（`inferenceApiKey`）填写密钥。远程地址须使用 HTTPS，`127.0.0.1` 和 `[::1]` 等回环 IP 地址可使用 HTTP。 |
| Router 思考强度 | 可选的 `routerReasoningEffort`。打开模型或思考强度下拉框时，插件向配置的 API 请求 `GET /models`。可以按前缀搜索或直接填写。思考强度下拉框显示所选模型声明的档位，留空时沿用服务默认。更改端点或 Router 模型会清空该字段。 |
| thinking 档位（可选） | 默认 Worker 和具名档位可独立设置，候选来自 Paseo provider。 |
| Router 自定义规则 | `routerInstructions`，支持多行，最多 12000 字符。随每次评估的系统消息发送。 |
| IM 附件收件目录 | `imInboxDir`,daemon 主机上的绝对路径;留空为 `$PASEO_HOME/plugin-data/superagent/inbox`。聊天里收到的文件存到 `<目录>/<通道>/<北京时间日期>/<消息 id>/` 下,改后对下一条消息立即生效,不重连通道。各 Worker 档位的工作目录有自己的归档规则时,宜设成它们之外的中立目录,由 Worker 按规则移入任务目录 |
| IM 单条消息上限 | 默认 600,可设 100–4000 字符,沿用配置字段 `imReplyMaxChars`。超长答复按段落/换行优先拆分为多条,添加 `[1/N]` 序号(计入上限)后顺序发送,正文完整保留;普通 emoji 按字素边界拆分。发送前保存全部分段,每段确认成功后记录进度;失败暂停,在对话页右侧栏「状态 → 未送达的 IM 回复」从失败段补发(这一栏只列发送中与发送失败的回复,全部发出后即消失)。重启恢复未完成的发送,已确认的段不重发。远端已接收但回执丢失或落盘前崩溃时,该段仍可能重复,通道未提供统一的恰好一次投递保证 |
| Worker provider/model | 同上,建议配最强模型。配置了 Worker 档位时它是**默认 Worker**,可另填一句用途说明 |
| Worker 模式(可选) | 默认 Worker 与每个具名档位都可独立选择模式。一般 provider 的候选直接来自所选 provider 的快照(含 ACP 动态模式),与 Paseo 输入框的模式 ID 一致,选「Paseo 默认」时不传 `modeId`,按 Paseo 默认行为启动;provider 选 **pi** 时候选改由 daemon 主机上的 [pi-permission-modes](https://pi.dev/packages/pi-permission-modes) 扩展提供(读 `PI_CODING_AGENT_DIR` 或 `~/.pi/agent` 下的 `permission-mode/permission-mode.json`,与扩展内置模式合并),选中的模式经 `PI_PERMISSION_MODE` 环境变量传给新建或重试的 Worker(pi 不上报 mode,传 `modeId` 会被拒绝);扩展未安装时只剩「Paseo 默认」,Worker 按 pi 自己的默认模式启动。具名档位留空也不继承默认 Worker 的模式。切换 provider 会清空旧模式,同一 provider 更换模型会保留模式。模式随首条任务一起传入,修改用于新建或重试的 Worker,不修改运行中的会话;一般 provider 不支持的模式会在启动前报出可用 ID,不会静默退回默认模式 |
| Worker 档位 | 可选。默认 Worker 之外的具名档位(名字 + provider/model + 用途说明 + 可选专属工作目录),如 `code → codex/…`「写码、修 bug、跑测试」。Router 的 dispatch 用 `"profile":"<名字>"` 按用途为每个任务选档位;省略或名字不存在时用默认 Worker(后者记入裁决)。Router 只能用到这里列出的模型,触发文本无法把 Worker 引向任意 provider。档位的专属工作目录必须是绝对路径、可以和全局工作目录不同:worktree 隔离时该档位从自己的目录切 worktree,共享目录隔离时该目录有一个以档位名命名的持久工作区(与「默认 workspace」同一套复用机制)。Ticket 记录所选档位与实际模型:retry 沿用档位、按该档位当前设置的模型与目录启动;档位被删除后改用默认 Worker。不配置档位时行为与单一 Worker 完全一致 |
| Worker 隔离 | `worktree` 默认按工单创建隔离工作区。`shared` 按基础目录和档位复用持久工作区。 |
| Worker 后台运行 | `workerBackground`，默认关闭。开启时，新建和重试的 Worker 不出现在 Paseo 默认列表，仍可从 Superagent 打开。 |
| Worker 超时 / 失败重试次数 / 批处理窗口 / 单条消息上限 | 引擎调参(设置页「执行」分组,超出范围会就地提示) |
| 投机执行 | 「主动与巡检」分组,默认关。开启后 Router 规则里出现投机执行说明,Router 可依据你在「Router 规则」里写的主动策略(如「群里有人反馈问题时,静默复现并尝试简单修复」)派发 `speculative` Worker;同时最多 2 个,超出的投机派发直接丢弃并记入裁决 |
| LLM 看门狗 | 在「主动与巡检」里开启，默认关闭。`watchdogModel` 留空时沿用 Router 模型。间隔 5–240 分钟，默认 30。无异常且无需要关注的工单时跳过推理。 |
| 注入委派 MCP | 开启后所有普通 agent 的会话注入 `superagent_dispatch` 工具。走**插件自持的本地 MCP server**(`127.0.0.1` 随机端口 + 随机密钥路径),不受宿主 "Paseo tools"(`mcp.injectIntoAgents`)开关影响。同一 endpoint 还给 Worker 会话下发 `superagent_unsubscribe`/`superagent_handback`(会话控制)——这部分不受本开关控制。角色工具在**每次会话启动时经 session_open 注入**——不能写进 agent 保存配置:同名 mcpServer 与插件注入冲突会被 daemon 拒绝,`toolPolicy` 预授权引用的 server 又必须出现在同一请求里,两条都走不通。Router 与看门狗不再经此通道:它们的只读回读由推理循环直接执行 |
| 注入 provider | 允许注入上述 MCP 的 provider 家族,逗号分隔(如 `codex,claude`);留空 = claude,codex,opencode,omp,copilot。不支持 MCP server 的 provider(如 ACP 系)注入会导致会话启动失败,默认排除;在此填 `pi` 即向普通 pi 会话注入委派工具(工具经 pi 的 codemode 通道暴露,见 [Pi 集成](pi.md))。Router/Worker 的角色工具注入同样按「默认名单 ∪ 此名单」的家族门控(provider 带 model 限定时按 `/` 前的家族判断;插件型 provider 如 zcode-acp 由 daemon 统一声明支持 MCP,想给它注入就在此配置) |
