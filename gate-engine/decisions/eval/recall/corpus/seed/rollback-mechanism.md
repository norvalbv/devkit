---
slug: rollback-mechanism
created: 2026-01-01
---

# rollback-mechanism

## Target · 2026-03-22 — Rollback redeploys the prior artifact; it never reverts-and-rebuilds

**Context:** An on-call engineer mitigated an incident by reverting the bad commit and rebuilding from source; the rebuild silently picked up a dependency bump that had merged after the last deploy, and the "rollback" shipped a second, different bug in the same incident window.
**Ruling:** A rollback redeploys the exact artifact digest that was last known-good in the registry. Reverting a commit and rebuilding is not a rollback path, and the deploy tool refuses any rollback request that isn't pinned to a prior build's digest.
**Consequences:**
- Positive: a rollback undoes exactly what broke and nothing else.
- Negative: if the prior artifact has already been garbage-collected from the registry, rollback is blocked and the team is forced into a full rebuild in precisely the emergency where rollback was supposed to save time.
**Vision-fit:** n/a — internal tooling.
**Scope:** deploy/**, registry/**
**Source:** seed
- 2026-04-30 — Registry retention was extended from 7 to 30 days specifically so the last three known-good digests are always rollback-eligible; the garbage-collection failure mode above hasn't recurred since.
