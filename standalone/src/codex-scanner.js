import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import chokidar from 'chokidar';

import {
  buildReplayMessages,
  dismissSpawnedAgent,
  formatToolStatus,
  getStateSignature,
  normalizeCodexToolName,
  parseCodexSessionFile,
} from './codex-session-parser.js';

const DEFAULT_SCAN_INTERVAL_MS = 5000;
const DEFAULT_ACTIVE_MAX_AGE_MS = 4 * 60 * 60 * 1000;
const DEFAULT_OWNERSHIP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_FILES = 300;

function asPositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getCodexSessionsRoot() {
  return process.env.CODEX_SESSIONS_DIR ?? path.join(os.homedir(), '.codex', 'sessions');
}

function folderNameFromCwd(cwd) {
  if (!cwd) return 'Codex';
  return path.basename(cwd) || cwd;
}

function walkJsonlFiles(root) {
  const results = [];
  const stack = [root];

  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
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
        try {
          const stat = fs.statSync(fullPath);
          results.push({ file: fullPath, stat });
        } catch {
          // Ignore files that disappeared while scanning.
        }
      }
    }
  }

  return results;
}

function send(ws, message) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(message));
  }
}

function agentToolsClearMessage(agentId, activeTools) {
  const preserveSubagentParentToolIds = activeTools
    .filter((tool) => tool.background)
    .map((tool) => tool.toolId);
  const message = { type: 'agentToolsClear', id: agentId };
  if (preserveSubagentParentToolIds.length > 0) {
    message.preserveSubagentParentToolIds = preserveSubagentParentToolIds;
  }
  return message;
}

export class CodexSessionScanner {
  constructor({ onMessage } = {}) {
    this.onMessage = onMessage ?? (() => {});
    this.sessionsRoot = getCodexSessionsRoot();
    this.scanIntervalMs = asPositiveNumber(
      process.env.PIXEL_AGENTS_STANDALONE_SCAN_INTERVAL_MS,
      DEFAULT_SCAN_INTERVAL_MS,
    );
    this.activeMaxAgeMs =
      asPositiveNumber(
        process.env.PIXEL_AGENTS_STANDALONE_ACTIVE_MAX_AGE_MINUTES,
        DEFAULT_ACTIVE_MAX_AGE_MS / 60000,
      ) * 60000;
    this.ownershipMaxAgeMs =
      asPositiveNumber(
        process.env.PIXEL_AGENTS_STANDALONE_OWNERSHIP_MAX_AGE_HOURS,
        DEFAULT_OWNERSHIP_MAX_AGE_MS / 3600000,
      ) * 3600000;
    this.maxFiles = asPositiveNumber(
      process.env.PIXEL_AGENTS_STANDALONE_MAX_FILES,
      DEFAULT_MAX_FILES,
    );

    this.nextAgentId = 1;
    this.agentsBySessionId = new Map();
    this.sessionIdByAgentId = new Map();
    this.dismissedSessions = new Map();
    this.pendingHookSessions = new Map();
    this.refreshTimer = null;
    this.scanTimer = null;
    this.watcher = null;
  }

  start() {
    this.refresh();
    this.scanTimer = setInterval(() => this.refresh(), this.scanIntervalMs);

    this.watcher = chokidar.watch(this.sessionsRoot, {
      ignoreInitial: false,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
      ignored: (candidate) => path.basename(candidate).startsWith('.'),
    });
    this.watcher.on('add', (file) => this.scheduleRefreshFor(file));
    this.watcher.on('change', (file) => this.scheduleRefreshFor(file));
    this.watcher.on('unlink', (file) => this.scheduleRefreshFor(file));
  }

