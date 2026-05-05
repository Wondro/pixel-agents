import fs from 'node:fs';
import path from 'node:path';

const BASH_COMMAND_DISPLAY_MAX_LENGTH = 60;
const TASK_DESCRIPTION_DISPLAY_MAX_LENGTH = 60;

function asRecord(value) {
  return typeof value === 'object' && value !== null ? value : null;
}

function getPayload(record) {
  return asRecord(record.payload) ?? record;
}

function parseInput(input) {
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input);
      return asRecord(parsed) ?? { input };
    } catch {
      return { input };
    }
  }
  return asRecord(input) ?? {};
}

function truncate(value, maxLength) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

export function normalizeCodexToolName(toolName) {
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

export function formatToolStatus(toolName, input = {}) {
  const inp = parseInput(input);
  const base = (value) => (typeof value === 'string' ? path.basename(value) : '');
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

function createState() {
  return {
    sessionId: null,
    cwd: null,
    status: 'waiting',
    activeTools: new Map(),
    backgroundToolIds: new Set(),
    spawnedToolIdentifiers: new Map(),
    spawnedThreadIds: new Set(),
    knownSpawnedThreadIds: new Set(),
    pendingCloseAgentTargets: new Map(),
    inputTokens: 0,
    outputTokens: 0,
    linesProcessed: 0,
  };
}

function getString(record, payload, field) {
  const value = payload[field] ?? record[field];
  return typeof value === 'string' ? value : null;
}

function clearForeground(state) {
  for (const toolId of [...state.activeTools.keys()]) {
    if (!state.backgroundToolIds.has(toolId)) {
      state.activeTools.delete(toolId);
    }
  }
  state.status = 'active';
}

function startTool(state, rawName, callId, input) {
  const toolName = normalizeCodexToolName(rawName);
  const status = formatToolStatus(rawName, input);
  state.activeTools.set(callId, { toolId: callId, toolName, status, background: false });
  if (rawName === 'close_agent') {
    const target = input.target;
    if (typeof target === 'string' && target.trim()) {
      state.pendingCloseAgentTargets.set(callId, target.trim());
    }
  }
  state.status = 'active';
}

function finishTool(state, callId) {
  if (state.backgroundToolIds.has(callId)) return;
  state.activeTools.delete(callId);
  state.pendingCloseAgentTargets.delete(callId);
}

function rememberSpawnedAgent(state, parentToolId, identifiers) {
  const cleaned = identifiers
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean);
  if (cleaned.length === 0) return;
  state.spawnedToolIdentifiers.set(parentToolId, cleaned);
  state.spawnedThreadIds.add(cleaned[0]);
  state.knownSpawnedThreadIds.add(cleaned[0]);
}

function findSpawnedToolId(state, identifiers) {
  const wanted = new Set(
    identifiers
      .filter((value) => typeof value === 'string')
      .map((value) => value.trim())
      .filter(Boolean),
  );
  if (wanted.size === 0) return null;

  for (const [toolId, values] of state.spawnedToolIdentifiers) {
    if (values.some((value) => wanted.has(value))) return toolId;
  }
  return null;
}

function registerSpawnedAgent(state, payload) {
  const parentToolId = typeof payload.call_id === 'string' ? payload.call_id : null;
  if (!parentToolId) return;

  const childThreadId =
    typeof payload.new_thread_id === 'string' ? payload.new_thread_id.trim() : '';
  if (!childThreadId) return;

  const label =
    typeof payload.new_agent_nickname === 'string' && payload.new_agent_nickname.trim()
      ? payload.new_agent_nickname.trim()
      : typeof payload.new_agent_role === 'string' && payload.new_agent_role.trim()
        ? payload.new_agent_role.trim()
        : 'Agent';
  const status = `Subtask: ${label}`;

  state.activeTools.set(parentToolId, {
    toolId: parentToolId,
    toolName: 'Agent',
    status,
    background: true,
  });
  state.backgroundToolIds.add(parentToolId);
  rememberSpawnedAgent(state, parentToolId, [
    childThreadId,
    payload.new_agent_nickname,
    payload.new_agent_role,
  ]);
}

function removeSpawnedAgent(state, identifiers) {
  const parentToolId = findSpawnedToolId(state, identifiers);
  if (!parentToolId) return;

  dismissSpawnedAgent(state, parentToolId);
}

export function dismissSpawnedAgent(state, parentToolId) {
  if (typeof parentToolId !== 'string' || !parentToolId.trim()) return false;

  if (Array.isArray(state.activeTools)) {
    const before = state.activeTools.length;
    state.activeTools = state.activeTools.filter((tool) => tool.toolId !== parentToolId);
    return state.activeTools.length !== before;
  }

  const knownIdentifiers = state.spawnedToolIdentifiers.get(parentToolId) ?? [];
  for (const identifier of knownIdentifiers) {
    state.spawnedThreadIds.delete(identifier);
  }
  state.spawnedToolIdentifiers.delete(parentToolId);
  state.backgroundToolIds.delete(parentToolId);
  state.activeTools.delete(parentToolId);
  return true;
}

function completeTurn(state) {
  if (state.backgroundToolIds.size > 0) {
    clearForeground(state);
  } else {
    state.activeTools.clear();
    state.spawnedToolIdentifiers.clear();
    state.spawnedThreadIds.clear();
    state.pendingCloseAgentTargets.clear();
  }
  state.status = 'waiting';
}

function processRecord(state, record) {
  const payload = getPayload(record);

  if (record.type === 'session_meta') {
    state.sessionId = getString(record, payload, 'id') ?? state.sessionId;
    state.cwd = getString(record, payload, 'cwd') ?? state.cwd;
    return;
  }

  if (record.type === 'turn_context') {
    state.cwd = getString(record, payload, 'cwd') ?? state.cwd;
    return;
  }

  const payloadType = typeof payload.type === 'string' ? payload.type : null;
  if (!payloadType) return;

  switch (payloadType) {
    case 'task_started':
    case 'user_message':
      clearForeground(state);
      return;

    case 'message':
      if (payload.role === 'user') {
        clearForeground(state);
      } else if (payload.role === 'assistant' && state.activeTools.size === 0) {
        state.status = 'waiting';
      }
      return;

    case 'function_call':
    case 'custom_tool_call': {
      const rawName = typeof payload.name === 'string' ? payload.name : '';
      const callId =
        typeof payload.call_id === 'string' && payload.call_id.trim()
          ? payload.call_id.trim()
          : `${rawName || 'tool'}-${state.linesProcessed}`;
      startTool(state, rawName, callId, parseInput(payload.arguments ?? payload.input));
      return;
    }

    case 'function_call_output':
    case 'custom_tool_call_output': {
      const callId = typeof payload.call_id === 'string' ? payload.call_id : null;
      if (!callId) return;
      const tool = state.activeTools.get(callId);
      if (tool?.toolName === 'close_agent') {
        removeSpawnedAgent(state, [state.pendingCloseAgentTargets.get(callId)]);
      }
      finishTool(state, callId);
      return;
    }

    case 'exec_command_end':
    case 'patch_apply_end':
    case 'collab_waiting_end':
      if (typeof payload.call_id === 'string') {
        finishTool(state, payload.call_id);
      }
      return;

    case 'collab_agent_spawn_end':
      registerSpawnedAgent(state, payload);
      return;

    case 'collab_close_end': {
      const callId = typeof payload.call_id === 'string' ? payload.call_id : null;
      removeSpawnedAgent(state, [
        payload.receiver_thread_id,
        payload.receiver_agent_nickname,
        payload.receiver_agent_role,
        callId ? state.pendingCloseAgentTargets.get(callId) : undefined,
      ]);
      if (callId) finishTool(state, callId);
      return;
    }

    case 'token_count': {
      const info = asRecord(payload.info);
      if (typeof info?.input_tokens === 'number') state.inputTokens += info.input_tokens;
      if (typeof info?.output_tokens === 'number') state.outputTokens += info.output_tokens;
      return;
    }

    case 'task_complete':
      completeTurn(state);
      return;

    default:
      return;
  }
}

export function parseCodexSessionTranscript(lines, options = {}) {
  const state = createState();
  const fallbackSessionId = options.sessionId ?? null;

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      state.linesProcessed += 1;
      processRecord(state, record);
    } catch {
      // Ignore partial or malformed JSONL records.
    }
  }

  state.sessionId = state.sessionId ?? fallbackSessionId;
  return {
    sessionId: state.sessionId,
    cwd: state.cwd,
    status: state.status,
    activeTools: [...state.activeTools.values()],
    spawnedThreadIds: [...state.spawnedThreadIds],
    knownSpawnedThreadIds: [...state.knownSpawnedThreadIds],
    inputTokens: state.inputTokens,
    outputTokens: state.outputTokens,
    linesProcessed: state.linesProcessed,
  };
}

