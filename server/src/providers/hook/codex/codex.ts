import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  BASH_COMMAND_DISPLAY_MAX_LENGTH,
  TASK_DESCRIPTION_DISPLAY_MAX_LENGTH,
} from '../../../constants.js';
import type { AgentEvent, HookProvider } from '../../../provider.js';
import {
  areHooksInstalled as installerAreHooksInstalled,
  installHooks as installerInstallHooks,
  uninstallHooks as installerUninstallHooks,
} from './codexHookInstaller.js';
import { codexTeamProvider } from './codexTeamProvider.js';

export interface CodexSessionMetadata {
  id?: string;
  cwd?: string;
  timestamp?: number;
}

const METADATA_MAX_INITIAL_LINES = 32;
const METADATA_MAX_INITIAL_BYTES = 1_048_576;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function getStringField(
  record: Record<string, unknown>,
  payload: Record<string, unknown> | null,
  field: string,
): string | undefined {
  const value = payload?.[field] ?? record[field];
  return typeof value === 'string' ? value : undefined;
}

export function getCodexSessionsRoot(): string {
  return path.join(os.homedir(), '.codex', 'sessions');
}

export function listCodexSessionFiles(root = getCodexSessionsRoot()): string[] {
  const files: string[] = [];
  const stack = [root];

  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

function readInitialLines(jsonlFile: string): string[] {
  const fd = fs.openSync(jsonlFile, 'r');
  try {
    const chunks: Buffer[] = [];
    const chunkSize = 65_536;
    let totalBytes = 0;
    let lineCount = 0;

    while (totalBytes < METADATA_MAX_INITIAL_BYTES && lineCount < METADATA_MAX_INITIAL_LINES) {
      const remaining = METADATA_MAX_INITIAL_BYTES - totalBytes;
      const buffer = Buffer.alloc(Math.min(chunkSize, remaining));
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, totalBytes);
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      totalBytes += bytesRead;
      for (let i = 0; i < bytesRead; i++) {
        if (buffer[i] === 10) lineCount++;
      }
      if (bytesRead < buffer.length) break;
    }

    return Buffer.concat(chunks, totalBytes)
      .toString('utf-8')
      .split('\n')
      .slice(0, METADATA_MAX_INITIAL_LINES);
  } finally {
    fs.closeSync(fd);
  }
}

export function readCodexSessionMetadata(jsonlFile: string): CodexSessionMetadata {
  try {
    const firstLines = readInitialLines(jsonlFile);
    const metadata: CodexSessionMetadata = {};
    for (const line of firstLines) {
      if (!line.trim()) continue;
      const record = JSON.parse(line) as Record<string, unknown>;
      const payload = asRecord(record.payload);

      if (record.type === 'session_meta') {
        metadata.id = getStringField(record, payload, 'id') ?? metadata.id;
        metadata.cwd = getStringField(record, payload, 'cwd') ?? metadata.cwd;
        const rawTimestamp = getStringField(record, payload, 'timestamp') ?? undefined;
        const timestamp = rawTimestamp ? Date.parse(rawTimestamp) : undefined;
        if (Number.isFinite(timestamp)) metadata.timestamp = timestamp;
      } else if (record.type === 'turn_context') {
        metadata.cwd = getStringField(record, payload, 'cwd') ?? metadata.cwd;
      }

      if (metadata.id && metadata.cwd && metadata.timestamp) return metadata;
    }
    return metadata;
  } catch {
    /* ignore malformed or unreadable sessions */
  }
  return {};
}

export function getCodexSessionIdFromFile(jsonlFile: string): string {
  return readCodexSessionMetadata(jsonlFile).id ?? path.basename(jsonlFile, '.jsonl');
}

export function isCodexSessionRoot(dir: string): boolean {
  return path.resolve(dir).toLowerCase() === path.resolve(getCodexSessionsRoot()).toLowerCase();
}

function parseInput(input?: unknown): Record<string, unknown> {
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input) as unknown;
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return { input };
    }
  }
  if (typeof input === 'object' && input !== null) {
    return input as Record<string, unknown>;
  }
  return {};
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) + '\u2026' : value;
}

export function normalizeCodexToolName(toolName: string): string {
  switch (toolName) {
    case 'shell_command':
      return 'Bash';
    case 'apply_patch':
      return 'Edit';
    case 'spawn_agent':
      return 'Agent';
    default:
      return toolName;
  }
}

