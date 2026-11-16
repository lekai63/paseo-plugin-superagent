# pi integration (Router / Worker / delegation entry point)

[← Back to README](../README-EN.md) · [简体中文](pi.md)

pi (pi-coding-agent ≥ 1.5.0) can serve as the provider for the Router, the watchdog and Workers, and can also receive delegation injection. The pi family does not use MCP injection, for two reasons: Paseo's config conversion to pi does not pass `exposure` through, so pi's MCP tools would be exposed in the default `codemode` (the model could not call them directly); and pi does not send tool calls into Paseo's permission flow, so the "decide-only" permission hook has no effect on pi. pi-family sessions therefore receive the role MCP URL through env (`SUPERAGENT_PI_MCP_URL` / `SUPERAGENT_PI_ROLE`; every session open carries the latest URL, following the port and secret rotation after a plugin reload), and the pi extension shipped with the plugin handles registration and constraints:

```bash
cp pi-extension/superagent.js ~/.pi/agent/extensions/
```

This is a manual copy: `paseo plugin update` updates only the plugin checkout and does not update `~/.pi/agent/extensions/superagent.js`, so copy it again whenever the extension changes.

The extension gates itself on env and stays fully dormant without `SUPERAGENT_PI_MCP_URL`, so it does not affect your own interactive pi. For Router/watchdog sessions it does three things: it registers the recall MCP with `exposure: "direct"` (the three tools are declared to the model directly); at `before_agent_start` it trims `selectedTools` in place down to only the recall tools (bash/edit and the like are removed from both the prompt and the executable tool set, and skills and the AGENTS.md context are cleared); and `tool_call` acts as a backstop that intercepts every call not on the allowlist (including nested codemode calls; the model receives the rejection reason) and enforces the same call budget as the server (over budget, calls are first rejected and all tools withdrawn to force the model to decide directly; only continuing to call after the rejection aborts the turn; see "Call budget" in [Design trade-offs and limitations](architecture-EN.md#design-trade-offs-and-limitations)). Worker and ordinary agent sessions register only their own tools and are not trimmed.

When the extension is not installed, everything degrades normally: the pi Router runs as "if the recall tools are unavailable, decide from the prompt alone", just without Chain of Recall and the hard constraint; the daemon log prompts you to install it at the first pi orchestration session. On the strength of the constraint: the extension runs inside the pi process and is a user-space constraint, one level weaker than codex's read-only sandbox, which is enough for the orchestration-layer Router. Router rules are still delivered through systemPrompt (paseo's pi provider appends them at `before_agent_start`), evaluations in the same thread reuse the native session, and it is rebuilt when the configuration changes.
