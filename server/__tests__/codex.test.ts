import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { codexProvider, readCodexSessionMetadata } from '../src/providers/hook/codex/codex.js';

describe('codexProvider', () => {
  describe('identity', () => {
    it('has kind "hook"', () => {
      expect(codexProvider.kind).toBe('hook');
    });

    it('has id "codex"', () => {
      expect(codexProvider.id).toBe('codex');
    });

    it('has a displayName', () => {
      expect(codexProvider.displayName).toBe('Codex');
    });

    it('has a linked TeamProvider', () => {
      expect(codexProvider.team).toBeDefined();
      expect(codexProvider.team?.providerId).toBe('codex');
    });
  });

  describe('normalizeHookEvent', () => {
    it('returns null when hook_event_name is missing', () => {
      expect(codexProvider.normalizeHookEvent({ session_id: 'x' })).toBeNull();
    });

    it('returns null when session_id is missing', () => {
      expect(codexProvider.normalizeHookEvent({ hook_event_name: 'Stop' })).toBeNull();
    });

    it('normalizes PreToolUse with tool_name + tool_input', () => {
      const result = codexProvider.normalizeHookEvent({
        hook_event_name: 'PreToolUse',
        session_id: 'sess-1',
        tool_use_id: 'call-1',
        tool_name: 'shell_command',
        tool_input: { command: 'npm test' },
      });
      expect(result?.sessionId).toBe('sess-1');
      expect(result?.event.kind).toBe('toolStart');
      if (result?.event.kind === 'toolStart') {
        expect(result.event.toolId).toBe('call-1');
        expect(result.event.toolName).toBe('shell_command');
        expect(result.event.input).toEqual({ command: 'npm test' });
      }
    });

    it('normalizes PostToolUse to toolEnd', () => {
      const result = codexProvider.normalizeHookEvent({
        hook_event_name: 'PostToolUse',
        session_id: 'sess-1',
        tool_use_id: 'call-1',
      });
      expect(result?.event.kind).toBe('toolEnd');
      if (result?.event.kind === 'toolEnd') {
        expect(result.event.toolId).toBe('call-1');
      }
    });

    it('normalizes Stop to turnEnd', () => {
      const result = codexProvider.normalizeHookEvent({
        hook_event_name: 'Stop',
        session_id: 'sess-1',
      });
      expect(result?.event.kind).toBe('turnEnd');
    });

    it('normalizes UserPromptSubmit to userTurn', () => {
      const result = codexProvider.normalizeHookEvent({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'sess-1',
      });
      expect(result?.event.kind).toBe('userTurn');
    });

    it('normalizes PermissionRequest to permissionRequest', () => {
      const result = codexProvider.normalizeHookEvent({
        hook_event_name: 'PermissionRequest',
        session_id: 'sess-1',
      });
      expect(result?.event.kind).toBe('permissionRequest');
    });

    it('normalizes SessionStart with source', () => {
      const result = codexProvider.normalizeHookEvent({
        hook_event_name: 'SessionStart',
        session_id: 'sess-1',
        source: 'startup',
      });
      expect(result?.event.kind).toBe('sessionStart');
      if (result?.event.kind === 'sessionStart') {
        expect(result.event.source).toBe('startup');
      }
    });
  });

  describe('formatToolStatus', () => {
    it('formats shell_command', () => {
      expect(codexProvider.formatToolStatus('shell_command', { command: 'npm test' })).toBe(
        'Running: npm test',
      );
    });

    it('formats spawn_agent with a prompt', () => {
      expect(codexProvider.formatToolStatus('spawn_agent', { prompt: 'Review API' })).toBe(
        'Subtask: Review API',
      );
    });

    it('falls back to "Using X" for unknown tools', () => {
      expect(codexProvider.formatToolStatus('FancyTool', {})).toBe('Using FancyTool');
    });
  });

  describe('buildLaunchCommand', () => {
    it('builds a Codex launch command', () => {
      expect(codexProvider.buildLaunchCommand?.('ignored', '/tmp')).toEqual({
        command: 'codex',
        args: ['--enable', 'codex_hooks'],
      });
    });

    it('maps bypass mode to the Codex bypass flag', () => {
      expect(codexProvider.buildLaunchCommand?.('ignored', '/tmp', true)?.args).toContain(
        '--dangerously-bypass-approvals-and-sandbox',
      );
    });
  });

  describe('readCodexSessionMetadata', () => {
    it('reads nested metadata written by Codex chat sessions', () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-agents-codex-meta-'));
      try {
        const jsonlFile = path.join(tempDir, 'session.jsonl');
        fs.writeFileSync(
          jsonlFile,
          [
            JSON.stringify({
              timestamp: '2026-05-04T12:00:00.000Z',
              type: 'session_meta',
              payload: {
                id: 'sess-chat',
                timestamp: '2026-05-04T12:00:00.000Z',
                cwd: 'C:\\Users\\Wondr\\project',
              },
            }),
            JSON.stringify({
              timestamp: '2026-05-04T12:00:01.000Z',
              type: 'turn_context',
              payload: { cwd: 'C:\\Users\\Wondr\\project' },
            }),
          ].join('\n'),
        );

        expect(readCodexSessionMetadata(jsonlFile)).toEqual({
          id: 'sess-chat',
          cwd: 'C:\\Users\\Wondr\\project',
          timestamp: Date.parse('2026-05-04T12:00:00.000Z'),
        });
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('reads metadata when the first chat metadata line is larger than 8 KB', () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-agents-codex-meta-'));
      try {
        const jsonlFile = path.join(tempDir, 'session.jsonl');
        fs.writeFileSync(
          jsonlFile,
          `${JSON.stringify({
            timestamp: '2026-05-04T12:00:00.000Z',
            type: 'session_meta',
            payload: {
              id: 'sess-large-meta',
              timestamp: '2026-05-04T12:00:00.000Z',
              cwd: 'C:\\Users\\Wondr\\large-project',
              base_instructions: 'x'.repeat(20_000),
            },
          })}\n`,
        );

        expect(readCodexSessionMetadata(jsonlFile).cwd).toBe('C:\\Users\\Wondr\\large-project');
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
});