export function formatToolStatus(toolName: string, input?: unknown): string {
  const inp = parseInput(input);
  const base = (p: unknown) => (typeof p === 'string' ? path.basename(p) : '');
  switch (toolName) {
    case 'Read':
      return `Reading ${base(inp.file_path ?? inp.path)}`;
    case 'Edit':
    case 'apply_patch':
      return 'Applying patch';
    case 'Write':
      return `Writing ${base(inp.file_path ?? inp.path)}`;
    case 'Bash':
    case 'shell_command': {
      const command = Array.isArray(inp.command)
        ? inp.command.join(' ')
        : typeof inp.command === 'string'
          ? inp.command
          : '';
      return command
        ? `Running: ${truncate(command, BASH_COMMAND_DISPLAY_MAX_LENGTH)}`
        : 'Running command';
    }
    case 'Glob':
      return 'Searching files';
    case 'Grep':
      return 'Searching code';
    case 'WebFetch':
      return 'Fetching web content';
    case 'WebSearch':
      return 'Searching the web';
    case 'update_plan':
      return 'Updating plan';
    case 'wait_agent':
      return 'Waiting for agents';
    case 'close_agent':
      return 'Closing agent';
    case 'spawn_agent':
    case 'Agent':
    case 'Task': {
      const desc =
        typeof inp.message === 'string'
          ? inp.message
          : typeof inp.prompt === 'string'
            ? inp.prompt
            : typeof inp.description === 'string'
              ? inp.description
              : typeof inp.agent_type === 'string'
                ? inp.agent_type
                : '';
      return desc
        ? `Subtask: ${truncate(desc, TASK_DESCRIPTION_DISPLAY_MAX_LENGTH)}`
        : 'Running subtask';
    }
    default:
      return `Using ${toolName}`;
  }
}

function getSessionId(raw: Record<string, unknown>): string | null {
  const sessionId = raw.session_id;
  return typeof sessionId === 'string' ? sessionId : null;
}

function normalizeHookEvent(
  raw: Record<string, unknown>,
): { sessionId: string; event: AgentEvent } | null {
  const eventName = raw.hook_event_name;
  const sessionId = getSessionId(raw);
  if (typeof eventName !== 'string' || !sessionId) return null;

  switch (eventName) {
    case 'PreToolUse': {
      const toolName = typeof raw.tool_name === 'string' ? raw.tool_name : '';
      const toolInput = parseInput(raw.tool_input);
      const toolId = typeof raw.tool_use_id === 'string' ? raw.tool_use_id : `hook-${Date.now()}`;
      return {
        sessionId,
        event: {
          kind: 'toolStart',
          toolId,
          toolName,
          input: toolInput,
        },
      };
    }
    case 'PostToolUse':
      return {
        sessionId,
        event: {
          kind: 'toolEnd',
          toolId: typeof raw.tool_use_id === 'string' ? raw.tool_use_id : 'current',
        },
      };
    case 'Stop':
      return { sessionId, event: { kind: 'turnEnd' } };
    case 'UserPromptSubmit':
      return { sessionId, event: { kind: 'userTurn' } };
    case 'PermissionRequest':
      return { sessionId, event: { kind: 'permissionRequest' } };
    case 'SessionStart':
      return {
        sessionId,
        event: {
          kind: 'sessionStart',
          source: typeof raw.source === 'string' ? raw.source : undefined,
        },
      };
    case 'SessionEnd':
      return {
        sessionId,
        event: {
          kind: 'sessionEnd',
          reason: typeof raw.reason === 'string' ? raw.reason : undefined,
        },
      };
    case 'SubagentStart': {
      const agentType =
        typeof raw.agent_type === 'string'
          ? raw.agent_type
          : typeof raw.new_agent_role === 'string'
            ? raw.new_agent_role
            : 'unknown';
      return {
        sessionId,
        event: {
          kind: 'subagentStart',
          parentToolId: 'current',
          toolId: `hook-sub-${agentType}-${Date.now()}`,
          toolName: agentType,
          input: raw,
        },
      };
    }
    case 'SubagentStop':
      return {
        sessionId,
        event: { kind: 'subagentEnd', parentToolId: 'current', toolId: 'current' },
      };
    case 'TeammateIdle':
    case 'TaskCompleted':
      return { sessionId, event: { kind: 'subagentTurnEnd', parentToolId: 'current' } };
    default:
      return null;
  }
}

function installHooks(_serverUrl: string, _authToken: string): Promise<void> {
  installerInstallHooks();
  return Promise.resolve();
}

function uninstallHooks(): Promise<void> {
  installerUninstallHooks();
  return Promise.resolve();
}

function areHooksInstalled(): Promise<boolean> {
  return Promise.resolve(installerAreHooksInstalled());
}

function getSessionDirs(_workspacePath: string): string[] {
  return [getCodexSessionsRoot()];
}

function buildLaunchCommand(
  _sessionId: string,
  _cwd: string,
  bypassPermissions?: boolean,
): { command: string; args: string[]; env?: Record<string, string> } {
  const args = ['--enable', 'codex_hooks'];
  if (bypassPermissions) {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  }
  return { command: 'codex', args };
}

export const codexProvider: HookProvider = {
  kind: 'hook',
  id: 'codex',
  displayName: 'Codex',

  normalizeHookEvent,

  installHooks,
  uninstallHooks,
  areHooksInstalled,

  formatToolStatus,
  permissionExemptTools: new Set(['Task', 'Agent', 'spawn_agent', 'wait_agent', 'close_agent']),
  subagentToolNames: new Set(['Task', 'Agent', 'spawn_agent']),

  getSessionDirs,
  sessionFilePattern: '*.jsonl',
  buildLaunchCommand,

  team: codexTeamProvider,
};
