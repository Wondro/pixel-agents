import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CodexSessionScanner } from '../src/codex-scanner.js';

function line(record) {
  return JSON.stringify(record);
}

function writeSession(root, filename, records, ageMinutes) {
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, filename);
  fs.writeFileSync(file, `${records.map(line).join('\n')}\n`, 'utf-8');
  const when = new Date(Date.now() - ageMinutes * 60_000);
  fs.utimesSync(file, when, when);
  return file;
}

function withTempSessions(t) {
  const previousRoot = process.env.CODEX_SESSIONS_DIR;
  const previousAge = process.env.PIXEL_AGENTS_STANDALONE_ACTIVE_MAX_AGE_MINUTES;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-agents-standalone-'));
  process.env.CODEX_SESSIONS_DIR = root;
  delete process.env.PIXEL_AGENTS_STANDALONE_ACTIVE_MAX_AGE_MINUTES;
  t.after(() => {
    if (previousRoot === undefined) {
      delete process.env.CODEX_SESSIONS_DIR;
    } else {
      process.env.CODEX_SESSIONS_DIR = previousRoot;
    }
    if (previousAge === undefined) {
      delete process.env.PIXEL_AGENTS_STANDALONE_ACTIVE_MAX_AGE_MINUTES;
    } else {
      process.env.PIXEL_AGENTS_STANDALONE_ACTIVE_MAX_AGE_MINUTES = previousAge;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test('shows idle Codex sessions within the default standalone freshness window', (t) => {
  const root = withTempSessions(t);

  writeSession(
    root,
    'recent.jsonl',
    [
      { type: 'session_meta', payload: { id: 'recent-session', cwd: path.join(root, 'recent') } },
      { type: 'response_item', payload: { type: 'task_complete' } },
    ],
    120,
  );
  writeSession(
    root,
    'stale.jsonl',
    [
      { type: 'session_meta', payload: { id: 'stale-session', cwd: path.join(root, 'stale') } },
      { type: 'response_item', payload: { type: 'task_complete' } },
    ],
    300,
  );

  const scanner = new CodexSessionScanner({ onMessage: () => {} });
  scanner.refresh();

  assert.deepEqual(
    scanner.getAgents().map((agent) => agent.state.sessionId),
    ['recent-session'],
  );
});

test('suppresses spawned child session files as top-level standalone agents', (t) => {
  const root = withTempSessions(t);

  writeSession(
    root,
    'parent.jsonl',
    [
      { type: 'session_meta', payload: { id: 'parent-session', cwd: path.join(root, 'parent') } },
      {
        type: 'response_item',
        payload: { type: 'function_call', name: 'spawn_agent', call_id: 'spawn-1' },
      },
      {
        type: 'event_msg',
        payload: {
          type: 'collab_agent_spawn_end',
          call_id: 'spawn-1',
          new_thread_id: 'child-session',
          new_agent_nickname: 'reviewer',
        },
      },
      { type: 'response_item', payload: { type: 'task_complete' } },
    ],
    180,
  );
  writeSession(
    root,
    'child.jsonl',
    [
      { type: 'session_meta', payload: { id: 'child-session', cwd: path.join(root, 'parent') } },
      { type: 'response_item', payload: { type: 'task_complete' } },
    ],
    180,
  );

  const scanner = new CodexSessionScanner({ onMessage: () => {} });
  scanner.refresh();

  const agents = scanner.getAgents();
  assert.equal(agents.length, 1);
  assert.equal(agents[0].state.sessionId, 'parent-session');
  assert.deepEqual(agents[0].state.knownSpawnedThreadIds, ['child-session']);
});

test('hook events update an existing standalone agent immediately', (t) => {
  const root = withTempSessions(t);
  const messages = [];

  writeSession(
    root,
    'active.jsonl',
    [
      { type: 'session_meta', payload: { id: 'hook-session', cwd: path.join(root, 'project') } },
      { type: 'response_item', payload: { type: 'task_complete' } },
    ],
    1,
  );

  const scanner = new CodexSessionScanner({ onMessage: (message) => messages.push(message) });
  scanner.refresh();
  const agent = scanner.getAgents()[0];
  messages.length = 0;

  assert.equal(
    scanner.handleHookEvent({
      hook_event_name: 'PreToolUse',
      session_id: 'hook-session',
      tool_use_id: 'hook-call-1',
      tool_name: 'shell_command',
      tool_input: { command: 'npm test' },
    }),
    true,
  );

  assert.deepEqual(messages, [
    {
      type: 'agentToolStart',
      id: agent.id,
      toolId: 'hook-call-1',
      status: 'Running: npm test',
      toolName: 'Bash',
    },
    { type: 'agentStatus', id: agent.id, status: 'active' },
  ]);

  messages.length = 0;
  scanner.handleHookEvent({
    hook_event_name: 'PostToolUse',
    session_id: 'hook-session',
    tool_use_id: 'hook-call-1',
  });
  assert.deepEqual(messages, [{ type: 'agentToolDone', id: agent.id, toolId: 'hook-call-1' }]);

  messages.length = 0;
  scanner.handleHookEvent({ hook_event_name: 'Stop', session_id: 'hook-session' });
  assert.deepEqual(messages, [
    { type: 'agentToolsClear', id: agent.id },
    { type: 'agentStatus', id: agent.id, status: 'waiting' },
  ]);
});
