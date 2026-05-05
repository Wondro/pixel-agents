---
name: pr-prep
description: Prepare a PR summary with verification, risk, security/auth/billing impact, and docs updates.
---

## Required context

Before acting:

1. Read `AGENTS.md`.
2. Read `docs/ai-project-memory/00-project-index.md`.
3. Read the current branch memory file if one exists.
4. Inspect actual repository files before making conclusions.

## Workflow

1. Compare branch against main.
2. Summarize changed files and behavior.
3. Confirm tests/build/lint/typecheck results.
4. Summarize security/auth/billing impact.
5. Update branch memory.
6. Produce PR text using `.codex/templates/pr-template.md`.
