---
name: test-plan-and-run
description: Build and run a test plan for changed SaaS code, including auth, billing, and wrong-user cases.
---

## Required context

Before acting:

1. Read `AGENTS.md`.
2. Read `docs/ai-project-memory/00-project-index.md`.
3. Read the current branch memory file if one exists.
4. Inspect actual repository files before making conclusions.

## Workflow

1. Have `qa_automation` inspect package scripts and CI config.
2. Identify unit, integration, e2e, lint, typecheck, and build commands.
3. Add or update tests for changed behavior.
4. Include negative tests for unauthorized users, wrong tenant/resource, invalid inputs, and plan limits.
5. Run the relevant commands and record exact results.
6. Update `04-testing-matrix.md`.

## Output

Return exact commands run, pass/fail status, failures, and remaining manual checks.
