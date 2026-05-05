---
name: database-migration-review
description: Review database schema and migrations for safety, tenancy, indexes, and rollback.
---

## Required context

Before acting:

1. Read `AGENTS.md`.
2. Read `docs/ai-project-memory/00-project-index.md`.
3. Read the current branch memory file if one exists.
4. Inspect actual repository files before making conclusions.

## Workflow

1. Have `database_engineer` inspect schema, migrations, ORM config, and query patterns.
2. Check tenant/user ownership columns and indexes.
3. Identify destructive migration risk and backfill needs.
4. Verify migration commands and test strategy.
5. Recommend rollback or remediation steps.
