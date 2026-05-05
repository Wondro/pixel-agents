import * as path from 'path';
import type * as vscode from 'vscode';

import {
  BASH_COMMAND_DISPLAY_MAX_LENGTH,
  TASK_DESCRIPTION_DISPLAY_MAX_LENGTH,
  TEXT_IDLE_DELAY_MS,
  TOOL_DONE_DELAY_MS,
} from '../server/src/constants.js';
import type { HookProvider } from '../server/src/provider.js';
import { normalizeCodexToolName } from '../server/src/providers/hook/codex/codex.js';
import {
  findSpawnedAgentToolId,
  forgetSpawnedAgent,
  rememberSpawnedAgent,
} from './spawnedAgentTracking.js';
import {
  cancelPermissionTimer,
  cancelWaitingTimer,
  clearAgentActivity,
  startPermissionTimer,
  startWaitingTimer,
} from './timerManager.js';
import type { AgentState } from './types.js';

const debug = process.env.PIXEL_AGENTS_DEBUG !== '0';

const PERMISSION_EXEMPT_TOOLS = new Set([
  'Task',
  'Agent',
  'spawn_agent',
  'wait_agent',
  'close_agent',
  'AskUserQuestion',
]);

/** Hook provider: supplies formatToolStatus + team.extractTeamMetadataFromRecord.
 *  Registered once at startup via setHookProvider(). Functions below assume it's set. */
let hookProvider: HookProvider | null = null;

/** Register the HookProvider that owns CLI-specific formatting and team metadata extraction. */
export function setHookProvider(provider: HookProvider): void {
  hookProvider = provider;
}

/** Format a tool status line. Delegates to the active HookProvider's formatToolStatus. */
export function formatToolStatus(toolName: string, input: Record<string, unknown>): string {
  if (hookProvider) return hookProvider.formatToolStatus(toolName, input);
  // Fallback for bootstrapping / tests without a provider set.
  return defaultFormatToolStatus(toolName, input);
}

/** Fallback formatter for edge cases (tests, provider not yet registered). */
function defaultFormatToolStatus(toolName: string, input: Record<string, unknown>): string {
  const base = (p: unknown) => (typeof p === 'string' ? path.basename(p) : '');
  switch (toolName) {
    case 'Read':
      return `Reading ${base(input.file_path)}`;
    case 'Edit':
      return `Editing ${base(input.file_path)}`;
    case 'Write':
      return `Writing ${base(input.file_path)}`;
    case 'Bash': {
      const cmd = (input.command as string) || '';
      return `Running: ${cmd.length > BASH_COMMAND_DISPLAY_MAX_LENGTH ? cmd.slice(0, BASH_COMMAND_DISPLAY_MAX_LENGTH) + '\u2026' : cmd}`;
    }
    case 'Glob':
      return 'Searching files';
    case 'Grep':
      return 'Searching code';
    case 'WebFetch':
      return 'Fetching web content';
    case 'WebSearch':
      return 'Searching the web';
    case 'Task':
    case 'Agent': {
      const desc = typeof input.description === 'string' ? input.description : '';
      return desc
        ? `Subtask: ${desc.length > TASK_DESCRIPTION_DISPLAY_MAX_LENGTH ? desc.slice(0, TASK_DESCRIPTION_DISPLAY_MAX_LENGTH) + '\u2026' : desc}`
        : 'Running subtask';
    }
    case 'AskUserQuestion':
      return 'Waiting for your answer';
    case 'EnterPlanMode':
      return 'Planning';
    case 'NotebookEdit':
      return `Editing notebook`;
    case 'TeamCreate': {
      const teamName = typeof input.team_name === 'string' ? input.team_name : '';
      return teamName ? `Creating team: ${teamName}` : 'Creating team';
    }
    case 'SendMessage': {
      const recipient = typeof input.recipient === 'string' ? input.recipient : '';
      return recipient ? `-> ${recipient}` : 'Sending message';
    }
    default:
      return `Using ${toolName}`;
  }
}

