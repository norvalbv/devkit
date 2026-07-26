---
slug: canary-vs-blue-green
created: 2026-01-01
---

# canary-vs-blue-green

## Target · 2026-04-09 — Production deploys are canaried in traffic-percentage steps, not flipped blue-green

**Context:** A blue-green flip sent 100% of traffic to the new version in a single step; the new version exhausted its connection pool only under full load, so the entire service went down instantly with no graduated exposure that could have caught it first.
**Ruling:** Production deploys move traffic in canary steps — 5% for 10 minutes, then 25%, then 50%, then 100% — each gated on error-rate and p99 latency staying within SLO before advancing to the next step. Blue-green's single-flip cutover is retained only for the narrow case of a schema-incompatible deploy, where any split of traffic between old and new would itself be unsafe.
**Consequences:**
- Positive: a bug that only shows up under load is caught at 5% of traffic instead of 100%.
- Negative: every deploy takes at least 30 minutes longer to fully roll out, even when the change is fine.
**Vision-fit:** n/a — internal tooling.
**Scope:** deploy/**
**Source:** seed
