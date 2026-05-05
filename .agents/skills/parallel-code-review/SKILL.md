---
name: parallel-code-review
description: Run independent parallel code reviews for logic, integration, and maintainability.
---

## Required context

Before acting:

1. Read `AGENTS.md`.
2. Read `docs/ai-project-memory/00-project-index.md`.
3. Read the current branch memory file if one exists.
4. Inspect actual repository files before making conclusions.

## Workflow

Spawn these agents in parallel:

- `code_reviewer_logic`
- `code_reviewer_integration`
- `code_reviewer_maintainability`

Rules:

1. Each reviewer works independently.
2. Do not share summaries between reviewers until all have completed.
3. Consolidate duplicate findings.
4. Rank by severity and user/security impact.
5. Recommend tests or fixes.

## Output

Return a findings table:

- severity
- reviewer
- file/symbol
- issue
- evidence
- recommended fix
