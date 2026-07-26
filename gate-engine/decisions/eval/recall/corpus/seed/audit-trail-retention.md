---
slug: audit-trail-retention
created: 2026-01-01
---

# audit-trail-retention

## Target · 2026-03-22 — Audit trail entries are retained for 7 years, immutable after write

**Context:** A compliance audit asked for access-log records from eighteen months earlier, and they no longer existed: the default 90-day log-rotation policy had already purged them along with ordinary operational logs, leaving no way to show who had accessed a specific customer record.
**Ruling:** Audit trail entries — authentication events, permission grants, and data access — are written to storage that is separate from the general operational log pipeline, retained for 7 years, and immutable once written. They are exempt from the standard log-rotation TTL that governs everything else.
**Consequences:**
- Positive: the compliance gap above — records purged before anyone asked for them — cannot recur.
- Negative: meaningfully higher storage cost and a second retention pipeline to operate and maintain outside the standard logging stack.
**Vision-fit:** n/a — internal tooling.
**Scope:** src/audit/**
**Source:** seed

- 2026-06-11 — Legal counsel narrowed the scope of the obligation: the 7-year requirement only covers privileged-action records — auth events, permission grants, and access to regulated data. Ordinary read-traffic audit entries that don't touch regulated data revert to the standard 90-day rotation, since counsel confirmed only the privileged-action subset carries a retention obligation. This changes what "audit trail entries" above actually covers; it does not touch the 7-year duration or immutability for the records that remain in scope.
