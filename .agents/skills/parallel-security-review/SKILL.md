---
name: parallel-security-review
description: Run independent parallel security reviews for appsec, auth/billing, and infra/dependencies.
---

## Required context

Before acting:

1. Read `AGENTS.md`.
2. Read `docs/ai-project-memory/00-project-index.md`.
3. Read the current branch memory file if one exists.
4. Inspect actual repository files before making conclusions.

## Workflow

Spawn these agents in parallel:

- `security_appsec`
- `security_auth_billing`
- `security_infra_dependencies`

Rules:

1. Each reviewer works independently.
2. Prioritize exploitable findings.
3. Treat auth bypass, tenant data leak, billing bypass, secret exposure, and data loss as release blockers.
4. Require tests or verification for fixes.
5. Update `03-security-model.md` and branch memory.

## Output

Return:

- release blockers
- high/medium/low findings
- exploit sketch or abuse case
- remediation
- required tests
