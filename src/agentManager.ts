import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { JSONL_POLL_INTERVAL_MS } from '../server/src/constants.js';
import {
  codexProvider,
  getCodexSessionIdFromFile,
  getCodexSessionsRoot,
  isCodexSessionRoot,
  listCodexSessionFiles,
  readCodexSessionMetadata,
} from '../server/src/providers/hook/codex/codex.js';
import { findBundledCodexCli } from '../server/src/providers/hook/codex/codexCliResolver.js';
import {
  TERMINAL_NAME_PREFIX,
  WORKSPACE_KEY_AGENT_SEATS,
  WORKSPACE_KEY_AGENTS,
} from './constants.js';
import { ensureProjectScan, reassignAgentToFile, startFileWatching } from './fileWatcher.js';
import { migrateAndLoadLayout } from './layoutPersistence.js';
import { restoreSpawnedAgentsFromCodexTranscript } from './spawnedAgentTracking.js';
import { cancelPermissionTimer, cancelWaitingTimer } from './timerManager.js';
import type { AgentState, PersistedAgent } from './types.js';

export function getProjectDirPath(cwd?: string): string {
  const workspacePath = cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
  const sessionsRoot = getCodexSessionsRoot();
  console.log(`[Pixel Agents] Terminal: Codex sessions root for ${workspacePath}: ${sessionsRoot}`);

  return sessionsRoot;
}

