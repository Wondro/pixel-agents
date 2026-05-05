---
name: branch-diff-memory
description: Create or update branch-specific memory and consolidate merged branch memory into main.
---

## Required context

Before acting:

1. Read `AGENTS.md`.
2. Read `docs/ai-project-memory/00-project-index.md`.
3. Read the current branch memory file if one exists.
4. Inspect actual repository files before making conclusions.

## Workflow

1. Detect current branch.
2. If branch is not `main`, create/update `docs/ai-project-memory/branches/<branch>.md`.
3. Capture `git diff --stat main...HEAD` and important file changes.
4. Summarize features, systems changed, tests, and auth/billing/security impact.
5. If branch is `main`, identify merged branch docs, consolidate durable notes into main memory, then remove only confirmed merged branch docs.

## Optional deterministic helper

Run:

```bash
python .codex/scripts/branch_memory_refresh.py
```

Then manually refine the docs.