export function processTranscriptLine(
  agentId: number,
  line: string,
  agents: Map<number, AgentState>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  webview: vscode.Webview | undefined,
): void {
  const agent = agents.get(agentId);
  if (!agent) return;
  agent.lastDataAt = Date.now();
  agent.linesProcessed++;
  try {
    const record = JSON.parse(line);

    // -- Agent Teams: extract team metadata via the active provider --
    // The provider reads its CLI's own field names.
    // Other CLIs would implement this differently or not at all.
    const teamMeta = hookProvider?.team?.extractTeamMetadataFromRecord(record);
    if (teamMeta?.teamName && teamMeta.teamName !== agent.teamName) {
      agent.teamName = teamMeta.teamName;
      agent.agentName = teamMeta.agentName;
      agent.isTeamLead = undefined;
      agent.leadAgentId = undefined;
      if (debug) {
        console.log(
          `[Pixel Agents] Agent ${agentId} team metadata: team=${agent.teamName}, role=${agent.agentName ?? 'lead'}`,
        );
      }
      // Link teammates to leads within the same team
      linkTeammates(agentId, agent, agents);

      webview?.postMessage({
        type: 'agentTeamInfo',
        id: agentId,
        teamName: agent.teamName,
        agentName: agent.agentName,
        isTeamLead: agent.isTeamLead,
        leadAgentId: agent.leadAgentId,
      });
    }

    // -- Token usage extraction from assistant records --
    const usage = record.message?.usage as
      | { input_tokens?: number; output_tokens?: number }
      | undefined;
    if (usage) {
      if (typeof usage.input_tokens === 'number') {
        agent.inputTokens += usage.input_tokens;
      }
      if (typeof usage.output_tokens === 'number') {
        agent.outputTokens += usage.output_tokens;
      }
      webview?.postMessage({
        type: 'agentTokenUsage',
        id: agentId,
        inputTokens: agent.inputTokens,
        outputTokens: agent.outputTokens,
      });
    }

    if (
      processCodexTranscriptRecord(
        agentId,
        record,
        agents,
        waitingTimers,
        permissionTimers,
        webview,
      )
    ) {
      return;
    }

    // Resilient content extraction: support both record.message.content and record.content.
    const assistantContent = record.message?.content ?? record.content;

    if (record.type === 'assistant' && Array.isArray(assistantContent)) {
      const blocks = assistantContent as Array<{
        type: string;
        id?: string;
        name?: string;
        input?: Record<string, unknown>;
      }>;
      const hasToolUse = blocks.some((b) => b.type === 'tool_use');

      if (hasToolUse) {
        cancelWaitingTimer(agentId, waitingTimers);
        agent.isWaiting = false;
        agent.hadToolsInTurn = true;
        webview?.postMessage({ type: 'agentStatus', id: agentId, status: 'active' });
        let hasNonExemptTool = false;
        for (const block of blocks) {
          if (block.type === 'tool_use' && block.id) {
            const toolName = block.name || '';
            const status = formatToolStatus(toolName, block.input || {});
            console.log(
              `[Pixel Agents] JSONL: Agent ${agentId} - tool start: ${block.id} ${status}`,
            );
            agent.activeToolIds.add(block.id);
            agent.activeToolStatuses.set(block.id, status);
            agent.activeToolNames.set(block.id, toolName);
            if (!PERMISSION_EXEMPT_TOOLS.has(toolName)) {
              hasNonExemptTool = true;
            }
            // Detect tmux vs inline team mode from Agent tool's run_in_background flag
            if (
              agent.teamName &&
              toolName === 'Agent' &&
              block.input?.run_in_background === true &&
              !agent.teamUsesTmux
            ) {
              agent.teamUsesTmux = true;
              webview?.postMessage({
                type: 'agentTeamInfo',
                id: agentId,
                teamName: agent.teamName,
                agentName: agent.agentName,
                isTeamLead: agent.isTeamLead,
                leadAgentId: agent.leadAgentId,
                teamUsesTmux: true,
              });
            }
            // Skip webview message when hooks handle tool visuals (PreToolUse sent it instantly).
            // EXCEPTION: subagent-spawn tools (Task/Agent) ALWAYS use JSONL so the sub-agent
            // character is created with the REAL tool id. SubagentStop and subagentClear use
            // the real id -- a synthetic-id sub-agent from PreToolUse could never be matched.
            const isSubagentSpawn = toolName === 'Agent' || toolName === 'Task';
            if (!agent.hookDelivered || isSubagentSpawn) {
              const runInBackground = isSubagentSpawn && block.input?.run_in_background === true;
              webview?.postMessage({
                type: 'agentToolStart',
                id: agentId,
                toolId: block.id,
                status,
                toolName,
                permissionActive: agent.permissionSent,
                runInBackground,
              });
            }
          }
        }
        // Skip heuristic timer when hooks are active OR for teammates.
        // Teammate tools (WebFetch, WebSearch) are naturally slow; the heuristic
        // produces false positives. Permission on teammates comes from the lead's
        // routed Notification(permission_prompt) hook — slower but accurate.
        if (hasNonExemptTool && !agent.hookDelivered && !agent.leadAgentId) {
          startPermissionTimer(agentId, agents, permissionTimers, PERMISSION_EXEMPT_TOOLS, webview);
        }
      } else if (blocks.some((b) => b.type === 'text') && !agent.hadToolsInTurn) {
        // Text-only response in a turn that hasn't used any tools.
        // turn_duration handles tool-using turns reliably but is never
        // emitted for text-only turns, so we use a silence-based timer:
        // if no new JSONL data arrives within TEXT_IDLE_DELAY_MS, mark as waiting.
        // Skip when hooks are active — Stop hook handles this exactly.
        if (!agent.hookDelivered) {
          startWaitingTimer(agentId, TEXT_IDLE_DELAY_MS, agents, waitingTimers, webview);
        }
      }
    } else if (record.type === 'assistant' && typeof assistantContent === 'string') {
      // Text-only assistant response (content is a string, not an array)
      if (!agent.hadToolsInTurn && !agent.hookDelivered) {
        startWaitingTimer(agentId, TEXT_IDLE_DELAY_MS, agents, waitingTimers, webview);
      }
    } else if (record.type === 'assistant' && assistantContent === undefined) {
      // Assistant record with no recognizable content structure
      console.warn(
        `[Pixel Agents] Agent ${agentId}: assistant record has no content. Keys: ${Object.keys(record).join(', ')}`,
      );
    } else if (record.type === 'progress') {
      processProgressRecord(agentId, record, agents, waitingTimers, permissionTimers, webview);
    } else if (record.type === 'user') {
      const content = record.message?.content ?? record.content;
      if (Array.isArray(content)) {
        const blocks = content as Array<{ type: string; tool_use_id?: string }>;
        const hasToolResult = blocks.some((b) => b.type === 'tool_result');
        if (hasToolResult) {
          for (const block of blocks) {
            if (block.type === 'tool_result' && block.tool_use_id) {
              const completedToolId = block.tool_use_id;
              const completedToolName = agent.activeToolNames.get(completedToolId);

              // Detect background agent launches — keep the tool alive until queue-operation
              if (
                (completedToolName === 'Task' || completedToolName === 'Agent') &&
                isAsyncAgentResult(block)
              ) {
                console.log(
                  `[Pixel Agents] Agent ${agentId} background agent launched: ${completedToolId}`,
                );
                agent.backgroundAgentToolIds.add(completedToolId);
                continue; // don't mark as done yet
              }

              console.log(
                `[Pixel Agents] JSONL: Agent ${agentId} - tool done: ${block.tool_use_id}`,
              );
              // If the completed tool was a Task/Agent, clear its subagent tools
              if (completedToolName === 'Task' || completedToolName === 'Agent') {
                agent.activeSubagentToolIds.delete(completedToolId);
                agent.activeSubagentToolNames.delete(completedToolId);
                webview?.postMessage({
                  type: 'subagentClear',
                  id: agentId,
                  parentToolId: completedToolId,
                });
              }
              agent.activeToolIds.delete(completedToolId);
              agent.activeToolStatuses.delete(completedToolId);
              agent.activeToolNames.delete(completedToolId);
              // Send agentToolDone when hooks are off, or for Task/Agent tools
              // (which always use JSONL path for consistent sub-agent lifecycle).
              const isCompletedAgentTool =
                completedToolName === 'Task' || completedToolName === 'Agent';
              if (!agent.hookDelivered || isCompletedAgentTool) {
                const toolId = completedToolId;
                setTimeout(() => {
                  webview?.postMessage({
                    type: 'agentToolDone',
                    id: agentId,
                    toolId,
                  });
                }, TOOL_DONE_DELAY_MS);
              }
            }
          }
          // All tools completed — allow text-idle timer as fallback
          // for turn-end detection when turn_duration is not emitted
          if (agent.activeToolIds.size === 0) {
            agent.hadToolsInTurn = false;
          }
        } else {
          // New user text prompt — new turn starting
          cancelWaitingTimer(agentId, waitingTimers);
          clearAgentActivity(agent, agentId, permissionTimers, webview);
          agent.hadToolsInTurn = false;
        }
      } else if (typeof content === 'string' && content.trim()) {
        // New user text prompt — new turn starting
        cancelWaitingTimer(agentId, waitingTimers);
        clearAgentActivity(agent, agentId, permissionTimers, webview);
        agent.hadToolsInTurn = false;
      }
    } else if (record.type === 'queue-operation' && record.operation === 'enqueue') {
      // Background agent completed — parse tool-use-id from XML content
      const content = record.content as string | undefined;
      if (content) {
        const toolIdMatch = content.match(/<tool-use-id>(.*?)<\/tool-use-id>/);
        if (toolIdMatch) {
          const completedToolId = toolIdMatch[1];
          if (agent.backgroundAgentToolIds.has(completedToolId)) {
            console.log(
              `[Pixel Agents] Agent ${agentId} background agent done: ${completedToolId}`,
            );
            agent.backgroundAgentToolIds.delete(completedToolId);
            agent.activeSubagentToolIds.delete(completedToolId);
            agent.activeSubagentToolNames.delete(completedToolId);
            webview?.postMessage({
              type: 'subagentClear',
              id: agentId,
              parentToolId: completedToolId,
            });
            agent.activeToolIds.delete(completedToolId);
            agent.activeToolStatuses.delete(completedToolId);
            agent.activeToolNames.delete(completedToolId);
            if (!agent.hookDelivered) {
              const toolId = completedToolId;
              setTimeout(() => {
                webview?.postMessage({
                  type: 'agentToolDone',
                  id: agentId,
                  toolId,
                });
              }, TOOL_DONE_DELAY_MS);
            }
          }
        }
      }
    } else if (record.type === 'system' && record.subtype === 'turn_duration') {
      cancelWaitingTimer(agentId, waitingTimers);
      cancelPermissionTimer(agentId, permissionTimers);

      // Definitive turn-end: clean up any stale tool state, but preserve background agents.
      // When hooks are active, the Stop hook already handled the status change,
      // but we still perform state cleanup here as a safety net.
      const hasForegroundTools = agent.activeToolIds.size > agent.backgroundAgentToolIds.size;
      if (hasForegroundTools) {
        // Remove only non-background tool state
        for (const toolId of agent.activeToolIds) {
          if (agent.backgroundAgentToolIds.has(toolId)) continue;
          agent.activeToolIds.delete(toolId);
          agent.activeToolStatuses.delete(toolId);
          const toolName = agent.activeToolNames.get(toolId);
          agent.activeToolNames.delete(toolId);
          if (toolName === 'Task' || toolName === 'Agent') {
            agent.activeSubagentToolIds.delete(toolId);
            agent.activeSubagentToolNames.delete(toolId);
          }
        }
        if (!agent.hookDelivered) {
          webview?.postMessage({ type: 'agentToolsClear', id: agentId });
        }
        // Re-send background agent tools so webview keeps their sub-agents alive
        for (const toolId of agent.backgroundAgentToolIds) {
          const status = agent.activeToolStatuses.get(toolId);
          const toolName = agent.activeToolNames.get(toolId);
          if (status) {
            webview?.postMessage({
              type: 'agentToolStart',
              id: agentId,
              toolId,
              status,
              toolName,
            });
          }
        }
      } else if (agent.activeToolIds.size > 0 && agent.backgroundAgentToolIds.size === 0) {
        agent.activeToolIds.clear();
        agent.activeToolStatuses.clear();
        agent.activeToolNames.clear();
        agent.activeSubagentToolIds.clear();
        agent.activeSubagentToolNames.clear();
        if (!agent.hookDelivered) {
          webview?.postMessage({ type: 'agentToolsClear', id: agentId });
        }
      }

      agent.isWaiting = true;
      agent.permissionSent = false;
      agent.hadToolsInTurn = false;
      // Skip status post when hooks already handled it
      if (!agent.hookDelivered) {
        webview?.postMessage({
          type: 'agentStatus',
          id: agentId,
          status: 'waiting',
        });
      }
    } else if (record.type && !agent.seenUnknownRecordTypes.has(record.type)) {
      // Log first occurrence of unrecognized record types to help diagnose issues
      // where the runtime changes JSONL format. Known types we intentionally skip:
      // file-history-snapshot, queue-operation (non-enqueue), etc.
      const knownSkippableTypes = new Set(['file-history-snapshot', 'system', 'queue-operation']);
      if (!knownSkippableTypes.has(record.type)) {
        agent.seenUnknownRecordTypes.add(record.type);
        if (debug) {
          console.log(
            `[Pixel Agents] JSONL: Agent ${agentId} - unrecognized record type '${record.type}'. ` +
              `Keys: ${Object.keys(record).join(', ')}`,
          );
        }
      }
    }
  } catch {
    // Ignore malformed lines
  }
}

