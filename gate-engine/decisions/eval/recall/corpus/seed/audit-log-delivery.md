---
slug: audit-log-delivery
created: 2026-01-01
---

# audit-log-delivery

## Target · 2026-04-02 — Audit events are delivered synchronously before the response

**Context:** Audit gaps during incidents made after-the-fact review impossible; asynchronous delivery lost events on crash.
**Ruling:** Audit events are written synchronously and must commit before the handler responds, so a response implies an audit record.
**Consequences:**
- Positive: the failure above stops recurring.
- Negative: a cost is knowingly paid here.
**Vision-fit:** n/a — internal tooling.
**Scope:** src/audit/**
**Source:** seed
- 2026-04-19 — Synchronous delivery is PARKED: the audit sink has no transactional write path today, so there is nothing to commit against and the handler cannot block on it. Events are buffered in memory and lost on crash, which is exactly what the ruling forbids.
- 2026-05-06 — Still blocked on the sink; the transactional write path is unscheduled. Treat the synchronous guarantee as aspirational, not current behaviour.
