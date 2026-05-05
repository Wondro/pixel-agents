import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { HOOK_SCRIPTS_DIR } from '../../../constants.js';
import { CODEX_HOOK_EVENTS, CODEX_HOOK_SCRIPT_NAME } from './constants.js';

const HOOK_SCRIPT_MARKER = CODEX_HOOK_SCRIPT_NAME;

interface CodexHookEntry {
  matcher?: string;
  hooks: Array<{
    type: string;
    command: string;
    timeout?: number;
    statusMessage?: string;
  }>;
}

interface CodexHooksConfig {
  hooks?: Record<string, CodexHookEntry[]>;
  [key: string]: unknown;
}

function getCodexHooksPath(): string {
  return path.join(os.homedir(), '.codex', 'hooks.json');
}

function getHookScriptPath(): string {
  return path.join(os.homedir(), HOOK_SCRIPTS_DIR, CODEX_HOOK_SCRIPT_NAME);
}

function readCodexHooksConfig(): CodexHooksConfig {
  const hooksPath = getCodexHooksPath();
  try {
    if (fs.existsSync(hooksPath)) {
      return JSON.parse(fs.readFileSync(hooksPath, 'utf-8')) as CodexHooksConfig;
    }
  } catch (e) {
    console.error(`[Pixel Agents] Failed to read Codex hooks config: ${e}`);
  }
  return {};
}

function writeCodexHooksConfig(config: CodexHooksConfig): void {
  const hooksPath = getCodexHooksPath();
  const dir = path.dirname(hooksPath);
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const tmpPath = hooksPath + '.pixel-agents-tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmpPath, hooksPath);
  } catch (e) {
    console.error(`[Pixel Agents] Failed to write Codex hooks config: ${e}`);
  }
}

function isOurHookEntry(entry: CodexHookEntry): boolean {
  return entry.hooks.some((h) => h.command.includes(HOOK_SCRIPT_MARKER));
}

function makeHookCommand(): string {
  return `node "${getHookScriptPath()}"`;
}

function makeHookEntry(): CodexHookEntry {
  return {
    matcher: '*',
    hooks: [
      {
        type: 'command',
        command: makeHookCommand(),
        timeout: 5,
        statusMessage: 'Updating Pixel Agents',
      },
    ],
  };
}

export function areHooksInstalled(): boolean {
  const config = readCodexHooksConfig();
  if (!config.hooks) return false;
  return CODEX_HOOK_EVENTS.every((event) => {
    const entries = config.hooks?.[event];
    return Array.isArray(entries) && entries.some(isOurHookEntry);
  });
}

export function installHooks(): void {
  const config = readCodexHooksConfig();
  if (!config.hooks) {
    config.hooks = {};
  }

  let changed = false;
  for (const event of CODEX_HOOK_EVENTS) {
    if (!Array.isArray(config.hooks[event])) {
      config.hooks[event] = [];
    }
    const entries = config.hooks[event];
    const filtered = entries.filter((entry) => !isOurHookEntry(entry));
    filtered.push(makeHookEntry());
    if (JSON.stringify(filtered) !== JSON.stringify(entries)) {
      config.hooks[event] = filtered;
      changed = true;
    }
  }

  if (changed) {
    writeCodexHooksConfig(config);
    console.log('[Pixel Agents] Hooks installed in ~/.codex/hooks.json');
  }
}

export function uninstallHooks(): void {
  const config = readCodexHooksConfig();
  if (!config.hooks) return;

  let changed = false;
  for (const event of Object.keys(config.hooks)) {
    const entries = config.hooks[event];
    if (!Array.isArray(entries)) continue;
    const filtered = entries.filter((entry) => !isOurHookEntry(entry));
    if (filtered.length !== entries.length) {
      config.hooks[event] = filtered;
      changed = true;
    }
    if (config.hooks[event].length === 0) {
      delete config.hooks[event];
    }
  }
  if (Object.keys(config.hooks).length === 0) {
    delete config.hooks;
  }

  if (changed) {
    writeCodexHooksConfig(config);
    console.log('[Pixel Agents] Hooks removed from ~/.codex/hooks.json');
  }
}

export function copyHookScript(extensionPath: string): void {
  const src = path.join(extensionPath, 'dist', 'hooks', CODEX_HOOK_SCRIPT_NAME);
  const dst = getHookScriptPath();
  const dstDir = path.dirname(dst);

  try {
    if (!fs.existsSync(dstDir)) {
      fs.mkdirSync(dstDir, { recursive: true, mode: 0o700 });
    }
    if (!fs.existsSync(src)) {
      console.warn(`[Pixel Agents] Hook script not found at ${src}`);
      return;
    }
    fs.copyFileSync(src, dst);
    fs.chmodSync(dst, 0o700);
    console.log(`[Pixel Agents] Hook script installed at ${dst}`);
  } catch (e) {
    console.error(`[Pixel Agents] Failed to copy hook script: ${e}`);
  }
}
