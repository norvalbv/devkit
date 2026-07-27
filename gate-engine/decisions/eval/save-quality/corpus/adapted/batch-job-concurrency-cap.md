---
slug: batch-job-concurrency-cap
created: 2026-01-10
---

# batch-job-concurrency-cap

## Target · 2026-02-10 — Nightly batch jobs cap concurrency at four workers per host

**Context:** An unbounded batch job saturated a host's connection pool, starving the request-serving processes sharing the same box during the nightly run.
**Ruling:** Every batch job runner caps its own worker pool at four concurrent jobs per host, regardless of how many jobs are queued.
**Consequences:**
- Positive: A large batch run can no longer starve request-serving traffic on the same host.
- Negative: A backlog of many small jobs takes longer to drain than it would with unbounded concurrency.
**Vision-fit:** n/a
**Rejected:** n/a
**Source:** manual
- 2026-02-12 — Cap raised to six on the two hosts that run no request-serving processes.
- 2026-02-14 — **Amends:** note:2026-02-12 — Reverted to four everywhere; the exempted hosts turned out to share a connection pool with the API tier, so the exemption reintroduced the starvation it was meant to avoid.
