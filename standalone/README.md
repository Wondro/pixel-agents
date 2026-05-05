# Pixel Agents Standalone

Run Pixel Agents outside VS Code in a normal browser while keeping Codex as the agent runtime.

The standalone server serves the built React webview, injects a small WebSocket adapter for `acquireVsCodeApi()`, decodes the bundled office assets, and watches Codex transcript files under `~/.codex/sessions`.

Codex hooks are enabled by default for faster updates. On startup the server copies the built hook relay from `dist/hooks/codex-hook.js`, writes `~/.pixel-agents/server.json`, and installs Pixel Agents entries in `~/.codex/hooks.json`. The browser Settings modal can toggle hooks on or off.

## Prerequisites

- Node.js 20 or later
- Root project dependencies installed
- A built Pixel Agents webview at `dist/webview`
- Codex sessions created through Codex chat/sidebar or terminal

## Start

From the repository root:

```bash
npm install
cd webview-ui && npm install && cd ..
npm run build
cd standalone
npm install
npm start
```

Open `http://127.0.0.1:3333`.

## Configuration

Environment variables:

- `PORT` or `PIXEL_AGENTS_PORT`: HTTP/WebSocket port, default `3333`
- `HOST` or `PIXEL_AGENTS_HOST`: bind host, default `127.0.0.1`
- `CODEX_SESSIONS_DIR`: Codex session root, default `~/.codex/sessions`
- `PIXEL_AGENTS_REPO_ROOT`: repository root when running the server from another location
- `PIXEL_AGENTS_WEBVIEW_DIST`: built webview directory, default `<repo>/dist/webview`
- `PIXEL_AGENTS_STANDALONE_ACTIVE_MAX_AGE_MINUTES`: visible session freshness window, default `240`
- `PIXEL_AGENTS_STANDALONE_OWNERSHIP_MAX_AGE_HOURS`: window used to detect spawned child ownership, default `168`
- `PIXEL_AGENTS_STANDALONE_MAX_FILES`: newest JSONL files to inspect, default `300`

Layout and standalone UI preferences are stored in `~/.pixel-agents/`.

## Notes

- The server does not launch, focus, or kill Codex. Start and control Codex in chat/sidebar or a terminal.
- Hooks use the same local bearer-token relay as the VS Code extension. If the VS Code extension and standalone server are both running, whichever process most recently wrote `~/.pixel-agents/server.json` receives hook events.
- `spawn_agent` children are represented under their parent session when Codex emits a valid `collab_agent_spawn_end.new_thread_id`.
- Child JSONL files already owned by a parent spawn are skipped as top-level agents, matching the Codex extension behavior.
