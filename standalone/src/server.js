import express from 'express';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { loadStandaloneAssets } from './assets.js';
import { CodexSessionScanner } from './codex-scanner.js';
import {
  copyCodexHookScript,
  createHookServerConfig,
  deleteHookServerConfig,
  HOOK_API_PREFIX,
  installCodexHooks,
  isAuthorizedHookRequest,
  MAX_HOOK_BODY_SIZE,
  uninstallCodexHooks,
  writeHookServerConfig,
} from './hooks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = process.env.PIXEL_AGENTS_REPO_ROOT
  ? path.resolve(process.env.PIXEL_AGENTS_REPO_ROOT)
  : path.resolve(__dirname, '..', '..');
const webviewDist = process.env.PIXEL_AGENTS_WEBVIEW_DIST
  ? path.resolve(process.env.PIXEL_AGENTS_WEBVIEW_DIST)
  : path.join(repoRoot, 'dist', 'webview');
const publicDir = path.resolve(__dirname, '..', 'public');
const appDir = path.join(os.homedir(), '.pixel-agents');
const layoutFile = path.join(appDir, 'layout.json');
const configFile = path.join(appDir, 'standalone-config.json');
const port = Number(process.env.PORT ?? process.env.PIXEL_AGENTS_PORT ?? 3333);
const host = process.env.HOST ?? process.env.PIXEL_AGENTS_HOST ?? '127.0.0.1';

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2), 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

function loadConfig() {
  return {
    agentSeats: {},
    soundEnabled: true,
    alwaysShowLabels: false,
    hooksEnabled: true,
    hooksInfoShown: true,
    lastSeenVersion: '',
    ...readJson(configFile, {}),
  };
}

function loadRootVersion() {
  return readJson(path.join(repoRoot, 'package.json'), {})?.version ?? '0.0.0';
}

function renderIndex() {
  const indexPath = path.join(webviewDist, 'index.html');
  let html = fs.readFileSync(indexPath, 'utf-8');
  const adapterScript = '<script src="/ws-adapter.js"></script>';
  if (!html.includes(adapterScript)) {
    html = html.replace(/<head([^>]*)>/i, `<head$1>\n    ${adapterScript}`);
  }
  return html;
}

function readLayoutFromFile() {
  return readJson(layoutFile, null);
}

function writeLayoutToFile(layout) {
  try {
    writeJsonAtomic(layoutFile, layout);
  } catch (error) {
    console.error('[standalone] failed to write layout', error);
  }
}

function loadSavedLayout(defaultLayout) {
  const saved = readLayoutFromFile();
  if (saved) {
    const savedRevision = saved.layoutRevision ?? 0;
    const defaultRevision = defaultLayout?.layoutRevision ?? 0;
    if (defaultLayout && defaultRevision > savedRevision) {
      writeLayoutToFile(defaultLayout);
      return { layout: defaultLayout, wasReset: true };
    }
    return { layout: saved, wasReset: false };
  }
  if (defaultLayout) {
    writeLayoutToFile(defaultLayout);
    return { layout: defaultLayout, wasReset: false };
  }
  return { layout: null, wasReset: false };
}

function send(ws, message) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(message));
  }
}

function broadcast(wss, message) {
  const payload = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(payload);
    }
  }
}

if (!fs.existsSync(path.join(webviewDist, 'index.html'))) {
  console.warn(`[standalone] webview build not found at ${webviewDist}`);
  console.warn('[standalone] run npm run build from the repository root before starting.');
}

const assets = loadStandaloneAssets(webviewDist);
const config = loadConfig();
const extensionVersion = loadRootVersion();

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
let hookConfig = null;
const scanner = new CodexSessionScanner({
  onMessage: (message) => broadcast(wss, message),
});

function persistConfig() {
  try {
    writeJsonAtomic(configFile, config);
  } catch (error) {
    console.error('[standalone] failed to write config', error);
  }
}

function setHooksEnabled(enabled, actualPort = port) {
  if (!enabled) {
    uninstallCodexHooks();
    deleteHookServerConfig();
    hookConfig = null;
    config.hooksEnabled = false;
    persistConfig();
    return false;
  }

  try {
    copyCodexHookScript(repoRoot);
    hookConfig = createHookServerConfig(actualPort, hookConfig?.token);
    writeHookServerConfig(hookConfig);
    installCodexHooks();
    config.hooksEnabled = true;
    persistConfig();
    console.log('[standalone] Codex hooks installed for faster updates');
    return true;
  } catch (error) {
    config.hooksEnabled = false;
    persistConfig();
    console.warn(`[standalone] Codex hooks disabled: ${error?.message ?? error}`);
    return false;
  }
}

function sendSettings(ws) {
  send(ws, {
    type: 'settingsLoaded',
    soundEnabled: config.soundEnabled,
    watchAllSessions: true,
    alwaysShowLabels: config.alwaysShowLabels,
    hooksEnabled: config.hooksEnabled === true,
    hooksInfoShown: config.hooksInfoShown,
    externalAssetDirectories: [],
    lastSeenVersion: config.lastSeenVersion,
    extensionVersion,
  });
}

