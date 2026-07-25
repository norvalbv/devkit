---
slug: backpressure-shedding
created: 2026-01-01
---

# backpressure-shedding

## Target · 2026-02-05 — Shed load at admission, not in the handler

**Context:** Queueing under overload made every request slow instead of failing some fast, so nothing recovered until traffic dropped.
**Ruling:** Overload is shed at admission with a 503 and a Retry-After. Handlers never queue; a request that is admitted is a request that runs.
**Consequences:**
- Positive: the failure above stops recurring.
- Negative: a cost is knowingly paid here.
**Vision-fit:** n/a — internal tooling.
**Scope:** src/http/**
**Source:** seed
