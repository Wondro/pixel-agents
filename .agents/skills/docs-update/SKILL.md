---
name: docs-update
description: Update project memory, developer docs, user docs, release notes, and runbooks after changes.
---

## Required context

Before acting:

1. Read `AGENTS.md`.
2. Read `docs/ai-project-memory/00-project-index.md`.
3. Read the current branch memory file if one exists.
4. Inspect actual repository files before making conclusions.

## Workflow

1. Have `docs_writer` identify docs affected by the change.
2. Update branch memory first.
3. Update main memory only for main or merged durable changes.
4. Keep docs concise and evidence-based.
5. Record verification in `07-agent-run-log.md`.
