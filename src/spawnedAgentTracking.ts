import * as fs from 'fs';

import type { AgentState } from './types.js';

export interface SpawnedAgentOwner {
  agentId: number;
  parentToolId: string;
}

export function spawnedAgentLookupKeys(values: Iterable<unknown>): string[] {
  const keys = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    keys.add(trimmed);
    keys.add(`thread:${trimmed}`);
    keys.add(`nickname:${trimmed}`);
    keys.add(`role:${trimmed}`);
  }
  return [...keys];
}

export function rememberSpawnedAgent(
  agent: AgentState,
  parentToolId: string,
  identifiers: Iterable<unknown>,
): void {
  for (const key of spawnedAgentLookupKeys([parentToolId, ...identifiers])) {
    agent.spawnedAgentToolIds.set(key, parentToolId);
  }
}

export function findSpawnedAgentToolId(
  agent: AgentState,
  identifiers: Iterable<unknown>,
): string | undefined {
  for (const key of spawnedAgentLookupKeys(identifiers)) {
    const parentToolId = agent.spawnedAgentToolIds.get(key);
    if (parentToolId) return parentToolId;
  }
  return undefined;
}

export function forgetSpawnedAgent(agent: AgentState, parentToolId: string): void {
  for (const [key, value] of agent.spawnedAgentToolIds) {
    if (value === parentToolId) {
      agent.spawnedAgentToolIds.delete(key);
    }
  }
}

export function findSpawnedAgentOwner(
  agents: Map<number, AgentState>,
  identifiers: Iterable<unknown>,
  excludedAgentId?: number,
): SpawnedAgentOwner | null {
  const keys = spawnedAgentLookupKeys(identifiers);
  if (keys.length === 0) return null;

  for (const [agentId, agent] of agents) {
    if (agentId === excludedAgentId) continue;
    const parentToolId = findSpawnedAgentToolId(agent, keys);
    if (parentToolId) {
      return { agentId, parentToolId };
    }
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function getPayload(record: Record<string, unknown>): Record<string, unknown> {
  return asRecord(record.payload) ?? record;
}

function spawnedLabel(payload: Record<string, unknown>): string {
  const nickname = typeof payload.new_agent_nickname === 'string' ? payload.new_agent_nickname : '';
  if (nickname.trim()) return nickname;
  const role = typeof payload.new_agent_role === 'string' ? payload.new_agent_role : '';
  return role.trim() || 'Agent';
}

function removeOpenSpawnedAgent(
  open: Map<string, { identifiers: unknown[]; status: string }>,
  aliases: Map<string, string>,
  identifiers: Iterable<unknown>,
): void {
  const parentToolId = spawnedAgentLookupKeys(identifiers)
    .map((key) => aliases.get(key))
    .find((value): value is string => typeof value === 'string');
  if (!parentToolId) return;

  open.delete(parentToolId);
  for (const [key, value] of aliases) {
    if (value === parentToolId) {
      aliases.delete(key);
    }
  }
}

export function restoreSpawnedAgentsFromCodexTranscript(
  agent: AgentState,
  jsonlFile: string,
): void {
  let text: string;
  try {
    text = fs.readFileSync(jsonlFile, 'utf-8');
  } catch {
    return;
  }

  const open = new Map<string, { identifiers: unknown[]; status: string }>();
  const aliases = new Map<string, string>();
  const pendingCloseTargets = new Map<string, unknown>();

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let payload: Record<string, unknown>;
    try {
      payload = getPayload(JSON.parse(line) as Record<string, unknown>);
    } catch {
      continue;
    }

    const type = payload.type;
    if (type === 'collab_agent_spawn_end') {
      const parentToolId = typeof payload.call_id === 'string' ? payload.call_id : undefined;
      if (!parentToolId) continue;
      const childThreadId =
        typeof payload.new_thread_id === 'string' ? payload.new_thread_id.trim() : '';
      if (!childThreadId) continue;
      const identifiers = [childThreadId, payload.new_agent_nickname, payload.new_agent_role];
      open.set(parentToolId, {
        identifiers,
        status: `Subtask: ${spawnedLabel(payload)}`,
      });
      for (const key of spawnedAgentLookupKeys([parentToolId, ...identifiers])) {
        aliases.set(key, parentToolId);
      }
    } else if (type === 'function_call' && payload.name === 'close_agent') {
      const callId = typeof payload.call_id === 'string' ? payload.call_id : undefined;
      const rawArgs = payload.arguments;
      if (!callId || typeof rawArgs !== 'string') continue;
      try {
        const args = JSON.parse(rawArgs) as { target?: unknown };
        pendingCloseTargets.set(callId, args.target);
      } catch {
        /* ignore malformed close_agent arguments */
      }
    } else if (type === 'function_call_output') {
      const callId = typeof payload.call_id === 'string' ? payload.call_id : undefined;
      if (!callId || !pendingCloseTargets.has(callId)) continue;
      removeOpenSpawnedAgent(open, aliases, [pendingCloseTargets.get(callId)]);
      pendingCloseTargets.delete(callId);
    } else if (type === 'collab_close_end') {
      const callId = typeof payload.call_id === 'string' ? payload.call_id : undefined;
      removeOpenSpawnedAgent(open, aliases, [
        payload.receiver_thread_id,
        payload.receiver_agent_nickname,
        payload.receiver_agent_role,
        callId ? pendingCloseTargets.get(callId) : undefined,
      ]);
      if (callId) {
        pendingCloseTargets.delete(callId);
      }
    }
  }

  for (const [parentToolId, restored] of open) {
    agent.backgroundAgentToolIds.add(parentToolId);
    agent.activeToolIds.add(parentToolId);
    agent.activeToolStatuses.set(parentToolId, restored.status);
    agent.activeToolNames.set(parentToolId, 'Agent');
    rememberSpawnedAgent(agent, parentToolId, restored.identifiers);
  }
}
