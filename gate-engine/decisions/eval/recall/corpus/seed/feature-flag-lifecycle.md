---
slug: feature-flag-lifecycle
created: 2026-01-01
---

# feature-flag-lifecycle

## Target · 2026-05-20 — A flag that has been fully rolled out for 30 days is deleted, not kept

**Context:** Dead flags accumulated until nobody could tell which branches were reachable; two incidents traced to a stale flag.
**Ruling:** A flag fully rolled out for 30 days is deleted along with its dead branch. The rollout tool refuses to create a flag without an owner and an expiry.
**Consequences:**
- Positive: the failure above stops recurring.
- Negative: a cost is knowingly paid here.
**Vision-fit:** n/a — internal tooling.
**Scope:** src/flags/**
**Source:** seed
