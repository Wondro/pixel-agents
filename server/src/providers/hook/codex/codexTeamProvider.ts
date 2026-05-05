import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { TeamProvider } from '../../../teamProvider.js';

export const codexTeamProvider: TeamProvider = {
  providerId: 'codex',

  teammateSpawnTools: new Set(['spawn_agent', 'Agent']),
  withinTurnSubagentTools: new Set(['spawn_agent', 'Agent', 'Task']),

  isTeammateSpawnCall(toolName: string, toolInput: Record<string, unknown>): boolean {
    if (toolName === 'spawn_agent') return true;
    return toolName === 'Agent' && toolInput.run_in_background === true;
  },

  extractTeammateNameFromEvent(event: Record<string, unknown>): string | undefined {
    const nickname = event.new_agent_nickname;
    if (typeof nickname === 'string' && nickname.trim()) return nickname;
    const role = event.new_agent_role;
    if (typeof role === 'string' && role.trim()) return role;
    const agentType = event.agent_type;
    return typeof agentType === 'string' ? agentType : undefined;
  },

  resolveTeammateMetadataPath(teammateJsonlFile: string): string {
    return `${teammateJsonlFile}.meta.json`;
  },

  parseTeammateMetadata(metadataContents: string): string | null {
    try {
      const parsed = JSON.parse(metadataContents) as { agentType?: unknown; agentName?: unknown };
      if (typeof parsed.agentName === 'string') return parsed.agentName;
      if (typeof parsed.agentType === 'string') return parsed.agentType;
    } catch {
      /* ignore */
    }
    return null;
  },

  resolveTeammateJsonlDir(projectDir: string, leadSessionId: string): string {
    return path.join(projectDir, leadSessionId, 'subagents');
  },

  getTeamMembers(teamName: string): Set<string> | null {
    try {
      const configPath = path.join(os.homedir(), '.codex', 'teams', teamName, 'config.json');
      if (!fs.existsSync(configPath)) return null;
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
        members?: Array<{ name?: unknown }>;
      };
      if (!Array.isArray(parsed.members)) return null;
      const names = parsed.members
        .map((member) => member.name)
        .filter((name): name is string => typeof name === 'string' && name.length > 0);
      return new Set(names);
    } catch {
      return null;
    }
  },

  extractTeamMetadataFromRecord(
    record: Record<string, unknown>,
  ): { teamName?: string; agentName?: string } | null {
    const payload =
      typeof record.payload === 'object' && record.payload !== null
        ? (record.payload as Record<string, unknown>)
        : {};
    const teamName = record.teamName ?? payload.teamName;
    const agentName = record.agentName ?? payload.agentName ?? payload.new_agent_nickname;
    if (typeof teamName !== 'string') return null;
    return {
      teamName,
      agentName: typeof agentName === 'string' ? agentName : undefined,
    };
  },
};