function getPayload(record: Record<string, unknown>): Record<string, unknown> | null {
  if (typeof record.payload === 'object' && record.payload !== null) {
    return record.payload as Record<string, unknown>;
  }
  return record;
}

function parseCodexInput(input: unknown): Record<string, unknown> {
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input) as unknown;
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return { input };
    }
  }
  if (typeof input === 'object' && input !== null) {
    return input as Record<string, unknown>;
  }
  return {};
}

function isCodexRecord(record: Record<string, unknown>, payload: Record<string, unknown>): boolean {
  return (
    record.type === 'session_meta' ||
    record.type === 'turn_context' ||
    record.type === 'event_msg' ||
    record.type === 'response_item' ||
    typeof payload.type === 'string'
  );
}

function processCodexTranscriptRecord(
  agentId: number,
  record: Record<string, unknown>,
  agents: Map<number, AgentState>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  webview: vscode.Webview | undefined,
): boolean {
  const payload = getPayload(record);
  if (!payload || !isCodexRecord(record, payload)) return false;

  const agent = agents.get(agentId);
  if (!agent) return true;

  if (record.type === 'session_meta') {
    if (typeof payload.id === 'string') {
      agent.sessionId = payload.id;
    } else if (typeof record.id === 'string') {
      agent.sessionId = record.id;
    }
    if (typeof payload.cwd === 'string') {
      agent.cwd = payload.cwd;
    } else if (typeof record.cwd === 'string') {
      agent.cwd = record.cwd;
    }
    return true;
  }

  const payloadType = payload.type;
  if (typeof payloadType !== 'string') return true;

  switch (payloadType) {
    case 'task_started':
    case 'user_message':
      cancelWaitingTimer(agentId, waitingTimers);
      clearAgentActivity(agent, agentId, permissionTimers, webview);
      agent.hadToolsInTurn = false;
      return true;

    case 'message': {
      const role = payload.role;
      if (role === 'user') {
        cancelWaitingTimer(agentId, waitingTimers);
        clearAgentActivity(agent, agentId, permissionTimers, webview);
        agent.hadToolsInTurn = false;
      } else if (role === 'assistant' && !agent.hadToolsInTurn && !agent.hookDelivered) {
        startWaitingTimer(agentId, TEXT_IDLE_DELAY_MS, agents, waitingTimers, webview);
      }
      return true;
    }

    case 'function_call':
    case 'custom_tool_call': {
      const rawName = typeof payload.name === 'string' ? payload.name : '';
      const callId =
        typeof payload.call_id === 'string' ? payload.call_id : `${rawName}-${Date.now()}`;
      const input = parseCodexInput(payload.arguments ?? payload.input);
      startCodexTool(
        agentId,
        agent,
        rawName,
        callId,
        input,
        agents,
        waitingTimers,
        permissionTimers,
        webview,
      );
      return true;
    }

    case 'function_call_output':
    case 'custom_tool_call_output': {
      const callId = typeof payload.call_id === 'string' ? payload.call_id : undefined;
      if (callId) {
        const toolName = agent.activeToolNames.get(callId);
        if (toolName === 'close_agent') {
          const target = agent.pendingCloseAgentTargets.get(callId);
          if (target) {
            removeSpawnedCodexAgent(agentId, agent, [target], webview);
          }
          agent.pendingCloseAgentTargets.delete(callId);
        }
        finishCodexTool(agentId, agent, callId, webview);
      }
      return true;
    }

    case 'exec_command_end':
    case 'patch_apply_end':
    case 'collab_waiting_end': {
      const callId = typeof payload.call_id === 'string' ? payload.call_id : undefined;
      if (callId) {
        finishCodexTool(agentId, agent, callId, webview);
      }
      return true;
    }

    case 'collab_agent_spawn_end':
      registerSpawnedCodexAgent(agentId, agent, payload, webview);
      return true;

    case 'collab_close_end': {
      const callId = typeof payload.call_id === 'string' ? payload.call_id : undefined;
      removeSpawnedCodexAgent(
        agentId,
        agent,
        [
          payload.receiver_thread_id,
          payload.receiver_agent_nickname,
          payload.receiver_agent_role,
          callId ? agent.pendingCloseAgentTargets.get(callId) : undefined,
        ],
        webview,
      );
      if (callId) {
        agent.pendingCloseAgentTargets.delete(callId);
        finishCodexTool(agentId, agent, callId, webview);
      }
      return true;
    }

    case 'token_count': {
      const info = payload.info as
        | { input_tokens?: number; output_tokens?: number; total?: number }
        | null
        | undefined;
      if (info) {
        if (typeof info.input_tokens === 'number') agent.inputTokens += info.input_tokens;
        if (typeof info.output_tokens === 'number') agent.outputTokens += info.output_tokens;
        webview?.postMessage({
          type: 'agentTokenUsage',
          id: agentId,
          inputTokens: agent.inputTokens,
          outputTokens: agent.outputTokens,
        });
      }
      return true;
    }

    case 'task_complete':
      completeCodexTurn(agentId, agent, waitingTimers, permissionTimers, webview);
      return true;

    case 'agent_message':
    case 'reasoning':
    case 'thread_name_updated':
    case 'context_compacted':
      return true;

    default:
      return true;
  }
}

