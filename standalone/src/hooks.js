import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOOK_API_PREFIX = '/api/hooks';
export const MAX_HOOK_BODY_SIZE = 65_536;

const CODEX_HOOK_SCRIPT_NAME = 'codex-hook.js';
const CODEX_HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'Stop',
  'SubagentStart',
  'SubagentStop',
  'TeammateIdle',
  'TaskCompleted',
];

function getHomeDir(options = {}) {
  return options.homeDir ?? os.homedir();
}

function getCodexHooksPath(options = {}) {
  return path.join(getHomeDir(options), '.codex', 'hooks.json');
}

function getHookScriptPath(options = {}) {
  return path.join(getHomeDir(options), '.pixel-agents', 'hooks', CODEX_HOOK_SCRIPT_NAME);
}

function getServerJsonPath(options = {}) {
  return path.join(getHomeDir(options), '.pixel-agents', 'server.json');
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmpPath = `${filePath}.pixel-agents-tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2), { encoding: 'utf-8', mode });
  fs.renameSync(tmpPath, filePath);
}

function isOurHookEntry(entry) {
  return Array.isArray(entry?.hooks)
    ? entry.hooks.some((hook) => String(hook?.command ?? '').includes(CODEX_HOOK_SCRIPT_NAME))
    : false;
}

function makeHookEntry(options = {}) {
  return {
    matcher: '*',
    hooks: [
      {
        type: 'command',
        command: `node "${getHookScriptPath(options)}"`,
        timeout: 5,
        statusMessage: 'Updating Pixel Agents',
      },
    ],
  };
}

export function areCodexHooksInstalled(options = {}) {
  const config = readJson(getCodexHooksPath(options), {});
  if (!config.hooks) return false;
  return CODEX_HOOK_EVENTS.every((event) => {
    const entries = config.hooks[event];
    return Array.isArray(entries) && entries.some(isOurHookEntry);
  });
}

export function installCodexHooks(options = {}) {
  const hooksPath = getCodexHooksPath(options);
  const config = readJson(hooksPath, {});
  config.hooks ??= {};

  let changed = false;
  for (const event of CODEX_HOOK_EVENTS) {
    const entries = Array.isArray(config.hooks[event]) ? config.hooks[event] : [];
    const filtered = entries.filter((entry) => !isOurHookEntry(entry));
    filtered.push(makeHookEntry(options));
    if (JSON.stringify(filtered) !== JSON.stringify(entries)) {
      config.hooks[event] = filtered;
      changed = true;
    }
  }

  if (changed) {
    writeJsonAtomic(hooksPath, config);
  }
}

export function uninstallCodexHooks(options = {}) {
  const hooksPath = getCodexHooksPath(options);
  const config = readJson(hooksPath, {});
  if (!config.hooks) return;

  let changed = false;
  for (const event of Object.keys(config.hooks)) {
    const entries = config.hooks[event];
    if (!Array.isArray(entries)) continue;
    const filtered = entries.filter((entry) => !isOurHookEntry(entry));
    if (filtered.length !== entries.length) {
      changed = true;
      if (filtered.length === 0) {
        delete config.hooks[event];
      } else {
        config.hooks[event] = filtered;
      }
    }
  }

  if (config.hooks && Object.keys(config.hooks).length === 0) {
    delete config.hooks;
  }
  if (changed) {
    writeJsonAtomic(hooksPath, config);
  }
}

export function copyCodexHookScript(repoRoot, options = {}) {
  const src = path.join(repoRoot, 'dist', 'hooks', CODEX_HOOK_SCRIPT_NAME);
  const dst = getHookScriptPath(options);
  if (!fs.existsSync(src)) {
    throw new Error(`Hook script not found at ${src}. Run npm run build first.`);
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
  fs.copyFileSync(src, dst);
  try {
    fs.chmodSync(dst, 0o700);
  } catch {
    // chmod can fail on some Windows filesystems; the file is still usable.
  }
  return dst;
}

export function writeHookServerConfig(config, options = {}) {
  writeJsonAtomic(getServerJsonPath(options), config);
}

export function deleteHookServerConfig(options = {}) {
  const filePath = getServerJsonPath(options);
  const expectedPid = options.pid ?? process.pid;
  try {
    const existing = readJson(filePath, null);
    if (existing?.pid === expectedPid) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // Ignore stale/missing server files.
  }
}

export function createHookServerConfig(port, token = crypto.randomUUID()) {
  return {
    port,
    pid: process.pid,
    token,
    startedAt: Date.now(),
  };
}

export function isAuthorizedHookRequest(authHeader, token) {
  const expected = `Bearer ${token}`;
  const actualBuffer = Buffer.from(String(authHeader ?? ''));
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  );
}
