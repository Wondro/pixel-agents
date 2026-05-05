/**
 * Codex-specific hook constants.
 */

/** Output filename after esbuild compiles codex-hook.ts to CJS. */
export const CODEX_HOOK_SCRIPT_NAME = 'codex-hook.js';

/** Hook events to install in ~/.codex/hooks.json. */
export const CODEX_HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'Stop',
  'SubagentStart',
  'SubagentStop',
  'TeammateIdle',
  'TaskCompleted',
] as const;
