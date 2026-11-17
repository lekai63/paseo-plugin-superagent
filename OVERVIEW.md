# Superagent

Superagent turns Paseo into an event-driven orchestrator. Each active conversation gets a Router agent that reads new messages and decides what to do; work is handed to Worker agents that run in their own worktree or a shared directory and report back.

## How it works

- **Router.** One Router session per conversation, ideally on a lightweight model. It answers with JSON actions: dispatch a Worker, steer or cancel one, retry, answer a Worker's permission request or question, subscribe a Worker to the conversation, reply, ignore, or stop. A permission hook rejects every other tool the Router tries to use, except the plugin's own read-only recall and search tools.
- **Workers.** Each ticket starts a Worker session, ideally on a stronger model, as a child of the Router. Workers are visible in the app and you can take over any of them. Named Worker profiles let the Router choose a different provider, model, mode, thinking level or working directory per task.
- **Direct delivery.** While a Worker is subscribed to a conversation, follow-up messages go straight to it without a model call.
- **Watchdog.** A built-in check runs every 15 seconds to recover missed completions, stuck launches, timeouts and pending actions, including after a daemon restart. An optional LLM watchdog reviews task progress on an interval.
- **Triggers.** Messages come from the plugin's chat page, the `/superagent` slash command in any agent session, an optional `superagent_dispatch` tool injected into agent sessions, and optional IM channels: Feishu, DingTalk, WeCom, WeChat (Tencent ClawBot / iLink) and QQ (OneBot 11 through NapCat).

## Setup

- Requires Paseo 0.16.0 or later on the daemon and every client, and Node.js 20 or later with npm on the daemon host.
- Open **Settings → Plugins → Superagent** and set the working directory, an absolute path on the daemon host. `worktree` isolation needs it to be inside a git repository; `shared` isolation does not.
- Pick providers and models for the Router and the default Worker, or leave them empty to use the first available one (claude, then codex, then opencode, then any other).
- Each IM channel is off by default. Enabling one needs that platform's bot credentials and an allowlist of senders or chats; a channel with an empty allowlist does not start. WeChat logs in by scanning a QR code shown in settings.
- To use pi as the Router or a Worker, copy the bundled pi extension into pi's extensions directory. The README has the exact steps and install sources.

The interface is in English, or in Simplified Chinese when Paseo is set to Simplified Chinese.

## Data and permissions

- Conversation messages, IM messages, Worker reports and the local paths of downloaded attachments are sent as prompts to the agent providers you configure.
- State is stored in `$PASEO_HOME/plugin-data/superagent/`. IM credentials are stored in plain text in the plugin settings file (mode 0600); WeChat bot credentials are stored separately in `$PASEO_HOME/plugin-data/superagent/weixin/` (0600).
- Enabled IM channels open connections to the Feishu Open Platform, DingTalk Stream, WeCom bot service or `ilinkai.weixin.qq.com`, or to the NapCat WebSocket you specify. Attachments are downloaded to the inbox directory on the daemon host (100 MB per file). Archives are listed but not extracted; listing `.7z`/`.rar` uses the `7z` command if it is installed.
- The plugin runs a local MCP server on `127.0.0.1` with a random port and secret path to give its own sessions their tools.
- The chat page can preview any absolute path linked from a reply, read-only and size-limited, through the daemon.
- Workers act with the permissions of their provider and mode; permission requests are answered by the Router or relayed to you.

## Limitations

- Router evaluations run one at a time.
- The orchestrator starts on the first hook or RPC after the daemon starts; IM messages that arrive earlier are queued on disk.
- DingTalk and WeCom replies cannot be threaded by quote; WeChat supports direct messages only.
- The pi extension is a manual copy and is not updated with the plugin.
