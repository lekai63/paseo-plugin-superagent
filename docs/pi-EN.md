# Pi integration for Workers and delegation

[← Back to README](../README.md) · [简体中文](pi.md)

Pi Workers and ordinary Pi sessions can receive Superagent tools through the bundled extension. The plugin passes the local MCP URL when the session opens, and the extension registers the tools directly.

```bash
cp pi-extension/superagent.js ~/.pi/agent/extensions/
```

This is a manual copy: `paseo plugin update` updates only the plugin checkout and does not update `~/.pi/agent/extensions/superagent.js`, so copy it again whenever the extension changes.

Without `SUPERAGENT_PI_MCP_URL`, the extension stays dormant. Workers can unsubscribe or hand back messages. Ordinary Pi sessions can dispatch tasks when delegation injection is enabled.


**Worker mode**: Paseo's pi provider offers no selectable modes (`modes: []`, and `setMode` throws), so when the provider is pi the settings page stops using the snapshot and reads the mode list of the local [pi-permission-modes](https://pi.dev/packages/pi-permission-modes) extension instead (the daemon reads `permission-mode/permission-mode.json` under `PI_CODING_AGENT_DIR` or `~/.pi/agent`, merged with the extension's stock default/plan/build/yolo; installation is detected from the `packages` list in `settings.json` or `npm/node_modules`). The selected mode is written into the `PI_PERMISSION_MODE` environment variable when the Worker is created, which the extension reads at session start; Paseo keeps it across session resumes through `launchEnv`. Without the extension the settings page offers only "Paseo default" and Workers start on pi's own `defaultMode` (no environment variable is set).
