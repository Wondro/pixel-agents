---
name: bug-repro-fix
description: Reproduce, isolate, fix, and verify a bug with regression tests.
---

## Required context

Before acting:

1. Read `AGENTS.md`.
2. Read `docs/ai-project-memory/00-project-index.md`.
3. Read the current branch memory file if one exists.
4. Inspect actual repository files before making conclusions.

## Workflow

1. Reproduce the bug or document why reproduction is unavailable.
2. Map the failing path.
3. Make the smallest fix.
4. Add regression tests.
5. Run tests.
6. Run targeted code/security review if auth, billing, data, or security is touched.
