import assert from 'node:assert/strict';
import test from 'node:test';

import { buildReplayMessages, parseCodexSessionTranscript } from '../src/codex-session-parser.js';

function line(record) {
  return JSON.stringify(record);
}

test('parses active Codex function calls and completion', () => {
  const state = parseCodexSessionTranscript([
    line({
      type: 'session_meta',
      payload: { id: 'session-1', cwd: 'C:\\repo\\pixel-agents' },
    }),
    line({ type: 'response_item', payload: { type: 'task_started' } }),
    line({
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'shell_command',
        call_id: 'call-1',
        arguments: JSON.stringify({ command: 'npm test' }),
      },
    }),
  ]);

  assert.equal(state.sessionId, 'session-1');
  assert.equal(state.cwd, 'C:\\repo\\pixel-agents');
  assert.equal(state.status, 'active');
  assert.deepEqual(state.activeTools, [
    {
      toolId: 'call-1',
      toolName: 'Bash',
      status: 'Running: npm test',
      background: false,
    },
  ]);

  const completeState = parseCodexSessionTranscript([
    line({ type: 'session_meta', payload: { id: 'session-1' } }),
    line({
      type: 'response_item',
      payload: { type: 'function_call', name: 'apply_patch', call_id: 'patch-1' },
    }),
    line({ type: 'response_item', payload: { type: 'patch_apply_end', call_id: 'patch-1' } }),
    line({ type: 'response_item', payload: { type: 'task_complete' } }),
  ]);

  assert.equal(completeState.status, 'waiting');
  assert.deepEqual(completeState.activeTools, []);
});

test('keeps spawned agents only after a valid collab_agent_spawn_end thread id', () => {
  const missingThread = parseCodexSessionTranscript([
    line({ type: 'session_meta', payload: { id: 'parent' } }),
    line({
      type: 'response_item',
      payload: { type: 'function_call', name: 'spawn_agent', call_id: 'spawn-1' },
    }),
    line({
      type: 'response_item',
      payload: { type: 'collab_agent_spawn_end', call_id: 'spawn-1', new_thread_id: '' },
    }),
    line({
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'spawn-1' },
    }),
    line({ type: 'response_item', payload: { type: 'task_complete' } }),
  ]);

  assert.deepEqual(missingThread.spawnedThreadIds, []);
  assert.deepEqual(missingThread.activeTools, []);

  const validThread = parseCodexSessionTranscript([
    line({ type: 'session_meta', payload: { id: 'parent' } }),
    line({
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'spawn_agent',
        call_id: 'spawn-2',
        arguments: { message: 'review the API' },
      },
    }),
    line({
      type: 'response_item',
      payload: {
        type: 'collab_agent_spawn_end',
        call_id: 'spawn-2',
        new_thread_id: 'child-thread',
        new_agent_nickname: 'Reviewer',
      },
    }),
    line({
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'spawn-2' },
    }),
    line({ type: 'response_item', payload: { type: 'task_complete' } }),
  ]);

  assert.deepEqual(validThread.spawnedThreadIds, ['child-thread']);
  assert.deepEqual(validThread.knownSpawnedThreadIds, ['child-thread']);
  assert.deepEqual(validThread.activeTools, [
    {
      toolId: 'spawn-2',
      toolName: 'Agent',
      status: 'Subtask: Reviewer',
      background: true,
    },
  ]);
});

test('close_agent removes the matching spawned child', () => {
  const state = parseCodexSessionTranscript([
    line({ type: 'session_meta', payload: { id: 'parent' } }),
    line({
      type: 'response_item',
      payload: { type: 'function_call', name: 'spawn_agent', call_id: 'spawn-1' },
    }),
    line({
      type: 'response_item',
      payload: {
        type: 'collab_agent_spawn_end',
        call_id: 'spawn-1',
        new_thread_id: 'thread-a',
        new_agent_nickname: 'worker-a',
      },
    }),
    line({
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'close_agent',
        call_id: 'close-1',
        arguments: { target: 'thread-a' },
      },
    }),
    line({
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'close-1' },
    }),
  ]);

  assert.deepEqual(state.spawnedThreadIds, []);
  assert.deepEqual(state.knownSpawnedThreadIds, ['thread-a']);
  assert.deepEqual(state.activeTools, []);
});

test('builds webview replay messages from current Codex state', () => {
  const state = parseCodexSessionTranscript([
    line({ type: 'session_meta', payload: { id: 'parent' } }),
    line({
      type: 'response_item',
      payload: { type: 'token_count', info: { input_tokens: 10, output_tokens: 5 } },
    }),
    line({
      type: 'response_item',
      payload: { type: 'function_call', name: 'shell_command', call_id: 'call-1' },
    }),
  ]);

  assert.deepEqual(buildReplayMessages(7, state), [
    { type: 'agentToolsClear', id: 7 },
    { type: 'agentTokenUsage', id: 7, inputTokens: 10, outputTokens: 5 },
    {
      type: 'agentToolStart',
      id: 7,
      toolId: 'call-1',
      status: 'Running command',
      toolName: 'Bash',
    },
    { type: 'agentStatus', id: 7, status: 'active' },
  ]);
});