function sendAssets(ws) {
  if (assets.characterSprites) {
    send(ws, { type: 'characterSpritesLoaded', characters: assets.characterSprites.characters });
  }
  if (assets.floorTiles) {
    send(ws, { type: 'floorTilesLoaded', sprites: assets.floorTiles.sprites });
  }
  if (assets.wallTiles) {
    send(ws, { type: 'wallTilesLoaded', sets: assets.wallTiles.sets });
  }
  if (assets.furnitureAssets) {
    send(ws, {
      type: 'furnitureAssetsLoaded',
      catalog: assets.furnitureAssets.catalog,
      sprites: assets.furnitureAssets.sprites,
    });
  }
}

function sendInitialData(ws) {
  send(ws, scanner.getExistingAgentsPayload(config.agentSeats));
  sendSettings(ws);
  send(ws, { type: 'workspaceFolders', folders: scanner.getWorkspaceFolders() });
  sendAssets(ws);

  const layoutResult = loadSavedLayout(assets.defaultLayout);
  send(ws, {
    type: 'layoutLoaded',
    layout: layoutResult.layout,
    wasReset: layoutResult.wasReset,
  });

  scanner.sendSnapshots(ws);
}

function sendIndex(_req, res) {
  try {
    res.type('html').send(renderIndex());
  } catch {
    res
      .status(503)
      .type('text')
      .send('Pixel Agents webview is not built. Run npm run build first.');
  }
}

app.get('/ws-adapter.js', (_req, res) => {
  res.sendFile(path.join(publicDir, 'ws-adapter.js'));
});
app.post(`${HOOK_API_PREFIX}/:providerId`, (req, res) => {
  if (req.params.providerId !== 'codex') {
    res.status(400).send('invalid provider id');
    return;
  }
  if (!hookConfig || !isAuthorizedHookRequest(req.headers.authorization, hookConfig.token)) {
    res.status(401).send('unauthorized');
    return;
  }

  let body = '';
  let bodySize = 0;
  let responded = false;
  req.on('data', (chunk) => {
    bodySize += chunk.length;
    if (bodySize > MAX_HOOK_BODY_SIZE && !responded) {
      responded = true;
      res.status(413).send('payload too large');
      req.destroy();
      return;
    }
    if (!responded) {
      body += chunk.toString();
    }
  });
  req.on('end', () => {
    if (responded) return;
    try {
      const event = JSON.parse(body);
      if (event && typeof event === 'object') {
        scanner.handleHookEvent(event);
      }
      res.status(200).send('ok');
    } catch {
      res.status(400).send('invalid json');
    }
  });
});
app.get('/', sendIndex);
app.use(express.static(webviewDist, { index: false }));
app.get('*', sendIndex);

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (message.type) {
      case 'webviewReady':
        sendInitialData(ws);
        break;
      case 'saveLayout':
        if (message.layout && typeof message.layout === 'object') {
          writeLayoutToFile(message.layout);
        }
        break;
      case 'saveAgentSeats':
        config.agentSeats = message.seats && typeof message.seats === 'object' ? message.seats : {};
        persistConfig();
        break;
      case 'setSoundEnabled':
        config.soundEnabled = !!message.enabled;
        persistConfig();
        break;
      case 'setAlwaysShowLabels':
        config.alwaysShowLabels = !!message.enabled;
        persistConfig();
        break;
      case 'setHooksInfoShown':
        config.hooksInfoShown = true;
        persistConfig();
        break;
      case 'setLastSeenVersion':
        config.lastSeenVersion = typeof message.version === 'string' ? message.version : '';
        persistConfig();
        break;
      case 'setWatchAllSessions':
        sendSettings(ws);
        break;
      case 'setHooksEnabled':
        setHooksEnabled(!!message.enabled, server.address()?.port ?? port);
        sendSettings(ws);
        break;
      case 'requestDiagnostics':
        scanner.sendDiagnostics(ws);
        break;
      case 'closeAgent':
        if (typeof message.id === 'number') {
          scanner.dismissAgent(message.id);
        }
        break;
      case 'focusAgent':
      case 'openCodex':
      case 'openSessionsFolder':
      case 'addExternalAssetDirectory':
      case 'removeExternalAssetDirectory':
      case 'exportLayout':
      case 'importLayout':
        console.log(`[standalone] ${message.type} is handled by the VS Code extension only`);
        break;
      default:
        break;
    }
  });
});

scanner.start();

process.once('exit', () => {
  if (hookConfig) {
    deleteHookServerConfig();
  }
});

process.once('SIGINT', () => {
  if (hookConfig) {
    deleteHookServerConfig();
  }
  process.exit(130);
});

process.once('SIGTERM', () => {
  if (hookConfig) {
    deleteHookServerConfig();
  }
  process.exit(143);
});

server.listen(port, host, () => {
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  if (config.hooksEnabled !== false) {
    setHooksEnabled(true, actualPort);
  }
  const displayHost = host === '0.0.0.0' ? 'localhost' : host;
  console.log(`[standalone] Pixel Agents running at http://${displayHost}:${actualPort}`);
  console.log(`[standalone] watching Codex sessions in ${scanner.sessionsRoot}`);
});