function startCodexTool(
  agentId: number,
  agent: AgentState,
  rawName: string,
  callId: string,
  input: Record<string, unknown>,
  agents: Map<number, AgentState>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  webview: vscode.Webview | undefined,
): void {
  const toolName = normalizeCodexToolName(rawName);
  const status = formatToolStatus(rawName, input);

  cancelWaitingTimer(agentId, waitingTimers);
  agent.isWaiting = false;
  agent.hadToolsInTurn = true;
  agent.activeToolIds.add(callId);
  agent.activeToolStatuses.set(callId, status);
  agent.activeToolNames.set(callId, toolName);
  if (rawName === 'close_agent') {
    const target = input.target;
    if (typeof target === 'string' && target.trim()) {
      agent.pendingCloseAgentTargets.set(callId, target);
    }
  }

  webview?.postMessage({ type: 'agentStatus', id: agentId, status: 'active' });
  webview?.postMessage({
    type: 'agentToolStart',
    id: agentId,
    toolId: callId,
    status,
    toolName,
    permissionActive: agent.permissionSent,
  });

  if (!PERMISSION_EXEMPT_TOOLS.has(toolName) && !agent.hookDelivered && !agent.leadAgentId) {
    startPermissionTimer(agentId, agents, permissionTimers, PERMISSION_EXEMPT_TOOLS, webview);
  }
}

