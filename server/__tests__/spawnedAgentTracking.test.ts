import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import {
  findSpawnedAgentOwner,
  findSpawnedAgentToolId,
  forgetSpawnedAgent,
  rememberSpawnedAgent,
  restoreSpawnedAgentsFromCodexTranscript,
} from '../../src/spawnedAgentTracking.js';
import type { AgentState } from '../../src/types.js';

function createAgent(id: number): AgentState {
  return {
    id,
    activeToolIds: new Set(),
    activeToolStatuses: new Map(),
    activeToolNames: new Map(),
    backgroundAgentToolIds: new Set(),
    spawnedAgentToolIds: new Map(),
  } as AgentState;
}

function codexLine(payload: Record<string, unknown>): string {
  return JSON.stringify({ type: 'event_msg', payload });
}

describe('spawned agent tracking', () => {
  it('remembers spawned child sessions by thread id and removes every alias together', () => {
    const agent = createAgent(1);

    rememberSpawnedAgent(agent, 'spawn-call', ['child-thread', 'Scout', 'explorer']);

    expect(findSpawnedAgentToolId(agent, ['child-thread'])).toBe('spawn-call');
    expect(findSpawnedAgentToolId(agent, ['thread:child-thread'])).toBe('spawn-call');
    expect(findSpawnedAgentToolId(agent, ['Scout'])).toBe('spawn-call');

    forgetSpawnedAgent(agent, 'spawn-call');

    expect(findSpawnedAgentToolId(agent, ['child-thread'])).toBeUndefined();
    expect(agent.spawnedAgentToolIds.size).toBe(0);
  });

  it('finds the parent owner for an externally detected child session', () => {
    const parent = createAgent(1);
    const duplicateChild = createAgent(2);
    rememberSpawnedAgent(parent, 'spawn-call', ['child-thread']);

    expect(
      findSpawnedAgentOwner(
        new Map([
          [1, parent],
          [2, duplicateChild],
        ]),
        ['child-thread'],
        2,
      ),
    ).toEqual({ agentId: 1, parentToolId: 'spawn-call' });
  });

  it('restores unclosed spawned child ownership from a parent transcript', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-spawn-restore-'));
    const transcript = path.join(dir, 'session.jsonl');
    fs.writeFileSync(
      transcript,
      [
        codexLine({
          type: 'collab_agent_spawn_end',
          call_id: 'spawn-call',
          new_thread_id: 'child-thread',
          new_agent_nickname: 'Scout',
          new_agent_role: 'explorer',
        }),
        codexLine({ type: 'task_complete' }),
      ].join('\n'),
    );

    try {
      const agent = createAgent(1);
      restoreSpawnedAgentsFromCodexTranscript(agent, transcript);

      expect(agent.backgroundAgentToolIds.has('spawn-call')).toBe(true);
      expect(agent.activeToolStatuses.get('spawn-call')).toBe('Subtask: Scout');
      expect(findSpawnedAgentToolId(agent, ['child-thread'])).toBe('spawn-call');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not restore incomplete spawn acknowledgements without a child thread id', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-spawn-restore-'));
    const transcript = path.join(dir, 'session.jsonl');
    fs.writeFileSync(
      transcript,
      [
        codexLine({
          type: 'collab_agent_spawn_end',
          call_id: 'missing-thread-spawn',
          new_thread_id: '',
          new_agent_nickname: 'Scout',
          new_agent_role: 'explorer',
        }),
      ].join('\n'),
    );

    try {
      const agent = createAgent(1);
      restoreSpawnedAgentsFromCodexTranscript(agent, transcript);

      expect(agent.backgroundAgentToolIds.size).toBe(0);
      expect(agent.activeToolIds.size).toBe(0);
      expect(agent.spawnedAgentToolIds.size).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not restore spawned children that were closed in the transcript', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-spawn-restore-'));
    const transcript = path.join(dir, 'session.jsonl');
    fs.writeFileSync(
      transcript,
      [
        codexLine({
          type: 'collab_agent_spawn_end',
          call_id: 'spawn-call',
          new_thread_id: 'child-thread',
          new_agent_nickname: 'Scout',
        }),
        codexLine({
          type: 'collab_close_end',
          receiver_thread_id: 'child-thread',
        }),
      ].join('\n'),
    );

    try {
      const agent = createAgent(1);
      restoreSpawnedAgentsFromCodexTranscript(agent, transcript);

      expect(agent.backgroundAgentToolIds.size).toBe(0);
      expect(agent.spawnedAgentToolIds.size).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
