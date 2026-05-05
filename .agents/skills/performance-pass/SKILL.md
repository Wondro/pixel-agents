---
name: performance-pass
description: Review performance-sensitive paths, queries, API latency, bundle size, and expensive SaaS operations.
---

## Required context

Before acting:

1. Read `AGENTS.md`.
2. Read `docs/ai-project-memory/00-project-index.md`.
3. Read the current branch memory file if one exists.
4. Inspect actual repository files before making conclusions.

## Workflow

1. Have `performance_engineer` identify hot paths.
2. Inspect queries, loops, API calls, client bundle/runtime costs, and background jobs.
3. Recommend targeted optimizations tied to evidence or likely scale.
4. Avoid premature optimization.