function finishCodexTool(
  agentId: number,
  agent: AgentState,
  callId: string,
  webview: vscode.Webview | undefined,
): void {
  if (!agent.activeToolIds.has(callId)) return;

  if (agent.backgroundAgentToolIds.has(callId)) {
    setTimeout(() => {
      webview?.postMessage({
        type: 'agentToolDone',
        id: agentId,
        toolId: callId,
      });
    }, TOOL_DONE_DELAY_MS);
    return;
  }

  const completedToolName = agent.activeToolNames.get(callId);
  if (completedToolName === 'Task' || completedToolName === 'Agent') {
    agent.activeSubagentToolIds.delete(callId);
    agent.activeSubagentToolNames.delete(callId);
    webview?.postMessage({
      type: 'subagentClear',
      id: agentId,
      parentToolId: callId,
    });
  }

  agent.activeToolIds.delete(callId);
  agent.activeToolStatuses.delete(callId);
  agent.activeToolNames.delete(callId);

  setTimeout(() => {
    webview?.postMessage({
      type: 'agentToolDone',
      id: agentId,
      toolId: callId,
    });
  }, TOOL_DONE_DELAY_MS);

  if (agent.activeToolIds.size === 0) {
    agent.hadToolsInTurn = false;
  }
}

function registerSpawnedCodexAgent(
  agentId: number,
  agent: AgentState,
  payload: Record<string, unknown>,
  webview: vscode.Webview | undefined,
): void {
  const parentToolId = typeof payload.call_id === 'string' ? payload.call_id : undefined;
  if (!parentToolId) return;

  const childThreadId =
    typeof payload.new_thread_id === 'string' ? payload.new_thread_id.trim() : '';
  if (!childThreadId) return;

  const label =
    typeof payload.new_agent_nickname === 'string' && payload.new_agent_nickname.trim()
      ? payload.new_agent_nickname
      : typeof payload.new_agent_role === 'string'
        ? payload.new_agent_role
        : 'Agent';
  const status = `Subtask: ${label}`;

  if (!agent.activeToolIds.has(parentToolId)) {
    agent.activeToolIds.add(parentToolId);
    agent.activeToolStatuses.set(parentToolId, status);
    agent.activeToolNames.set(parentToolId, 'Agent');
    webview?.postMessage({
      type: 'agentToolStart',
      id: agentId,
      toolId: parentToolId,
      status,
      toolName: 'Agent',
      permissionActive: agent.permissionSent,
    });
  } else {
    agent.activeToolStatuses.set(parentToolId, status);
  }

  agent.backgroundAgentToolIds.add(parentToolId);
  rememberSpawnedAgent(agent, parentToolId, [
    childThreadId,
    payload.new_agent_nickname,
    payload.new_agent_role,
  ]);

  setTimeout(() => {
    webview?.postMessage({
      type: 'agentToolDone',
      id: agentId,
      toolId: parentToolId,
    });
  }, TOOL_DONE_DELAY_MS);
}

