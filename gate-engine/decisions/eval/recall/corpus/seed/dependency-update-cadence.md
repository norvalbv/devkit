---
slug: dependency-update-cadence
created: 2026-01-01
---

# dependency-update-cadence

## 2026-01-28 — Dependency bumps are batched on a fixed two-week cadence

**Ruling:** All non-critical dependency updates are batched into a single PR every two weeks, opened by the bump bot on a fixed schedule, rather than applied ad hoc whenever a contributor happens to notice a new version.
**Why / target:** Ad hoc bumping meant some services went months without a single update while others updated several times a week, so nobody could say with confidence which version of anything was actually running, and diagnosing a regression meant first reconstructing a dependency timeline from scratch.
**Source:** seed
- 2026-02-11 — Carved out an exception: a dependency with a published CVE is bumped immediately, out of cadence, rather than waiting for the next two-week batch.
