# Superagent

Superagent turns Paseo into an event-driven orchestrator. The Router evaluates messages through an inference API. Paseo Workers execute tickets in isolated worktrees or shared directories, then report back to the conversation.

## How it works

- **Router.** Each evaluation provides new messages, thread memory, and ticket state. The model returns a structured verdict and may recall records from the current conversation, including earlier days of the same IM chat.
- **Workers.** Each ticket starts a Paseo Worker. Named profiles can specify models, permissions, or working directories. Open Workers from the Superagent Tasks sidebar.
- **Direct delivery.** While a Worker is subscribed to a conversation, follow-up messages go straight to it without a model call.
- **Watchdog.** A built-in check runs every 15 seconds to recover missed completions, stuck launches, timeouts and pending actions, including after a daemon restart. An optional LLM watchdog reviews task progress on an interval.
- **Triggers.** Messages come from the plugin's chat page, the `/superagent` slash command in any agent session, an optional `superagent_dispatch` tool injected into agent sessions, and optional IM channels: Feishu, DingTalk, WeCom, WeChat (Tencent ClawBot / iLink) and QQ (OneBot 11 through NapCat).

## Setup

- Requires Paseo 0.16.0 or later on the daemon and every client, and Node.js 20 or later with npm on the daemon host.
- Open **Settings → Plugins → Superagent** and set the working directory, an absolute path on the daemon host. `worktree` isolation needs it to be inside a git repository; `shared` isolation does not.
- Under Model, set a Chat Completions API base URL with function calling and the Router model ID. Enter an inference API key there if the endpoint requires Bearer authentication. Use HTTPS for remote endpoints. HTTP is supported for loopback IP addresses. Worker providers are selected separately.
- Each IM channel is off by default. Enabling one needs that platform's bot credentials and an allowlist of senders or chats; a channel with an empty allowlist does not start. WeChat logs in by scanning a QR code shown in settings.
- Superagent tools for Pi Workers and delegation require Pi 1.5 or later and use Pi's built-in MCP codemode channel. On earlier Pi versions, a session that receives these tools fails to start. Upgrade Pi or select a different Worker provider.

The interface is in English, or in Simplified Chinese when Paseo is set to Simplified Chinese.

## Data and permissions

- Conversation messages, IM messages, Worker reports and the local paths of downloaded attachments are sent as prompts to the agent providers you configure.
- State is stored in `$PASEO_HOME/plugin-data/superagent/`. The inference API key and IM credentials are stored in plain text in the plugin settings file (mode 0600). WeChat bot credentials are stored separately in `$PASEO_HOME/plugin-data/superagent/weixin/` (0600).
- Enabled IM channels open connections to the Feishu Open Platform, DingTalk Stream, WeCom bot service or `ilinkai.weixin.qq.com`, or to the NapCat WebSocket you specify. Attachments are downloaded to the inbox directory on the daemon host (100 MB per file). Archives are listed but not extracted; listing `.7z`/`.rar` uses the `7z` command if it is installed.
- The plugin runs a local MCP server on `127.0.0.1` with a random port and secret path to give its own sessions their tools.
- The chat page can preview any absolute path linked from a reply, read-only and size-limited, through the daemon.
- The Router sends conversation-scoped context and recall results to the inference API. The optional watchdog sends operational context across conversations. Its detailed findings are shown in Paseo. The plugin validates and applies the verdicts.
- Workers act with the permissions of their provider and mode.
- Only you approve a Worker's tool, plan or mode request. Superagent posts each request, quoted from the provider, to the conversation that started the task (the chat page, or the IM chat or agent session it came from) with a short code. The Worker stays paused until you send `/approve <code>` or `/deny <code> [reason]`, or answer it in the Worker's session in Paseo. An approval allows that one request once.
- You can approve from the chat page, the `/superagent` slash command, or the Worker’s Paseo session. In IM, approval is available once Superagent delivers the specific request to the original chat, subject to the channel allowlist. In Feishu groups, text approval commands must mention the bot.
- The Router never approves. Superagent refuses any approval it attempts and sends you the request instead. The Router can decline a request, and it can answer a Worker's question (a `question` request) from the conversation, or ask you.
- Workers' calls to the plugin's own Superagent tools, such as unsubscribe and hand back, are allowed automatically.

## Limitations

- Router evaluations run one at a time.
- The orchestrator starts on the first hook or RPC after the daemon starts; IM messages that arrive earlier are queued on disk.
- DingTalk and WeCom replies cannot be threaded by quote; WeChat supports direct messages only.
- On pi, Superagent tools are exposed through the codemode channel (lazy loading): the model reaches them via codemode scripts rather than direct tool declarations.
