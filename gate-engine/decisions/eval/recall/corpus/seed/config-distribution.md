---
slug: config-distribution
created: 2026-01-01
---

# config-distribution

## Target · 2026-03-01 — Configuration ships as a versioned package dependency

**Context:** Hand-copied config drifted between services and nobody could tell which version was live.
**Ruling:** Configuration ships as a versioned package dependency, resolved at build time.
**Consequences:**
- Positive: the failure above stops recurring.
- Negative: a cost is knowingly paid here.
**Vision-fit:** n/a — internal tooling.
**Scope:** src/config/**
**Source:** seed
