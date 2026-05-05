---
name: devops-release-readiness
description: Review CI/CD, Docker, environment config, deployment, rollback, and observability for release readiness.
---

## Required context

Before acting:

1. Read `AGENTS.md`.
2. Read `docs/ai-project-memory/00-project-index.md`.
3. Read the current branch memory file if one exists.
4. Inspect actual repository files before making conclusions.

## Workflow

1. Have `devops_release` inspect build scripts, CI, Docker, deployment manifests, and env examples.
2. Confirm required env vars are documented but secrets are not exposed.
3. Verify migration order and rollback plan.
4. Check logging, monitoring, health checks, and production debug surfaces.
5. Update `06-release-checklist.md`.

## Output

Return go/no-go, blockers, rollback plan, and exact commands/results.
