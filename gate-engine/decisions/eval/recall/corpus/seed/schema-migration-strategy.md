---
slug: schema-migration-strategy
created: 2026-01-01
---

# schema-migration-strategy

## Target · 2026-01-18 — Migrations are expand-then-contract, never in-place column rewrites

**Context:** An in-place column rename ran during a deploy, took a row lock on the orders table for 40 seconds, and dropped a batch of in-flight writes that paged on-call at 2am.
**Ruling:** Every schema change ships as an additive "expand" migration (new column or table, dual-written alongside the old one) that soaks in production for at least one full release cycle before a separate "contract" migration removes the old column. No migration may rewrite or drop a column that application code still reads or writes in the same deploy.
**Consequences:**
- Positive: a column change can no longer take a write lock on a live table during deploy.
- Negative: every rename or type change now takes two releases and a stretch of dual-write code instead of one.
**Vision-fit:** n/a — internal tooling.
**Scope:** src/db/migrations/**
**Source:** seed
- 2026-03-02 — Narrowed: the two-step rule exempts brand-new tables and columns with zero existing readers — those may still ship in a single migration since there is nothing to dual-write against.
