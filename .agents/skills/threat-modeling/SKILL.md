---
name: threat-modeling
description: Build or update a threat model for a SaaS feature, data flow, or integration.
---

## Required context

Before acting:

1. Read `AGENTS.md`.
2. Read `docs/ai-project-memory/00-project-index.md`.
3. Read the current branch memory file if one exists.
4. Inspect actual repository files before making conclusions.

## Workflow

1. Identify assets, actors, trust boundaries, and data flow.
2. Enumerate abuse cases.
3. Map current controls.
4. Identify missing controls and required tests.
5. Use `.codex/templates/threat-model-template.md`.
6. Update `03-security-model.md`.
