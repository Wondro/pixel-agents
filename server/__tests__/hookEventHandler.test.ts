import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentState } from '../../src/types.js';
import { HookEventHandler } from '../src/hookEventHandler.js';
import { codexProvider } from '../src/providers/hook/codex/codex.js';

function createTestAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: 1,
    sessionId: '',
    terminalRef: undefined,
    isExternal: true,
    projectDir: '/test',
    jsonlFile: '/test/session.jsonl',
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
    ...overrides,
  } as AgentState;
}

function createMockWebview() {
  const messages: Array<Record<string, unknown>> = [];
  return {
    postMessage: vi.fn((msg: Record<string, unknown>) => {
      messages.push(msg);
      return Promise.resolve(true);
    }),
    messages,
  };
}

describe('HookEventHandler', () => {
  let agents: Map<number, AgentState>;
  let waitingTimers: Map<number, ReturnType<typeof setTimeout>>;
  let permissionTimers: Map<number, ReturnType<typeof setTimeout>>;
  let mockWebview: ReturnType<typeof createMockWebview>;
  let handler: HookEventHandler;

  beforeEach(() => {
    agents = new Map();
    waitingTimers = new Map();
    permissionTimers = new Map();
    mockWebview = createMockWebview();
    handler = new HookEventHandler(
      agents,
      waitingTimers,
      permissionTimers,
      () => mockWebview as unknown as import('vscode').Webview,
      codexProvider,
    );
  });

  it('PermissionRequest sends agentToolPermission', () => {
    const agent = createTestAgent({ id: 1 });
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('codex', {
      hook_event_name: 'PermissionRequest',
      session_id: 'sess-1',
    });

    const msg = mockWebview.messages.find((m) => m.type === 'agentToolPermission');
    expect(msg).toBeTruthy();
    expect(msg?.id).toBe(1);
    expect(agent.permissionSent).toBe(true);
  });

  it('Stop marks agent waiting and clears foreground tools', () => {
    const agent = createTestAgent({ id: 1 });
    agent.activeToolIds.add('fg-tool');
    agent.activeToolStatuses.set('fg-tool', 'Running');
    agent.activeToolNames.set('fg-tool', 'Bash');
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('codex', {
      hook_event_name: 'Stop',
      session_id: 'sess-1',
    });

    expect(agent.isWaiting).toBe(true);
    expect(agent.activeToolIds.has('fg-tool')).toBe(false);
    expect(mockWebview.messages.some((m) => m.type === 'agentToolsClear')).toBe(true);
    expect(
      mockWebview.messages.some((m) => m.type === 'agentStatus' && m.status === 'waiting'),
    ).toBe(true);
  });

  it('Stop rehydrates background spawned agents with their tool name', () => {
    const agent = createTestAgent({ id: 1 });
    agent.activeToolIds.add('spawn-call');
    agent.activeToolStatuses.set('spawn-call', 'Subtask: Scout');
    agent.activeToolNames.set('spawn-call', 'Agent');
    agent.backgroundAgentToolIds.add('spawn-call');
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('codex', {
      hook_event_name: 'Stop',
      session_id: 'sess-1',
    });
    handler.handleEvent('codex', {
      hook_event_name: 'Stop',
      session_id: 'sess-1',
    });

    const clearMessages = mockWebview.messages.filter((m) => m.type === 'agentToolsClear');
    expect(clearMessages).toHaveLength(2);
    expect(
      clearMessages.every(
        (m) =>
          Array.isArray(m.preserveSubagentParentToolIds) &&
          m.preserveSubagentParentToolIds.includes('spawn-call'),
      ),
    ).toBe(true);
    expect(
      mockWebview.messages.some(
        (m) => m.type === 'agentToolStart' && m.toolId === 'spawn-call' && m.toolName === 'Agent',
      ),
    ).toBe(true);
  });

  it('PreToolUse marks agent active and sends a tool start', () => {
    const agent = createTestAgent({ id: 1 });
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('codex', {
      hook_event_name: 'PreToolUse',
      session_id: 'sess-1',
      tool_use_id: 'call-1',
      tool_name: 'shell_command',
      tool_input: { command: 'npm test' },
    });

    expect(agent.isWaiting).toBe(false);
    expect(mockWebview.messages.some((m) => m.type === 'agentToolStart')).toBe(true);
    expect(
      mockWebview.messages.some((m) => m.type === 'agentStatus' && m.status === 'active'),
    ).toBe(true);
  });

  it('buffers then auto-discovers an unregistered agent by sessionId', () => {
    const agent = createTestAgent({ id: 1, sessionId: 'sess-1' });
    agents.set(1, agent);

    handler.handleEvent('codex', {
      hook_event_name: 'Stop',
      session_id: 'sess-1',
    });

    expect(agent.isWaiting).toBe(true);
  });

  it('creates pending external sessions only after confirmation', () => {
    const onExternalSessionDetected = vi.fn();
    handler.setLifecycleCallbacks({ onExternalSessionDetected });

    handler.handleEvent('codex', {
      hook_event_name: 'SessionStart',
      session_id: 'external-1',
      transcript_path: '/test/external.jsonl',
      cwd: '/test',
    });
    expect(onExternalSessionDetected).not.toHaveBeenCalled();

    handler.handleEvent('codex', {
      hook_event_name: 'Stop',
      session_id: 'external-1',
    });
    expect(onExternalSessionDetected).toHaveBeenCalledWith(
      'external-1',
      '/test/external.jsonl',
      '/test',
    );
  });

  it('does not promote known spawned child sessions to external agents', () => {
    const lead = createTestAgent({ id: 1, sessionId: 'lead-1' });
    lead.spawnedAgentToolIds.set('thread:child-1', 'spawn-call');
    agents.set(1, lead);
    const onExternalSessionDetected = vi.fn();
    handler.setLifecycleCallbacks({ onExternalSessionDetected });

    handler.handleEvent('codex', {
      hook_event_name: 'SessionStart',
      session_id: 'child-1',
      transcript_path: '/test/child.jsonl',
      cwd: '/test',
    });
    handler.handleEvent('codex', {
      hook_event_name: 'Stop',
      session_id: 'child-1',
    });

    expect(onExternalSessionDetected).not.toHaveBeenCalled();
  });
});