export function parseCodexSessionFile(jsonlFile) {
  const text = fs.readFileSync(jsonlFile, 'utf-8');
  const fallbackSessionId = path.basename(jsonlFile, '.jsonl');
  return parseCodexSessionTranscript(text.split(/\r?\n/), { sessionId: fallbackSessionId });
}

export function buildReplayMessages(agentId, state) {
  const messages = [{ type: 'agentToolsClear', id: agentId }];

  if (state.inputTokens > 0 || state.outputTokens > 0) {
    messages.push({
      type: 'agentTokenUsage',
      id: agentId,
      inputTokens: state.inputTokens,
      outputTokens: state.outputTokens,
    });
  }

  for (const tool of state.activeTools) {
    messages.push({
      type: 'agentToolStart',
      id: agentId,
      toolId: tool.toolId,
      status: tool.status,
      toolName: tool.toolName,
    });
    if (tool.background) {
      messages.push({ type: 'agentToolDone', id: agentId, toolId: tool.toolId });
    }
  }

  messages.push({ type: 'agentStatus', id: agentId, status: state.status });
  return messages;
}

export function getStateSignature(state) {
  return JSON.stringify({
    sessionId: state.sessionId,
    cwd: state.cwd,
    status: state.status,
    activeTools: state.activeTools,
    spawnedThreadIds: state.spawnedThreadIds,
    knownSpawnedThreadIds: state.knownSpawnedThreadIds,
    inputTokens: state.inputTokens,
    outputTokens: state.outputTokens,
    linesProcessed: state.linesProcessed,
  });
}
