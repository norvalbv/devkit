---
slug: read-replica-routing
created: 2026-01-01
---

# read-replica-routing

## Target · 2026-02-09 — Reads route to a replica only when the caller opts in per query

**Context:** A reporting job read from a replica that was 90 seconds behind primary and double-charged a batch of invoices that had already been marked paid on primary moments earlier.
**Ruling:** Replica routing is opt-in per query via an explicit `readFrom: 'replica'` flag on the query builder; the default connection always reads primary. Any code path that touches money, entitlement, or authorization state is prohibited from setting the flag under any circumstance.
**Consequences:**
- Positive: financially or security-sensitive reads can no longer see stale replica data by accident.
- Negative: reporting and analytics queries carry more primary load than a blanket replica-by-default policy would.
**Vision-fit:** n/a — internal tooling.
**Scope:** src/db/**
**Source:** seed
- 2026-04-30 — FALSIFIED in part: the opt-in flag alone did not stop the failure class. A session-affinity bug in the connection pool replayed a caller's later default-flagged reads through the same replica connection it had just opted into. Routing enforcement moved into the query builder itself, which now rejects a replica flag on any query touching a money or entitlement table regardless of what the caller passed; caller discipline is no longer the enforcement mechanism.
