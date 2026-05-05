---
name: dependency-audit
description: Inspect package dependencies, scripts, lockfiles, and update risk.
---

## Required context

Before acting:

1. Read `AGENTS.md`.
2. Read `docs/ai-project-memory/00-project-index.md`.
3. Read the current branch memory file if one exists.
4. Inspect actual repository files before making conclusions.

## Workflow

1. Identify package managers and lockfiles.
2. Inspect package scripts for risky behavior.
3. Run available audit commands if safe and offline/online access allows.
4. Check outdated or vulnerable auth, payment, upload, markdown/html, image, crypto, and server packages.
5. Do not upgrade packages without explicit approval unless the task asks for it.
6. Update security model with dependency risks.
