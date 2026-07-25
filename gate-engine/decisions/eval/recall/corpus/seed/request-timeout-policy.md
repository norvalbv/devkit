---
slug: request-timeout-policy
created: 2026-01-01
---

# request-timeout-policy

## Target · 2026-02-01 — Every inbound request carries a deadline

**Context:** Long-tail requests pinned worker threads until the pool starved; one slow dependency took the whole service down.
**Ruling:** Every inbound request carries an absolute deadline propagated to downstream calls. A handler that outlives it is cancelled, not queued.
**Consequences:**
- Positive: the failure above stops recurring.
- Negative: a cost is knowingly paid here.
**Vision-fit:** n/a — internal tooling.
**Scope:** src/http/**
**Source:** seed
