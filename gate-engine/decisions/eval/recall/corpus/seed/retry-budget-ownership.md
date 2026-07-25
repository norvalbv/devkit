---
slug: retry-budget-ownership
created: 2026-01-01
---

# retry-budget-ownership

## Target · 2026-02-03 — Retries draw from a per-caller budget, never a per-call count

**Context:** Blanket per-call retries turned a partial outage into a retry storm that tripled load on the failing dependency.
**Ruling:** Retries draw from a per-caller token budget. When the budget is exhausted the call fails fast; no per-call retry counts anywhere.
**Consequences:**
- Positive: the failure above stops recurring.
- Negative: a cost is knowingly paid here.
**Vision-fit:** n/a — internal tooling.
**Scope:** src/http/**
**Source:** seed
