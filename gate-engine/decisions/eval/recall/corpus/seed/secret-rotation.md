---
slug: secret-rotation
created: 2026-01-01
---

# secret-rotation

## Target · 2026-01-25 — Secrets rotate automatically every 30 days, no manual override

**Context:** A database credential issued to a contractor was still valid fourteen months after the contract ended, because rotation had been treated as something to do "when convenient." It surfaced during a post-incident review of an unrelated breach, not because anyone had been tracking it.
**Ruling:** All service and integration secrets — database credentials, signing keys, webhook secrets — are rotated automatically by the secrets manager on a fixed 30-day cycle. There is no manual "skip this cycle" path; a secret that is not rotated simply expires and stops authenticating, forcing whoever depends on it to notice immediately rather than months later.
**Consequences:**
- Positive: a forgotten credential cannot silently remain valid for over a year the way the contractor's did.
- Negative: on rotation day, any consumer that caches the old secret past its grace window gets an outage instead of a warning.
**Vision-fit:** n/a — internal tooling.
**Scope:** src/secrets/**
**Source:** seed

- 2026-05-19 — Hardware-backed signing keys are exempted from the 30-day cycle: rotating them requires a manual ceremony with a physical token, which cannot be automated or scheduled that tightly. Those keys rotate quarterly during a planned maintenance window instead. Every other secret class still follows the automatic 30-day cycle unchanged.