function removeSpawnedCodexAgent(
  agentId: number,
  agent: AgentState,
  identifiers: unknown[],
  webview: vscode.Webview | undefined,
): void {
  const parentToolId = findSpawnedAgentToolId(agent, identifiers);
  if (!parentToolId) return;

  forgetSpawnedAgent(agent, parentToolId);
  agent.backgroundAgentToolIds.delete(parentToolId);
  agent.activeToolIds.delete(parentToolId);
  agent.activeToolStatuses.delete(parentToolId);
  agent.activeToolNames.delete(parentToolId);
  agent.activeSubagentToolIds.delete(parentToolId);
  agent.activeSubagentToolNames.delete(parentToolId);

  webview?.postMessage({
    type: 'subagentClear',
    id: agentId,
    parentToolId,
  });
  webview?.postMessage({
    type: 'agentToolDone',
    id: agentId,
    toolId: parentToolId,
  });
}

function completeCodexTurn(
  agentId: number,
  agent: AgentState,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  webview: vscode.Webview | undefined,
): void {
  cancelWaitingTimer(agentId, waitingTimers);
  cancelPermissionTimer(agentId, permissionTimers);

  if (agent.backgroundAgentToolIds.size > 0) {
    for (const toolId of [...agent.activeToolIds]) {
      if (agent.backgroundAgentToolIds.has(toolId)) continue;
      agent.activeToolIds.delete(toolId);
      agent.activeToolStatuses.delete(toolId);
      agent.activeToolNames.delete(toolId);
      agent.activeSubagentToolIds.delete(toolId);
      agent.activeSubagentToolNames.delete(toolId);
    }
    for (const callId of [...agent.pendingCloseAgentTargets.keys()]) {
      if (!agent.activeToolIds.has(callId)) {
        agent.pendingCloseAgentTargets.delete(callId);
      }
    }
    webview?.postMessage({ type: 'agentToolsClear', id: agentId });
    for (const toolId of agent.backgroundAgentToolIds) {
      const status = agent.activeToolStatuses.get(toolId);
      const toolName = agent.activeToolNames.get(toolId);
      if (status) {
        webview?.postMessage({
          type: 'agentToolStart',
          id: agentId,
          toolId,
          status,
          toolName,
        });
      }
    }
  } else {
    agent.activeToolIds.clear();
    agent.activeToolStatuses.clear();
    agent.activeToolNames.clear();
    agent.activeSubagentToolIds.clear();
    agent.activeSubagentToolNames.clear();
    agent.spawnedAgentToolIds.clear();
    agent.pendingCloseAgentTargets.clear();
    webview?.postMessage({ type: 'agentToolsClear', id: agentId });
  }

  agent.isWaiting = true;
  agent.permissionSent = false;
  agent.hadToolsInTurn = false;
  webview?.postMessage({
    type: 'agentStatus',
    id: agentId,
    status: 'waiting',
  });
}

