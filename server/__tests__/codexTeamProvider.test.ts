import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { codexTeamProvider } from '../src/providers/hook/codex/codexTeamProvider.js';

let tmpBase: string;

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpBase };
});

describe('codexTeamProvider', () => {
  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-team-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('has providerId "codex"', () => {
    expect(codexTeamProvider.providerId).toBe('codex');
  });

  it('detects Codex agent spawn calls', () => {
    expect(codexTeamProvider.isTeammateSpawnCall('spawn_agent', {})).toBe(true);
    expect(codexTeamProvider.isTeammateSpawnCall('shell_command', {})).toBe(false);
  });

  it('extracts teammate names from events', () => {
    expect(codexTeamProvider.extractTeammateNameFromEvent({ new_agent_nickname: 'Reviewer' })).toBe(
      'Reviewer',
    );
    expect(codexTeamProvider.extractTeammateNameFromEvent({ agent_type: 'worker' })).toBe('worker');
  });

  it('parses teammate metadata', () => {
    expect(codexTeamProvider.parseTeammateMetadata('{"agentName":"Reviewer"}')).toBe('Reviewer');
    expect(codexTeamProvider.parseTeammateMetadata('not json')).toBeNull();
  });

  it('reads team members from ~/.codex/teams', () => {
    const teamDir = path.join(tmpBase, '.codex', 'teams', 'research');
    fs.mkdirSync(teamDir, { recursive: true });
    fs.writeFileSync(
      path.join(teamDir, 'config.json'),
      JSON.stringify({ members: [{ name: 'Reviewer' }, { name: 'Researcher' }] }),
    );

    expect(codexTeamProvider.getTeamMembers('research')).toEqual(
      new Set(['Reviewer', 'Researcher']),
    );
  });
});
