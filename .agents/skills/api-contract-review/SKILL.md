---
name: api-contract-review
description: Review API contracts between frontend/backend and third-party services.
---

## Required context

Before acting:

1. Read `AGENTS.md`.
2. Read `docs/ai-project-memory/00-project-index.md`.
3. Read the current branch memory file if one exists.
4. Inspect actual repository files before making conclusions.

## Workflow

1. Map request/response shapes, validation, auth middleware, and error codes.
2. Check frontend API clients against backend handlers.
3. Check third-party SDK/provider contracts.
4. Add tests for contract mismatches and error states.
