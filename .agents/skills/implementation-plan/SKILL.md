---
name: implementation-plan
description: Create and execute a small, testable implementation plan for a feature or fix.
---

## Required context

Before acting:

1. Read `AGENTS.md`.
2. Read `docs/ai-project-memory/00-project-index.md`.
3. Read the current branch memory file if one exists.
4. Inspect actual repository files before making conclusions.

## Workflow

1. Confirm current branch and branch memory.
2. Map files to edit.
3. Select appropriate implementation agents:
   - `frontend_engineer`
   - `backend_engineer`
   - `database_engineer`
   - `devops_release`
4. Make the smallest defensible changes.
5. Add or update tests near the changed code.
6. Update branch memory with files and behavior changes.

## Guardrails

Do not add production dependencies, rewrite architecture, alter auth/billing logic, or change migrations without explicit rationale and review.