function processProgressRecord(
  agentId: number,
  record: Record<string, unknown>,
  agents: Map<number, AgentState>,
  _waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  webview: vscode.Webview | undefined,
): void {
  const agent = agents.get(agentId);
  if (!agent) return;

  const parentToolId = record.parentToolUseID as string | undefined;
  if (!parentToolId) return;

  const data = record.data as Record<string, unknown> | undefined;
  if (!data) return;

  // bash_progress / mcp_progress: tool is actively executing, not stuck on permission.
  // Restart the permission timer to give the running tool another window.
  // Skip when hooks are active — Notification hook handles permission detection exactly.
  const dataType = data.type as string | undefined;
  if (dataType === 'bash_progress' || dataType === 'mcp_progress') {
    if (agent.activeToolIds.has(parentToolId) && !agent.hookDelivered && !agent.leadAgentId) {
      startPermissionTimer(agentId, agents, permissionTimers, PERMISSION_EXEMPT_TOOLS, webview);
    }
    return;
  }

  // Verify parent is an active Task/Agent tool (agent_progress handling)
  const parentToolName = agent.activeToolNames.get(parentToolId);
  if (parentToolName !== 'Task' && parentToolName !== 'Agent') return;

  const msg = data.message as Record<string, unknown> | undefined;
  if (!msg) return;

  const msgType = msg.type as string;
  const innerMsg = msg.message as Record<string, unknown> | undefined;
  const content = innerMsg?.content;
  if (!Array.isArray(content)) return;

  if (msgType === 'assistant') {
    let hasNonExemptSubTool = false;
    for (const block of content) {
      if (block.type === 'tool_use' && block.id) {
        const toolName = block.name || '';
        const status = formatToolStatus(toolName, block.input || {});
        console.log(
          `[Pixel Agents] Agent ${agentId} subagent tool start: ${block.id} ${status} (parent: ${parentToolId})`,
        );

        // Track sub-tool IDs
        let subTools = agent.activeSubagentToolIds.get(parentToolId);
        if (!subTools) {
          subTools = new Set();
          agent.activeSubagentToolIds.set(parentToolId, subTools);
        }
        subTools.add(block.id);

        // Track sub-tool names (for permission checking)
        let subNames = agent.activeSubagentToolNames.get(parentToolId);
        if (!subNames) {
          subNames = new Map();
          agent.activeSubagentToolNames.set(parentToolId, subNames);
        }
        subNames.set(block.id, toolName);

        if (!PERMISSION_EXEMPT_TOOLS.has(toolName)) {
          hasNonExemptSubTool = true;
        }

        webview?.postMessage({
          type: 'subagentToolStart',
          id: agentId,
          parentToolId,
          toolId: block.id,
          status,
        });
      }
    }
    if (hasNonExemptSubTool && !agent.hookDelivered) {
      startPermissionTimer(agentId, agents, permissionTimers, PERMISSION_EXEMPT_TOOLS, webview);
    }
  } else if (msgType === 'user') {
    for (const block of content) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        console.log(
          `[Pixel Agents] Agent ${agentId} subagent tool done: ${block.tool_use_id} (parent: ${parentToolId})`,
        );

        // Remove from tracking
        const subTools = agent.activeSubagentToolIds.get(parentToolId);
        if (subTools) {
          subTools.delete(block.tool_use_id);
        }
        const subNames = agent.activeSubagentToolNames.get(parentToolId);
        if (subNames) {
          subNames.delete(block.tool_use_id);
        }

        const toolId = block.tool_use_id;
        setTimeout(() => {
          webview?.postMessage({
            type: 'subagentToolDone',
            id: agentId,
            parentToolId,
            toolId,
          });
        }, 300);
      }
    }
    // If there are still active non-exempt sub-agent tools, restart the permission timer
    // (handles the case where one sub-agent completes but another is still stuck)
    let stillHasNonExempt = false;
    for (const [, subNames] of agent.activeSubagentToolNames) {
      for (const [, toolName] of subNames) {
        if (!PERMISSION_EXEMPT_TOOLS.has(toolName)) {
          stillHasNonExempt = true;
          break;
        }
      }
      if (stillHasNonExempt) break;
    }
    if (stillHasNonExempt && !agent.hookDelivered) {
      startPermissionTimer(agentId, agents, permissionTimers, PERMISSION_EXEMPT_TOOLS, webview);
    }
  }
}