  stop() {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.scanTimer) clearInterval(this.scanTimer);
    void this.watcher?.close();
  }

  getAgents() {
    return [...this.agentsBySessionId.values()].sort((a, b) => a.id - b.id);
  }

  getWorkspaceFolders() {
    const folders = new Map();
    for (const agent of this.getAgents()) {
      if (!agent.state.cwd || folders.has(agent.state.cwd)) continue;
      folders.set(agent.state.cwd, {
        name: folderNameFromCwd(agent.state.cwd),
        path: agent.state.cwd,
      });
    }
    return [...folders.values()];
  }

  getExistingAgentsPayload(agentSeats = {}) {
    const agents = [];
    const folderNames = {};
    const appNames = {};
    for (const agent of this.getAgents()) {
      agents.push(agent.id);
      folderNames[agent.id] = agent.folderName;
      appNames[agent.id] = agent.folderName;
    }
    return { type: 'existingAgents', agents, agentMeta: agentSeats, folderNames, appNames };
  }

  sendSnapshots(ws) {
    for (const agent of this.getAgents()) {
      for (const message of buildReplayMessages(agent.id, agent.state)) {
        send(ws, message);
      }
    }
  }

  sendDiagnostics(ws) {
    send(ws, { type: 'agentDiagnostics', agents: this.getDiagnostics() });
  }

  handleHookEvent(event) {
    const sessionId = typeof event.session_id === 'string' ? event.session_id : null;
    const eventName = typeof event.hook_event_name === 'string' ? event.hook_event_name : null;
    if (!sessionId || !eventName) return false;

    if (eventName === 'SessionStart') {
      this.refresh();
    }

    let agent = this.agentsBySessionId.get(sessionId);
    if (!agent) {
      this.refresh();
      agent = this.agentsBySessionId.get(sessionId);
    }
    if (!agent && eventName === 'SessionStart') {
      const cwd = typeof event.cwd === 'string' ? event.cwd : '';
      const transcriptPath =
        typeof event.transcript_path === 'string' ? event.transcript_path : undefined;
      if (cwd || transcriptPath) {
        this.pendingHookSessions.set(sessionId, { cwd, transcriptPath });
      }
      return true;
    }
    if (!agent && this.pendingHookSessions.has(sessionId)) {
      const pending = this.pendingHookSessions.get(sessionId);
      agent = this.createAgentFromHook(sessionId, pending);
      this.pendingHookSessions.delete(sessionId);
    }
    if (!agent) return false;

    switch (eventName) {
      case 'UserPromptSubmit':
        this.markAgentActive(agent);
        return true;
      case 'PreToolUse':
        this.handleHookToolStart(agent, event);
        return true;
      case 'PostToolUse':
        this.handleHookToolDone(agent, event);
        return true;
      case 'PermissionRequest':
        this.onMessage({ type: 'agentToolPermission', id: agent.id });
        return true;
      case 'Stop':
      case 'TeammateIdle':
      case 'TaskCompleted':
        this.markAgentWaiting(agent);
        return true;
      case 'SessionEnd':
        if (event.reason !== 'clear' && event.reason !== 'resume') {
          this.markAgentWaiting(agent);
          this.dismissAgent(agent.id);
        }
        return true;
      default:
        return false;
    }
  }

  getDiagnostics() {
    return this.getAgents().map((agent) => {
      let stat = null;
      try {
        stat = fs.statSync(agent.jsonlFile);
      } catch {
        // Keep null when the file is gone.
      }
      return {
        id: agent.id,
        projectDir: agent.state.cwd ?? '',
        projectDirExists: agent.state.cwd ? fs.existsSync(agent.state.cwd) : false,
        jsonlFile: agent.jsonlFile,
        jsonlExists: !!stat,
        fileSize: stat?.size ?? 0,
        fileOffset: stat?.size ?? 0,
        lastDataAt: stat?.mtimeMs ?? agent.lastDataAt,
        linesProcessed: agent.state.linesProcessed,
      };
    });
  }

  createAgentFromHook(sessionId, pending = {}) {
    if (this.isKnownSpawnedThread(sessionId)) return null;

    const transcriptPath = pending.transcriptPath;
    if (transcriptPath && fs.existsSync(transcriptPath)) {
      try {
        const parsedState = parseCodexSessionFile(transcriptPath);
        if (parsedState.sessionId && parsedState.sessionId !== sessionId) return null;
        return this.registerParsedSession({
          file: transcriptPath,
          stat: fs.statSync(transcriptPath),
          state: { ...parsedState, sessionId },
          folderName: folderNameFromCwd(parsedState.cwd ?? pending.cwd),
          lastDataAt: Date.now(),
        });
      } catch {
        // Fall through to a provisional hook-created agent.
      }
    }

    const state = {
      sessionId,
      cwd: pending.cwd ?? null,
      status: 'active',
      activeTools: [],
      spawnedThreadIds: [],
      knownSpawnedThreadIds: [],
      inputTokens: 0,
      outputTokens: 0,
      linesProcessed: 0,
    };
    return this.registerParsedSession({
      file: transcriptPath ?? '',
      stat: { mtimeMs: Date.now() },
      state,
      folderName: folderNameFromCwd(state.cwd),
      lastDataAt: Date.now(),
    });
  }

  isKnownSpawnedThread(sessionId) {
    for (const agent of this.agentsBySessionId.values()) {
      if ((agent.state.knownSpawnedThreadIds ?? agent.state.spawnedThreadIds).includes(sessionId)) {
        return true;
      }
    }
    return false;
  }

  dismissAgent(agentId) {
    const sessionId = this.sessionIdByAgentId.get(agentId);
    if (!sessionId) return;

    const agent = this.agentsBySessionId.get(sessionId);
    if (agent) {
      this.dismissedSessions.set(sessionId, agent.lastDataAt);
    }
    this.agentsBySessionId.delete(sessionId);
    this.sessionIdByAgentId.delete(agentId);
    this.onMessage({ type: 'agentClosed', id: agentId });
  }

  dismissSubagent(parentAgentId, parentToolId) {
    const agent = [...this.agentsBySessionId.values()].find(
      (candidate) => candidate.id === parentAgentId,
    );
    if (!agent || !dismissSpawnedAgent(agent.state, parentToolId)) return;

    this.onMessage({ type: 'subagentClear', id: parentAgentId, parentToolId });
    this.onMessage({ type: 'agentToolDone', id: parentAgentId, toolId: parentToolId });
  }

  markAgentActive(agent) {
    agent.state.activeTools = agent.state.activeTools.filter((tool) => tool.background);
    agent.state.status = 'active';
    this.onMessage(agentToolsClearMessage(agent.id, agent.state.activeTools));
    for (const tool of agent.state.activeTools) {
      this.onMessage({
        type: 'agentToolStart',
        id: agent.id,
        toolId: tool.toolId,
        status: tool.status,
        toolName: tool.toolName,
      });
    }
    this.onMessage({ type: 'agentStatus', id: agent.id, status: 'active' });
  }

  handleHookToolStart(agent, event) {
    const rawToolName = typeof event.tool_name === 'string' ? event.tool_name : '';
    const toolName = normalizeCodexToolName(rawToolName);
    const toolId =
      typeof event.tool_use_id === 'string' && event.tool_use_id.trim()
        ? event.tool_use_id.trim()
        : `hook-${Date.now()}`;
    const status = formatToolStatus(rawToolName, event.tool_input);

    agent.hookCurrentToolId = toolId;
    agent.hookCurrentToolName = toolName;
    agent.state.status = 'active';

    if (toolName !== 'Task' && toolName !== 'Agent') {
      agent.state.activeTools = [
        ...agent.state.activeTools.filter((tool) => tool.toolId !== toolId),
        { toolId, toolName, status, background: false },
      ];
      this.onMessage({ type: 'agentToolStart', id: agent.id, toolId, status, toolName });
    }
    this.onMessage({ type: 'agentStatus', id: agent.id, status: 'active' });
  }

  handleHookToolDone(agent, event) {
    const toolId =
      typeof event.tool_use_id === 'string' && event.tool_use_id.trim()
        ? event.tool_use_id.trim()
        : agent.hookCurrentToolId;
    if (!toolId) return;

    const tool = agent.state.activeTools.find((item) => item.toolId === toolId);
    if (tool && !tool.background) {
      agent.state.activeTools = agent.state.activeTools.filter((item) => item.toolId !== toolId);
      this.onMessage({ type: 'agentToolDone', id: agent.id, toolId });
    }
    agent.hookCurrentToolId = undefined;
    agent.hookCurrentToolName = undefined;
  }

  markAgentWaiting(agent) {
    agent.state.activeTools = agent.state.activeTools.filter((tool) => tool.background);
    agent.state.status = 'waiting';
    this.onMessage(agentToolsClearMessage(agent.id, agent.state.activeTools));
    for (const tool of agent.state.activeTools) {
      this.onMessage({
        type: 'agentToolStart',
        id: agent.id,
        toolId: tool.toolId,
        status: tool.status,
        toolName: tool.toolName,
      });
    }
    this.onMessage({ type: 'agentStatus', id: agent.id, status: 'waiting' });
  }

  scheduleRefreshFor(file) {
    if (!file.endsWith('.jsonl')) return;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.refresh();
    }, 150);
  }

  registerParsedSession(parsed) {
    const sessionId = parsed.state.sessionId;
    let agent = this.agentsBySessionId.get(sessionId);
    const isNew = !agent;

    if (!agent) {
      agent = {
        id: this.nextAgentId++,
        jsonlFile: parsed.file,
        folderName: parsed.folderName,
        state: parsed.state,
        lastDataAt: parsed.lastDataAt,
        signature: '',
      };
      this.agentsBySessionId.set(sessionId, agent);
      this.sessionIdByAgentId.set(agent.id, sessionId);
      this.onMessage({
        type: 'agentCreated',
        id: agent.id,
        folderName: agent.folderName,
        appName: agent.folderName,
      });
    }

    agent.jsonlFile = parsed.file;
    agent.folderName = parsed.folderName;
    agent.state = parsed.state;
    agent.lastDataAt = parsed.lastDataAt;

    const signature = getStateSignature(parsed.state);
    if (isNew || signature !== agent.signature) {
      agent.signature = signature;
      for (const message of buildReplayMessages(agent.id, agent.state)) {
        this.onMessage(message);
      }
    }

    return agent;
  }

  refresh() {
    const now = Date.now();
    const files = walkJsonlFiles(this.sessionsRoot)
      .filter(({ stat }) => now - stat.mtimeMs <= this.ownershipMaxAgeMs)
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
      .slice(0, this.maxFiles);

    const parsedSessions = [];
    for (const info of files) {
      try {
        const state = parseCodexSessionFile(info.file);
        if (!state.sessionId) continue;
        parsedSessions.push({
          ...info,
          state,
          folderName: folderNameFromCwd(state.cwd),
          lastDataAt: info.stat.mtimeMs,
        });
      } catch {
        // A transcript can be mid-write; the next scan will pick it up.
      }
    }

    const spawnedThreadIds = new Set();
    for (const parsed of parsedSessions) {
      for (const threadId of parsed.state.knownSpawnedThreadIds ?? parsed.state.spawnedThreadIds) {
        spawnedThreadIds.add(threadId);
      }
    }

    const visibleSessions = parsedSessions
      .filter(
        (parsed) =>
          now - parsed.stat.mtimeMs <= this.activeMaxAgeMs ||
          parsed.state.activeTools.length > 0 ||
          parsed.state.spawnedThreadIds.length > 0,
      )
      .filter((parsed) => !spawnedThreadIds.has(parsed.state.sessionId))
      .filter((parsed) => {
        const dismissedAt = this.dismissedSessions.get(parsed.state.sessionId);
        if (!dismissedAt) return true;
        if (parsed.lastDataAt > dismissedAt) {
          this.dismissedSessions.delete(parsed.state.sessionId);
          return true;
        }
        return false;
      })
      .sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs || a.file.localeCompare(b.file));

    const visibleSessionIds = new Set(visibleSessions.map((parsed) => parsed.state.sessionId));
    for (const [sessionId, agent] of [...this.agentsBySessionId]) {
      if (visibleSessionIds.has(sessionId)) continue;
      this.agentsBySessionId.delete(sessionId);
      this.sessionIdByAgentId.delete(agent.id);
      this.onMessage({ type: 'agentClosed', id: agent.id });
    }

    for (const parsed of visibleSessions) {
      const sessionId = parsed.state.sessionId;
      this.registerParsedSession(parsed);
    }
  }
}