function listSessionFiles(projectDir: string): string[] {
  if (isCodexSessionRoot(projectDir)) {
    return listCodexSessionFiles(projectDir);
  }
  try {
    return fs
      .readdirSync(projectDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(projectDir, f));
  } catch {
    return [];
  }
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

function shellJoin(command: string, args: string[]): string {
  return [command, ...args]
    .map((part) => (/^[a-zA-Z0-9_./:=+-]+$/.test(part) ? part : JSON.stringify(part)))
    .join(' ');
}

function isCodexVsCodeExtension(extension: vscode.Extension<unknown>): boolean {
  const id = extension.id.toLowerCase();
  return id.startsWith('openai.chatgpt') || id.startsWith('openai.codex');
}

function getCodexVsCodeExtensionPaths(): string[] {
  return vscode.extensions.all
    .filter(isCodexVsCodeExtension)
    .map((extension) => extension.extensionPath);
}

function resolveCodexLaunchCommand(command: string): string {
  const normalizedCommand = command.toLowerCase();
  if (normalizedCommand !== 'codex' && normalizedCommand !== 'codex.exe') return command;

  return findBundledCodexCli(getCodexVsCodeExtensionPaths()) ?? command;
}

function findNewCodexSessionFile(
  projectDir: string,
  cwd: string,
  createdAt: number,
  agents: Map<number, AgentState>,
): string | undefined {
  const trackedFiles = new Set([...agents.values()].map((a) => path.resolve(a.jsonlFile)));
  const candidates = listSessionFiles(projectDir)
    .map((file) => {
      try {
        const stat = fs.statSync(file);
        const meta = readCodexSessionMetadata(file);
        return { file, mtime: stat.mtimeMs, meta };
      } catch {
        return null;
      }
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => {
      if (!candidate) return false;
      if (trackedFiles.has(path.resolve(candidate.file))) return false;
      const startedAt = candidate.meta.timestamp ?? candidate.mtime;
      if (startedAt < createdAt - 2000 && candidate.mtime < createdAt - 2000) return false;
      if (candidate.meta.cwd && !samePath(candidate.meta.cwd, cwd)) return false;
      return true;
    })
    .sort((a, b) => (b.meta.timestamp ?? b.mtime) - (a.meta.timestamp ?? a.mtime));

  return candidates[0]?.file;
}

export async function launchNewTerminal(
  nextAgentIdRef: { current: number },
  nextTerminalIndexRef: { current: number },
  agents: Map<number, AgentState>,
  activeAgentIdRef: { current: number | null },
  knownJsonlFiles: Set<string>,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  jsonlPollTimers: Map<number, ReturnType<typeof setInterval>>,
  projectScanTimerRef: { current: ReturnType<typeof setInterval> | null },
  webview: vscode.Webview | undefined,
  persistAgents: () => void,
  folderPath?: string,
  bypassPermissions?: boolean,
): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  // Use home directory as fallback cwd when no workspace is open.
  const cwd = folderPath || folders?.[0]?.uri.fsPath || os.homedir();
  const isMultiRoot = !!(folders && folders.length > 1);
  const idx = nextTerminalIndexRef.current++;
  const sessionId = crypto.randomUUID();
  const launch = codexProvider.buildLaunchCommand?.(sessionId, cwd, bypassPermissions) ?? {
    command: 'codex',
    args: [],
  };
  const launchCommand = resolveCodexLaunchCommand(launch.command);
  const shouldLaunchDirectly = path.isAbsolute(launchCommand);
  const terminal = vscode.window.createTerminal({
    name: `${TERMINAL_NAME_PREFIX} #${idx}`,
    cwd,
    ...(shouldLaunchDirectly
      ? {
          shellPath: launchCommand,
          shellArgs: launch.args,
        }
      : {}),
  });
  terminal.show();

  if (shouldLaunchDirectly) {
    console.log(`[Pixel Agents] Terminal: using Codex CLI at ${launchCommand}`);
  } else {
    terminal.sendText(shellJoin(launchCommand, launch.args));
  }

  const projectDir = getProjectDirPath(cwd);

  // Pre-register expected JSONL file so project scan won't treat it as a /clear file
  const expectedFile = path.join(projectDir, `${sessionId}.jsonl`);
  knownJsonlFiles.add(expectedFile);

  // Create agent immediately (before JSONL file exists)
  const id = nextAgentIdRef.current++;
  const folderName = isMultiRoot && cwd ? path.basename(cwd) : undefined;
  const agent: AgentState = {
    id,
    sessionId,
    terminalRef: terminal,
    isExternal: false,
    projectDir,
    jsonlFile: expectedFile,
    fileOffset: 0,
    lineBuffer: '',
    activeToolIds: new Set(),
    activeToolStatuses: new Map(),
    activeToolNames: new Map(),
    activeSubagentToolIds: new Map(),
    activeSubagentToolNames: new Map(),
    backgroundAgentToolIds: new Set(),
    spawnedAgentToolIds: new Map(),
    pendingCloseAgentTargets: new Map(),
    isWaiting: false,
    permissionSent: false,
    hadToolsInTurn: false,
    lastDataAt: 0,
    linesProcessed: 0,
    seenUnknownRecordTypes: new Set(),
    folderName,
    hookDelivered: false,
    inputTokens: 0,
    outputTokens: 0,
    providerId: codexProvider.id,
    cwd,
  };

  agents.set(id, agent);
  activeAgentIdRef.current = id;
  persistAgents();
  console.log(`[Pixel Agents] Terminal: Agent ${id} - created for terminal ${terminal.name}`);
  webview?.postMessage({ type: 'agentCreated', id, folderName });

  ensureProjectScan(
    projectDir,
    knownJsonlFiles,
    projectScanTimerRef,
    activeAgentIdRef,
    nextAgentIdRef,
    agents,
    fileWatchers,
    pollingTimers,
    waitingTimers,
    permissionTimers,
    webview,
    persistAgents,
  );

  // Poll for the specific JSONL file to appear
  const createdAt = Date.now();
  let pollCount = 0;
  console.log(`[Pixel Agents] Terminal: Agent ${id} - waiting for JSONL at ${agent.jsonlFile}`);
  const pollTimer = setInterval(() => {
    pollCount++;
    try {
      const discoveredFile = fs.existsSync(agent.jsonlFile)
        ? agent.jsonlFile
        : findNewCodexSessionFile(projectDir, cwd, createdAt, agents);

      if (discoveredFile) {
        console.log(
          `[Pixel Agents] Terminal: Agent ${id} - found JSONL file ${path.basename(discoveredFile)} (after ${pollCount}s)`,
        );
        clearInterval(pollTimer);
        jsonlPollTimers.delete(id);
        reassignAgentToFile(
          id,
          discoveredFile,
          agents,
          fileWatchers,
          pollingTimers,
          waitingTimers,
          permissionTimers,
          webview,
          persistAgents,
        );
      } else if (pollCount === 10) {
        // After 10s of polling, warn with path details to help diagnose path encoding mismatches
        const dirExists = fs.existsSync(projectDir);
        let dirContents = '';
        if (dirExists) {
          try {
            const files = listSessionFiles(projectDir).map((file) => path.basename(file));
            dirContents =
              files.length > 0
                ? `Dir has ${files.length} JSONL file(s): ${files.slice(0, 3).join(', ')}${files.length > 3 ? '...' : ''}`
                : 'Dir exists but has no JSONL files';
          } catch {
            dirContents = 'Dir exists but unreadable';
          }
        } else {
          dirContents = 'Dir does not exist';
        }
        console.warn(
          `[Pixel Agents] Terminal: Agent ${id} - JSONL file not found after 10s. ` +
            `Expected: ${agent.jsonlFile}. ${dirContents}`,
        );
      } else if (pollCount > 10) {
        // Possible /resume: terminal started a different session than expected.
        // Check every tick for a file modified after the agent was created.
        try {
          const trackedFiles = new Set([...agents.values()].map((a) => path.resolve(a.jsonlFile)));
          const candidates = listSessionFiles(projectDir)
            .map((full) => ({ file: full, mtime: fs.statSync(full).mtimeMs }))
            .filter((c) => !trackedFiles.has(path.resolve(c.file)) && c.mtime > createdAt)
            .sort((a, b) => b.mtime - a.mtime); // newest first

          if (candidates.length > 0) {
            console.log(
              `[Pixel Agents] Terminal: Agent ${id} - /resume detected, reassigning to ${path.basename(candidates[0].file)}`,
            );
            clearInterval(pollTimer);
            jsonlPollTimers.delete(id);
            reassignAgentToFile(
              id,
              candidates[0].file,
              agents,
              fileWatchers,
              pollingTimers,
              waitingTimers,
              permissionTimers,
              webview,
              persistAgents,
            );
          }
        } catch {
          /* ignore scan errors */
        }
      }
    } catch {
      /* file may not exist yet */
    }
  }, JSONL_POLL_INTERVAL_MS);
  jsonlPollTimers.set(id, pollTimer);
}

export function removeAgent(
  agentId: number,
  agents: Map<number, AgentState>,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  jsonlPollTimers: Map<number, ReturnType<typeof setInterval>>,
  persistAgents: () => void,
): void {
  const agent = agents.get(agentId);
  if (!agent) return;

  // Stop JSONL poll timer
  const jpTimer = jsonlPollTimers.get(agentId);
  if (jpTimer) {
    clearInterval(jpTimer);
  }
  jsonlPollTimers.delete(agentId);

  // Stop file watching
  fileWatchers.get(agentId)?.close();
  fileWatchers.delete(agentId);
  const pt = pollingTimers.get(agentId);
  if (pt) {
    clearInterval(pt);
  }
  pollingTimers.delete(agentId);

  // Cancel timers
  cancelWaitingTimer(agentId, waitingTimers);
  cancelPermissionTimer(agentId, permissionTimers);

  // Remove from maps
  agents.delete(agentId);
  persistAgents();
}

export function persistAgents(
  agents: Map<number, AgentState>,
  context: vscode.ExtensionContext,
): void {
  const persisted: PersistedAgent[] = [];
  for (const agent of agents.values()) {
    persisted.push({
      id: agent.id,
      sessionId: agent.sessionId,
      terminalName: agent.terminalRef?.name ?? '',
      isExternal: agent.isExternal || undefined,
      jsonlFile: agent.jsonlFile,
      projectDir: agent.projectDir,
      folderName: agent.folderName,
      teamName: agent.teamName,
      agentName: agent.agentName,
      isTeamLead: agent.isTeamLead,
      leadAgentId: agent.leadAgentId,
      teamUsesTmux: agent.teamUsesTmux,
      cwd: agent.cwd,
    });
  }
  context.workspaceState.update(WORKSPACE_KEY_AGENTS, persisted);
}

export function restoreAgents(
  context: vscode.ExtensionContext,
  nextAgentIdRef: { current: number },
  nextTerminalIndexRef: { current: number },
  agents: Map<number, AgentState>,
  knownJsonlFiles: Set<string>,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  jsonlPollTimers: Map<number, ReturnType<typeof setInterval>>,
  projectScanTimerRef: { current: ReturnType<typeof setInterval> | null },
  activeAgentIdRef: { current: number | null },
  webview: vscode.Webview | undefined,
  doPersist: () => void,
): void {
  const persisted = context.workspaceState.get<PersistedAgent[]>(WORKSPACE_KEY_AGENTS, []);
  if (persisted.length === 0) return;

  const liveTerminals = vscode.window.terminals;
  let maxId = 0;
  let maxIdx = 0;
  let restoredProjectDir: string | null = null;

  for (const p of persisted) {
    // Skip agents already in the map — prevents duplicate file watchers on re-entry
    // (webviewReady fires on every panel focus, re-calling restoreAgents each time)
    if (agents.has(p.id)) {
      knownJsonlFiles.add(p.jsonlFile);
      continue;
    }

    let terminal: vscode.Terminal | undefined;
    const isExternal = p.isExternal ?? false;

    if (isExternal) {
      // External agents — restore if JSONL file still exists on disk
      try {
        if (!fs.existsSync(p.jsonlFile)) continue;
      } catch {
        continue;
      }
    } else {
      // Terminal agents — find matching terminal by name
      terminal = liveTerminals.find((t) => t.name === p.terminalName);
      if (!terminal) continue;
    }

    const agent: AgentState = {
      id: p.id,
      sessionId: p.sessionId || getCodexSessionIdFromFile(p.jsonlFile),
      terminalRef: terminal,
      isExternal,
      projectDir: p.projectDir,
      jsonlFile: p.jsonlFile,
      fileOffset: 0,
      lineBuffer: '',
      activeToolIds: new Set(),
      activeToolStatuses: new Map(),
      activeToolNames: new Map(),
      activeSubagentToolIds: new Map(),
      activeSubagentToolNames: new Map(),
      backgroundAgentToolIds: new Set(),
      spawnedAgentToolIds: new Map(),
      pendingCloseAgentTargets: new Map(),
      isWaiting: false,
      permissionSent: false,
      hadToolsInTurn: false,
      lastDataAt: 0,
      linesProcessed: 0,
      seenUnknownRecordTypes: new Set(),
      folderName: p.folderName,
      hookDelivered: false,
      inputTokens: 0,
      outputTokens: 0,
      teamName: p.teamName,
      agentName: p.agentName,
      isTeamLead: p.isTeamLead,
      leadAgentId: p.leadAgentId,
      teamUsesTmux: p.teamUsesTmux,
      providerId: codexProvider.id,
      cwd: p.cwd,
    };

    agents.set(p.id, agent);
    knownJsonlFiles.add(p.jsonlFile);
    if (isExternal) {
      console.log(
        `[Pixel Agents] Terminal: Agent ${p.id} - restored external → ${path.basename(p.jsonlFile)}`,
      );
    } else {
      console.log(
        `[Pixel Agents] Terminal: Agent ${p.id} - restored → terminal "${p.terminalName}"`,
      );
    }

    if (p.id > maxId) maxId = p.id;
    // Extract terminal index from name like "Codex #3"
    const match = p.terminalName.match(/#(\d+)$/);
    if (match) {
      const idx = parseInt(match[1], 10);
      if (idx > maxIdx) maxIdx = idx;
    }

    restoredProjectDir = p.projectDir;

    // Start file watching if JSONL exists, skipping to end of file
    try {
      if (fs.existsSync(p.jsonlFile)) {
        const stat = fs.statSync(p.jsonlFile);
        agent.fileOffset = stat.size;
        restoreSpawnedAgentsFromCodexTranscript(agent, p.jsonlFile);
        startFileWatching(
          p.id,
          p.jsonlFile,
          agents,
          fileWatchers,
          pollingTimers,
          waitingTimers,
          permissionTimers,
          webview,
        );
      } else {
        // Poll for the file to appear
        const pollTimer = setInterval(() => {
          try {
            if (fs.existsSync(agent.jsonlFile)) {
              console.log(`[Pixel Agents] Terminal: Agent ${p.id} - found JSONL file`);
              clearInterval(pollTimer);
              jsonlPollTimers.delete(p.id);
              const stat = fs.statSync(agent.jsonlFile);
              agent.fileOffset = stat.size;
              startFileWatching(
                p.id,
                agent.jsonlFile,
                agents,
                fileWatchers,
                pollingTimers,
                waitingTimers,
                permissionTimers,
                webview,
              );
            }
          } catch {
            /* file may not exist yet */
          }
        }, JSONL_POLL_INTERVAL_MS);
        jsonlPollTimers.set(p.id, pollTimer);
      }
    } catch {
      /* ignore errors during restore */
    }
  }

  // After a short delay, remove restored terminal agents that never received data.
  // These are dead terminals restored by VS Code (e.g., after /clear or restart)
  // where the runtime is no longer running.
  const restoredTerminalIds = [...agents.entries()]
    .filter(([, a]) => !a.isExternal && a.terminalRef)
    .map(([id]) => id);
  if (restoredTerminalIds.length > 0) {
    setTimeout(() => {
      for (const id of restoredTerminalIds) {
        const agent = agents.get(id);
        if (agent && !agent.isExternal && agent.linesProcessed === 0) {
          console.log(
            `[Pixel Agents] Terminal: Agent ${id} - removing restored agent, no data received`,
          );
          agent.terminalRef?.dispose();
          removeAgent(
            id,
            agents,
            fileWatchers,
            pollingTimers,
            waitingTimers,
            permissionTimers,
            jsonlPollTimers,
            doPersist,
          );
          webview?.postMessage({ type: 'agentClosed', id });
        }
      }
    }, 10_000); // 10 seconds grace period
  }

  // Advance counters past restored IDs
  if (maxId >= nextAgentIdRef.current) {
    nextAgentIdRef.current = maxId + 1;
  }
  if (maxIdx >= nextTerminalIndexRef.current) {
    nextTerminalIndexRef.current = maxIdx + 1;
  }

  // Re-persist cleaned-up list (removes entries whose terminals are gone)
  doPersist();

  // Start project scan for /clear detection
  if (restoredProjectDir) {
    ensureProjectScan(
      restoredProjectDir,
      knownJsonlFiles,
      projectScanTimerRef,
      activeAgentIdRef,
      nextAgentIdRef,
      agents,
      fileWatchers,
      pollingTimers,
      waitingTimers,
      permissionTimers,
      webview,
      doPersist,
    );
  }
}

export function sendExistingAgents(
  agents: Map<number, AgentState>,
  context: vscode.ExtensionContext,
  webview: vscode.Webview | undefined,
): void {
  if (!webview) return;
  const agentIds: number[] = [];
  for (const id of agents.keys()) {
    agentIds.push(id);
  }
  agentIds.sort((a, b) => a - b);

  // Include persisted palette/seatId from separate key
  const agentMeta = context.workspaceState.get<
    Record<string, { palette?: number; seatId?: string }>
  >(WORKSPACE_KEY_AGENT_SEATS, {});

  // Include folderName and isExternal per agent
  const folderNames: Record<number, string> = {};
  const externalAgents: Record<number, boolean> = {};
  for (const [id, agent] of agents) {
    if (agent.folderName) {
      folderNames[id] = agent.folderName;
    }
    if (agent.isExternal) {
      externalAgents[id] = true;
    }
  }
  console.log(
    `[Pixel Agents] sendExistingAgents: agents=${JSON.stringify(agentIds)}, meta=${JSON.stringify(agentMeta)}`,
  );

  webview.postMessage({
    type: 'existingAgents',
    agents: agentIds,
    agentMeta,
    folderNames,
    externalAgents,
  });
  // Note: sendCurrentAgentStatuses is called separately AFTER layoutLoaded
  // so that agentStatus/agentToolStart messages arrive after characters are created.
}

export function sendCurrentAgentStatuses(
  agents: Map<number, AgentState>,
  webview: vscode.Webview | undefined,
): void {
  if (!webview) return;
  for (const [agentId, agent] of agents) {
    // Re-send active tools
    for (const [toolId, status] of agent.activeToolStatuses) {
      const toolName = agent.activeToolNames.get(toolId) ?? '';
      webview.postMessage({
        type: 'agentToolStart',
        id: agentId,
        toolId,
        status,
        toolName,
      });
    }
    // Re-send waiting status
    if (agent.isWaiting) {
      webview.postMessage({
        type: 'agentStatus',
        id: agentId,
        status: 'waiting',
      });
    }
    // Re-send team metadata
    if (agent.teamName) {
      webview.postMessage({
        type: 'agentTeamInfo',
        id: agentId,
        teamName: agent.teamName,
        agentName: agent.agentName,
        isTeamLead: agent.isTeamLead,
        leadAgentId: agent.leadAgentId,
        teamUsesTmux: agent.teamUsesTmux,
      });
    }
    // Re-send token usage
    if (agent.inputTokens > 0 || agent.outputTokens > 0) {
      webview.postMessage({
        type: 'agentTokenUsage',
        id: agentId,
        inputTokens: agent.inputTokens,
        outputTokens: agent.outputTokens,
      });
    }
  }
}

export function sendLayout(
  context: vscode.ExtensionContext,
  webview: vscode.Webview | undefined,
  defaultLayout?: Record<string, unknown> | null,
): void {
  if (!webview) return;
  const result = migrateAndLoadLayout(context, defaultLayout);
  webview.postMessage({
    type: 'layoutLoaded',
    layout: result?.layout ?? null,
    wasReset: result?.wasReset ?? false,
  });
}
