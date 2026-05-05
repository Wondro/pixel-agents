---
name: project-refresh
description: Refresh project memory, perform first-run intake, inventory systems, and consolidate merged branch memory.
---

## Required context

Before acting:

1. Read `AGENTS.md`.
2. Read `docs/ai-project-memory/00-project-index.md`.
3. Read the current branch memory file if one exists.
4. Inspect actual repository files before making conclusions.

## Workflow

1. Check current branch and current commit.
2. Run or emulate `.codex/scripts/project_inventory.py`.
3. If memory is not initialized, spawn fresh independent reviewers:
   - `code_reviewer_logic`
   - `code_reviewer_integration`
   - `code_reviewer_maintainability`
   - `security_appsec`
   - `security_auth_billing`
   - `security_infra_dependencies`
4. Populate or update all memory docs.
5. If on `main`, run or emulate `.codex/scripts/branch_memory_refresh.py` and consolidate merged branch docs.
6. Record commands, findings, and status in `07-agent-run-log.md`.

## Output

Return:

- branch and commit reviewed
- systems discovered
- docs updated
- reviewer/security findings
- unresolved risks
