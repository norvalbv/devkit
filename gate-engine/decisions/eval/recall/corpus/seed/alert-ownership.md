---
slug: alert-ownership
created: 2026-01-01
---

# alert-ownership

## Target · 2026-03-22 — Every alert must declare an owning team before it can page

**Context:** An alert fired for a subsystem nobody on the paged rotation owned; three escalations and forty minutes passed before the right team was found, while the underlying condition kept degrading.
**Ruling:** Every alert definition must declare a single owning team at creation time as a validated field; the alerting system refuses to register an alert without a valid team identifier, and pages route directly to that team's rotation only, never to a shared or generic on-call catch-all.
**Consequences:**
- Positive: a page always lands with someone who can act on it immediately.
- Negative: alerts spanning genuinely shared infrastructure need an explicit owning team assigned anyway, even when the fit is imperfect.
**Vision-fit:** n/a — internal tooling.
**Scope:** src/alerting/**
**Source:** seed
