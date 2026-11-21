# Pi integration

[← Back to README](../README.md) · [简体中文](pi.md)

When the pi family (`pi`, `pi/<model>`) runs Workers or receives the delegation injection, it uses the same standard MCP injection as every other provider: at `session_open` the plugin writes its local MCP server (a `127.0.0.1` random port with a random secret path; the URL query carries the role) into the session's `mcpServers`. No extension needs to be installed.

- **Workers** get `superagent_unsubscribe` / `superagent_handback`.
- **Ordinary pi sessions** get `superagent_dispatch` when `pi` is added to "Providers to inject into" in settings (the default list does not include pi).

This follows pi's own MCP design: instead of an extension channel forcing `exposure: "direct"` tool declarations, tools land on pi's default **codemode** exposure — reachable on demand from codemode scripts (lazy loading, no tool-declaration slots spent). To keep them discoverable, the MCP server sends role-specific `instructions` (pi lists their first line in the `mcp_servers` section of the system prompt), and the Worker's first prompt explains how to call them.

MCP injection requires pi ≥ 1.5 (the daemon uses the built-in injection channel when it detects pi's own `/mcp` command). On an older pi host a session that carries the tools fails to start, the same as with any other provider without MCP support — upgrade pi or use another Worker provider there. After a plugin reload the port and secret rotate, and the URL refreshes on the next `session_open`.

**Worker mode**: Paseo's pi provider offers no selectable modes (`modes: []`, and `setMode` throws), so when the provider is pi the settings page stops using the snapshot and reads the mode list of the local [pi-permission-modes](https://pi.dev/packages/pi-permission-modes) extension instead (the daemon reads `permission-mode/permission-mode.json` under `PI_CODING_AGENT_DIR` or `~/.pi/agent`, merged with the extension's stock default/plan/build/yolo; installation is detected from the `packages` list in `settings.json` or `npm/node_modules`). The selected mode is written into the `PI_PERMISSION_MODE` environment variable when the Worker is created, which the extension reads at session start; Paseo keeps it across session resumes through `launchEnv`. Without the extension the settings page offers only "Paseo default" and Workers start on pi's own `defaultMode` (no environment variable is set).
