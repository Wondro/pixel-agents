/**
 * TeamProvider: optional extension on HookProvider for CLIs that support the
 * Lead + Teammates pattern.
 *
 * This interface only covers concepts that `HookProvider.normalizeHookEvent` +
 * `AgentEvent` don't already cover. Generic concepts (subagent start/end, tool
 * start/end, permission request, session lifecycle) belong on HookProvider.
 *
 * Providers without team support simply don't set `HookProvider.team`. No team-
 * gated code runs for them -- no stubs, no dead branches.
 */
export interface TeamProvider {
  /** CLI identifier (e.g. 'codex'). Used for logging. */
  providerId: string;

  /** Tool names that CAN spawn persistent teammates (fast-path gate only).
   *  Some CLIs use one tool for both teammates and basic subagents, so use
   *  `isTeammateSpawnCall(toolName, toolInput)` for the authoritative decision. */
  teammateSpawnTools: ReadonlySet<string>;

  /** Tool names that spawn within-turn, ephemeral subagents tied to a parent tool call.
   *  These produce negative-ID sub-agent characters in the webview. */
  withinTurnSubagentTools: ReadonlySet<string>;

  /** Authoritative predicate: does THIS SPECIFIC tool call spawn a persistent teammate?
   *  Depends on tool input flags, not just the tool name. Without this, we can't
   *  distinguish basic subagents from teammates when the same tool name is reused.
   *
   *  Depends on the active runtime's tool schema. */
  isTeammateSpawnCall(toolName: string, toolInput: Record<string, unknown>): boolean;

  /** Extract a teammate's identity (name) from a raw hook event payload (pre-normalization).
   *  Used to route TeammateIdle / TaskCompleted hooks to the specific teammate agent.
   *  Returns undefined if the provider event has no teammate identity. */
  extractTeammateNameFromEvent(event: Record<string, unknown>): string | undefined;

  /** Given a teammate's JSONL path, return the path to its sidecar metadata file.
   *  Usually `<file>.meta.json` for file-backed teammate metadata. */
  resolveTeammateMetadataPath(teammateJsonlFile: string): string;

  /** Parse the sidecar metadata contents and return the teammate's name.
   *  Returns null if invalid. */
  parseTeammateMetadata(metadataContents: string): string | null;

  /** Directory containing teammate JSONL files for the given lead session.
   *  Provider-defined path for file-backed teammate sessions. */
  resolveTeammateJsonlDir(projectDir: string, leadSessionId: string): string;

  /** Get the currently-active member names of a team. Source of truth for team membership.
   *  Returns the Set of names, or null if the team can't be read (team dissolved / no data).
   *
   *  Replaces the old split `resolveTeamConfigPath` + `parseTeamConfigMembers` pair so
   *  providers using API-driven team stores (not file-based) can implement without a path.
   *
   *  Providers can read a file, an API, or return null when no team source exists. */
  getTeamMembers(teamName: string): Set<string> | null;

  /** Extract team metadata from a transcript record (one parsed JSONL line).
   *  Used by transcriptParser to link teammates to their lead without hardcoding
   *  provider-specific field names in the shared parser.
   *
   *  Provider-defined transcript metadata fields. */
  extractTeamMetadataFromRecord(
    record: Record<string, unknown>,
  ): { teamName?: string; agentName?: string } | null;
}
