---
slug: soft-vs-hard-delete
created: 2026-01-01
---

# soft-vs-hard-delete

## Target · 2026-01-25 — Deletes are soft (deleted_at) everywhere, no hard delete path

**Context:** A customer row was hard-deleted on request, and six weeks later a billing dispute needed that exact row to reconcile a disputed charge — it was unrecoverable.
**Ruling:** All deletes set a `deleted_at` timestamp and are excluded from default queries via a shared repository scope. No application code path is permitted to issue a SQL `DELETE` against a primary table; the only way a row leaves the database is through an explicitly reviewed, one-off operational script.
**Consequences:**
- Positive: a delete request is always recoverable up until someone deliberately purges it.
- Negative: every table accretes rows forever, and every query must remember to filter deleted_at or it will leak soft-deleted data.
**Vision-fit:** n/a — internal tooling.
**Scope:** src/db/**
**Source:** seed

## Target · 2026-05-11 — Soft-deleted rows past the retention window are hard-purged by a scheduled job

**Context:** Soft-deleted rows accumulated for over two years in the largest table, and a restore drill showed the nightly backup window could no longer complete before the next backup started — restore time had doubled in six months.
**Ruling:** Soft delete remains the immediate write path for every delete. A scheduled job now hard-deletes rows whose `deleted_at` is older than the retention window (default 400 days), after checking each row against an active legal-hold table. Application code still never issues a direct hard delete outside this job.
**Consequences:**
- Positive: table growth and backup/restore time are bounded again.
- Negative: any recovery workflow relying on "soft delete is forever" now has a hard deadline it must beat.
**Vision-fit:** n/a — internal tooling.
**Scope:** src/db/**
**Source:** seed
