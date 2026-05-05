---
name: auth-billing-security
description: Review paid SaaS authentication, sessions, subscriptions, entitlements, and webhooks.
---

## Required context

Before acting:

1. Read `AGENTS.md`.
2. Read `docs/ai-project-memory/00-project-index.md`.
3. Read the current branch memory file if one exists.
4. Inspect actual repository files before making conclusions.

## Workflow

1. Map auth provider, session mechanism, user model, role model, and tenant boundaries.
2. Map billing provider, checkout, customer mapping, subscription records, webhook handlers, and entitlements.
3. Verify server-side plan enforcement for every paid feature.
4. Verify webhook signature checking, idempotency, event ordering, and replay behavior.
5. Add or recommend tests for wrong-user, canceled-subscription, invalid signature, duplicate event, downgrade, and failed payment.
6. Update `05-auth-billing-model.md`.

## Output

Return critical issues first, then required tests and docs updated.