/**
 * Link teammates within the same team.
 * The lead is the agent with no agentName (or the first one detected in the team).
 * Teammates get leadAgentId pointing to the lead.
 */
function linkTeammates(_agentId: number, agent: AgentState, agents: Map<number, AgentState>): void {
  const teamName = agent.teamName;
  if (!teamName) return;

  // Find all agents in this team
  const teamAgents: AgentState[] = [];
  for (const a of agents.values()) {
    if (a.teamName === teamName) {
      teamAgents.push(a);
    }
  }

  // Determine lead: always prefer the agent WITHOUT agentName (the real lead has agentName=null).
  // This handles the case where a teammate is detected first and temporarily marked as lead,
  // then the real lead joins later.
  let lead: AgentState | undefined;
  for (const a of teamAgents) {
    if (!a.agentName) {
      lead = a;
      break;
    }
  }
  if (!lead) {
    // No agent without agentName -- use existing isTeamLead or first agent
    for (const a of teamAgents) {
      if (a.isTeamLead) {
        lead = a;
        break;
      }
    }
  }
  if (!lead) {
    lead = teamAgents[0];
  }

  // Update all team members: mark lead, clear stale lead flags, link teammates
  for (const a of teamAgents) {
    if (a.id === lead.id) {
      a.isTeamLead = true;
      a.leadAgentId = undefined;
    } else {
      a.isTeamLead = false;
      a.leadAgentId = lead.id;
    }
  }
}

/** Check if a tool_result block indicates an async/background agent launch */
function isAsyncAgentResult(block: Record<string, unknown>): boolean {
  const content = block.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (
        typeof item === 'object' &&
        item !== null &&
        typeof (item as Record<string, unknown>).text === 'string' &&
        ((item as Record<string, unknown>).text as string).startsWith(
          'Async agent launched successfully.',
        )
      ) {
        return true;
      }
    }
  } else if (typeof content === 'string') {
    return content.startsWith('Async agent launched successfully.');
  }
  return false;
}
