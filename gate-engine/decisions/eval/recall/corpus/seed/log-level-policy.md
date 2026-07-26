---
slug: log-level-policy
created: 2026-01-01
---

# log-level-policy

## 2026-01-14 — Production emits WARN and ERROR only; INFO requires a per-service override

**Ruling:** Production services emit only WARN and ERROR by default. INFO logging is opt-in via an explicit override flag declared in the service's deploy manifest; DEBUG stays disabled outside local and staging environments regardless of any override.
**Why / target:** Full INFO logging across every service saturated the shared ingestion pipeline during a traffic spike; the resulting indexing lag hid a cascading dependency failure for three hours before a customer report surfaced it.
**Source:** seed
- 2026-02-10 — Added a standing exception for the payments service: WARN-only logs could not reconstruct a disputed-charge timeline during an audit, so its INFO override is now permanent rather than a temporary toggle.
