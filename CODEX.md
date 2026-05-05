# Pixel Agents Codex Architecture

VS Code extension with an embedded React webview: a pixel art office where Codex sessions are animated characters.

## Repo Map

```text
src/
  extension.ts                    VS Code activation and panel registration
  PixelAgentsViewProvider.ts      Extension host controller, webview protocol, server lifecycle
  agentManager.ts                 Terminal launch, persisted agents, restore, layout send
  fileWatcher.ts                  Codex JSONL polling, external sessions, stale cleanup
  transcriptParser.ts             Codex JSONL records -> webview activity/status messages
  timerManager.ts                 Waiting/permission timers
  assetLoader.ts                  Bundled and external sprite/furniture loading

server/src/
  server.ts                       Loopback hook server, bearer token auth, server.json
  hookEventHandler.ts             Normalized hook events -> AgentState/webview messages
  provider.ts                     Provider contract
  providers/hook/codex/
    codex.ts                      Codex provider, launch flags, session helpers, hook normalization
    codexCliResolver.ts           Finds the Codex CLI bundled with the OpenAI VS Code extension
    codexHookInstaller.ts         Install/uninstall entries in ~/.codex/hooks.json
    codexTeamProvider.ts          Optional team/subagent metadata adapter
    hooks/codex-hook.ts           Hook relay script bundled to dist/hooks/codex-hook.js

webview-ui/src/
  App.tsx                         Panel shell and settings
  hooks/useExtensionMessages.ts   Extension message reducer
  hooks/useEditorActions.ts       Layout editor actions
  office/                         Canvas renderer, office state, sprites, layout/editor logic
  components/                     Toolbar, settings, changelog, debug UI

standalone/
  src/server.js                   Express/WebSocket browser host for the built webview
  src/codex-scanner.js            Recursive Codex JSONL scanner for ~/.codex/sessions
  src/codex-session-parser.js     Standalone Codex transcript parser and replay messages
  src/assets.js                   PNG/furniture/layout decoding for browser startup messages
  public/ws-adapter.js            acquireVsCodeApi shim backed by WebSocket
```

## Core Vocabulary

- Terminal: VS Code terminal running Codex from the OpenAI VS Code extension bundle or a global `codex` CLI.
- Session: Codex JSONL file under `~/.codex/sessions/<yyyy>/<mm>/<dd>/`.
- Agent: webview character bound to a terminal or external session.
- Tool activity: shell commands, patch application, plan updates, spawned agents, waits, and other Codex events shown as character animations/status text.

## Runtime Flow

1. Users start Codex chat/sidebar or terminal sessions outside the Pixel Agents toolbar.
2. The global Codex session monitor watches `~/.codex/sessions` and adopts active chat/sidebar sessions as external agents.
3. Legacy/internal `openCodex` messages can still open a Codex chat agent via `chatgpt.newCodexPanel` or a terminal fallback, but the default webview toolbar no longer exposes that launch button.
4. Terminal launch resolves a Codex CLI, preferring the OpenAI VS Code extension bundle, and launches it with `--enable codex_hooks`, plus `--dangerously-bypass-approvals-and-sandbox` when requested by the command payload.
5. Terminal sessions are matched to new JSONL files whose `session_meta.cwd` matches the terminal cwd.
6. Codex hooks, when installed, post events through `~/.pixel-agents/hooks/codex-hook.js` to the local hook server at `POST /api/hooks/codex`.
7. `transcriptParser.ts` and `hookEventHandler.ts` update the webview with tool start/done, active/waiting, permission, token usage, and subagent messages.

## Standalone Browser Server

`standalone/src/server.js` runs Pixel Agents outside VS Code. It serves `dist/webview`, injects `standalone/public/ws-adapter.js`, sends the same asset/layout/settings messages as the extension host, and watches Codex sessions directly from `~/.codex/sessions`.

The standalone server keeps the Codex runtime unchanged: it does not launch, focus, or terminate Codex. Users continue working through Codex chat/sidebar or any terminal, and the standalone scanner adopts recent JSONL files within a 240-minute default window. It parses Codex collaboration events so `spawn_agent` children stay under the parent when `collab_agent_spawn_end.new_thread_id` is present, and child JSONL files ever owned by a parent in the scanner ownership window are skipped as duplicate top-level agents.

Hooks are supported in standalone mode. On startup, when `hooksEnabled` is true, the server copies `dist/hooks/codex-hook.js` into `~/.pixel-agents/hooks/`, writes `~/.pixel-agents/server.json` with its loopback port and bearer token, and installs Pixel Agents entries in `~/.codex/hooks.json`. Hook posts to `POST /api/hooks/codex` update the standalone scanner immediately for tool start/done, permission, and waiting transitions. Because the VS Code extension and standalone server share `server.json`, the most recently started hook receiver owns live hook delivery.

Run it with:

```bash
npm run build
cd standalone
npm install
npm start
```

Optional environment variables include `PORT`, `HOST`, `CODEX_SESSIONS_DIR`, `PIXEL_AGENTS_WEBVIEW_DIST`, `PIXEL_AGENTS_STANDALONE_ACTIVE_MAX_AGE_MINUTES`, and `PIXEL_AGENTS_STANDALONE_MAX_FILES`.

## Webview Message Protocol

Important commands from webview to extension:

- `openCodex`
- `focusAgent`
- `closeAgent`
- `saveLayout`
- `saveAgentSeats`
- `exportLayout`
- `importLayout`
- `setSoundEnabled`
- `setHooksEnabled`
- `setWatchAllSessions`
- `addExternalAssetDirectory`
- `removeExternalAssetDirectory`
- `requestDiagnostics`
- `openSessionsFolder`

Important messages from extension to webview:

- `agentCreated`
- `agentClosed`
- `agentSelected`
- `agentToolStart`
- `agentToolDone`
- `agentToolsClear`
- `agentStatus`
- `agentToolPermission`
- `agentToolPermissionClear`
- `subagentToolStart`
- `subagentToolDone`
- `subagentClear`
- `existingAgents`
- `layoutLoaded`
- `settingsLoaded`
- `agentDiagnostics`
- `agentTokenUsage`

## Session Detection

Hooks mode:

- Hook entries are installed in `~/.codex/hooks.json`.
- Installed hook events include session start/end, user prompt submit, tool start/end, permission, stop, subagent start/stop, teammate idle, and task completed events.
- Hook script is copied to `~/.pixel-agents/hooks/codex-hook.js`.
- Server discovery happens through `~/.pixel-agents/server.json`.
- The loopback server requires `Authorization: Bearer <token>` and enforces a 64 KB hook body cap.

Polling fallback:

- `fileWatcher.ts` recursively scans `~/.codex/sessions`.
- Existing files are seeded on startup.
- Newly modified files can be adopted as external sessions.
- The "Monitor Codex Chat" setting scans all recent Codex sessions, not only the active workspace. It is on by default so Codex chat/sidebar sessions are discovered without launching terminals.

## Codex JSONL Records

The parser currently handles:

- `session_meta`
- `turn_context`
- `event_msg`
- `response_item`
- payloads such as `task_started`, `message`, `user_message`, `function_call`, `function_call_output`, `custom_tool_call`, `custom_tool_call_output`, `exec_command_end`, `patch_apply_end`, `collab_agent_spawn_end`, `collab_waiting_end`, `collab_close_end`, `token_count`, and `task_complete`.

Tool display mapping:

- `shell_command` -> command-running animation/status
- `apply_patch` -> editing/applying patch status
- `spawn_agent` -> subtask/subagent status
- `wait_agent` -> waiting for agents status
- `close_agent` -> closing agent status

Spawned-agent lifecycle:

- `spawn_agent` creates a provisional child character for the in-flight tool call.
- `collab_agent_spawn_end` promotes the child to a persistent spawned agent only when `new_thread_id` is non-empty, then records the spawned Codex thread/nickname/role and keeps the child visible after the spawn call itself finishes.
- Spawn calls without a valid `collab_agent_spawn_end` child thread id are cleared when their function output or turn completion arrives.
- `close_agent` / `collab_close_end` removes the matching child character by thread id, nickname, or role.
- Parent turn completion preserves spawned children until an explicit close event arrives.
- Monitor Codex Chat skips child JSONL sessions already owned by a parent `spawn_agent`, preventing duplicate top-level agents for the same spawned thread.
- Restored parent sessions rebuild open spawned-child ownership from transcript history before Monitor Codex Chat can adopt child JSONL files.

## Build And Tests

```bash
npm run check-types
npm run lint
npm run build
npm run test:server
npm run test:webview
npm run test:standalone
npm run e2e
```

Build notes:

- `node esbuild.js` bundles `src/extension.ts`.
- `buildHooks()` bundles `server/src/providers/hook/codex/hooks/codex-hook.ts` to `dist/hooks/codex-hook.js`.
- Webview build runs in `webview-ui/` through Vite.

## Security Notes

- Do not read, print, log, or commit `~/.codex/auth.json`.
- Treat Codex session JSONL as sensitive local activity data.
- Keep hook traffic loopback-only and bearer-authenticated.
- Avoid logging hook bodies, transcript contents, command output, or prompt text unless explicitly needed for diagnostics.
- Webview messages are privileged extension actions and should stay tightly validated as the project grows.

## Known Risk Areas

- Codex session JSONL shape can change between CLI versions.
- Hook availability depends on the user's Codex configuration and installed CLI version.
- Terminal-to-session matching is based on new session files and `session_meta.cwd`.
- Subagent visualization maps Codex collaboration events into the existing Pixel Agents subagent model; exact visual parity depends on the Codex event stream.
