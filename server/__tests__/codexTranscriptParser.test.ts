import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';

import { processTranscriptLine, setHookProvider } from '../../src/transcriptParser.js';
import type { AgentState } from '../../src/types.js';
import { codexProvider } from '../src/providers/hook/codex/codex.js';

function createAgent(): AgentState {
  return {
    id: 1,
    sessionId: 'lead-session',
    isExternal: true,
    projectDir: 'project',
    jsonlFile: 'session.jsonl',
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
    hookDelivered: false,
    inputTokens: 0,
    outputTokens: 0,
    providerId: 'codex',
  };
}

function createWebviewSink(): {
  messages: Array<Record<string, unknown>>;
  webview: vscode.Webview;
} {
  const messages: Array<Record<string, unknown>> = [];
  return {
    messages,
    webview: {
      postMessage: vi.fn((message: Record<string, unknown>) => {
        messages.push(message);
        return Promise.resolve(true);
      }),
    } as unknown as vscode.Webview,
  };
}

function codexLine(payload: Record<string, unknown>): string {
  return JSON.stringify({ type: 'event_msg', payload });
}

describe('Codex transcript spawned agent lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setHookProvider(codexProvider);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps spawned agents visible after spawn acknowledgement and removes them on close', () => {
    const agent = createAgent();
    const agents = new Map([[1, agent]]);
    const waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
    const permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();
    const { messages, webview } = createWebviewSink();

    processTranscriptLine(
      1,
      codexLine({
        type: 'function_call',
        name: 'spawn_agent',
        call_id: 'spawn-call',
        arguments: JSON.stringify({
          agent_type: 'explorer',
          message: 'Inspect integration boundaries',
        }),
      }),
      agents,
      waitingTimers,
      permissionTimers,
      webview,
    );

    expect(
      messages.some(
        (message) =>
          message.type === 'agentToolStart' &&
          message.toolId === 'spawn-call' &&
          message.toolName === 'Agent',
      ),
    ).toBe(true);

    processTranscriptLine(
      1,
      codexLine({
        type: 'collab_agent_spawn_end',
        call_id: 'spawn-call',
        new_thread_id: 'thread-1',
        new_agent_nickname: 'Scout',
        new_agent_role: 'explorer',
        status: 'pending_init',
      }),
      agents,
      waitingTimers,
      permissionTimers,
      webview,
    );
    vi.runOnlyPendingTimers();

    expect(agent.backgroundAgentToolIds.has('spawn-call')).toBe(true);
    expect(agent.spawnedAgentToolIds.get('thread-1')).toBe('spawn-call');
    expect(messages.some((message) => message.type === 'subagentClear')).toBe(false);

    processTranscriptLine(
      1,
      codexLine({
        type: 'function_call_output',
        call_id: 'spawn-call',
      }),
      agents,
      waitingTimers,
      permissionTimers,
      webview,
    );
    vi.runOnlyPendingTimers();

    expect(agent.backgroundAgentToolIds.has('spawn-call')).toBe(true);
    expect(messages.some((message) => message.type === 'subagentClear')).toBe(false);

    messages.length = 0;
    processTranscriptLine(
      1,
      codexLine({
        type: 'task_complete',
      }),
      agents,
      waitingTimers,
      permissionTimers,
      webview,
    );

    expect(agent.backgroundAgentToolIds.has('spawn-call')).toBe(true);
    expect(agent.spawnedAgentToolIds.get('thread-1')).toBe('spawn-call');
    expect(
      messages.some(
        (message) =>
          message.type === 'agentToolsClear' &&
          Array.isArray(message.preserveSubagentParentToolIds) &&
          message.preserveSubagentParentToolIds.includes('spawn-call'),
      ),
    ).toBe(true);
    expect(
      messages.some(
        (message) =>
          message.type === 'agentToolStart' &&
          message.toolId === 'spawn-call' &&
          message.toolName === 'Agent',
      ),
    ).toBe(true);
    expect(messages.some((message) => message.type === 'subagentClear')).toBe(false);

    processTranscriptLine(
      1,
      codexLine({
        type: 'function_call',
        name: 'close_agent',
        call_id: 'close-call',
        arguments: JSON.stringify({ target: 'thread-1' }),
      }),
      agents,
      waitingTimers,
      permissionTimers,
      webview,
    );
    processTranscriptLine(
      1,
      codexLine({
        type: 'collab_close_end',
        call_id: 'close-call',
        receiver_thread_id: 'thread-1',
        receiver_agent_nickname: 'Scout',
        receiver_agent_role: 'explorer',
        status: { completed: 'done' },
      }),
      agents,
      waitingTimers,
      permissionTimers,
      webview,
    );

    expect(agent.backgroundAgentToolIds.has('spawn-call')).toBe(false);
    expect(agent.spawnedAgentToolIds.size).toBe(0);
    expect(
      messages.some(
        (message) => message.type === 'subagentClear' && message.parentToolId === 'spawn-call',
      ),
    ).toBe(true);
  });

  it('does not preserve spawn attempts without a confirmed child thread id', () => {
    const agent = createAgent();
    const agents = new Map([[1, agent]]);
    const waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
    const permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();
    const { messages, webview } = createWebviewSink();

    processTranscriptLine(
      1,
      codexLine({
        type: 'function_call',
        name: 'spawn_agent',
        call_id: 'no-end-spawn',
        arguments: JSON.stringify({ agent_type: 'explorer' }),
      }),
      agents,
      waitingTimers,
      permissionTimers,
      webview,
    );

    expect(agent.backgroundAgentToolIds.has('no-end-spawn')).toBe(false);

    processTranscriptLine(
      1,
      codexLine({
        type: 'function_call_output',
        call_id: 'no-end-spawn',
      }),
      agents,
      waitingTimers,
      permissionTimers,
      webview,
    );
    vi.runOnlyPendingTimers();

    expect(agent.activeToolIds.has('no-end-spawn')).toBe(false);
    expect(agent.spawnedAgentToolIds.size).toBe(0);
    expect(
      messages.some(
        (message) => message.type === 'subagentClear' && message.parentToolId === 'no-end-spawn',
      ),
    ).toBe(true);

    messages.length = 0;
    processTranscriptLine(
      1,
      codexLine({
        type: 'function_call',
        name: 'spawn_agent',
        call_id: 'missing-thread-spawn',
        arguments: JSON.stringify({ agent_type: 'explorer' }),
      }),
      agents,
      waitingTimers,
      permissionTimers,
      webview,
    );
    processTranscriptLine(
      1,
      codexLine({
        type: 'collab_agent_spawn_end',
        call_id: 'missing-thread-spawn',
        new_thread_id: '',
        new_agent_nickname: 'Scout',
        new_agent_role: 'explorer',
      }),
      agents,
      waitingTimers,
      permissionTimers,
      webview,
    );

    expect(agent.backgroundAgentToolIds.has('missing-thread-spawn')).toBe(false);

    processTranscriptLine(
      1,
      codexLine({
        type: 'function_call_output',
        call_id: 'missing-thread-spawn',
      }),
      agents,
      waitingTimers,
      permissionTimers,
      webview,
    );
    vi.runOnlyPendingTimers();

    expect(agent.activeToolIds.has('missing-thread-spawn')).toBe(false);
    expect(agent.spawnedAgentToolIds.size).toBe(0);
    expect(
      messages.some(
        (message) =>
          message.type === 'subagentClear' && message.parentToolId === 'missing-thread-spawn',
      ),
    ).toBe(true);
  });

  it('uses Agent as a visible fallback label for spawned children without a nickname or role', () => {
    const agent = createAgent();
    const agents = new Map([[1, agent]]);
    const waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
    const permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();
    const { messages, webview } = createWebviewSink();

    processTranscriptLine(
      1,
      codexLine({
        type: 'function_call',
        name: 'spawn_agent',
        call_id: 'blank-name-spawn',
        arguments: JSON.stringify({ agent_type: 'explorer' }),
      }),
      agents,
      waitingTimers,
      permissionTimers,
      webview,
    );

    processTranscriptLine(
      1,
      codexLine({
        type: 'collab_agent_spawn_end',
        call_id: 'blank-name-spawn',
        new_thread_id: 'thread-without-name',
        new_agent_nickname: '   ',
        new_agent_role: '',
      }),
      agents,
      waitingTimers,
      permissionTimers,
      webview,
    );

    expect(agent.activeToolStatuses.get('blank-name-spawn')).toBe('Subtask: Agent');
    expect(
      messages.some(
        (message) =>
          message.type === 'agentToolStart' &&
          message.toolId === 'blank-name-spawn' &&
          message.status === 'Subtask: Agent',
      ),
    ).toBe(true);
  });
});
