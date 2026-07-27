---
slug: log-retention-window
created: 2026-01-01
---

# log-retention-window

## 2026-01-15 — Application logs retain for 30 days, audit logs for one year

**Why / target:** A storage-cost review found application debug logs accounted for most of the log-storage bill despite being read within the first 48 hours of an incident, if ever.
**Ruling:** Application logs expire after 30 days; audit logs (auth, permission changes, data export) expire after one year regardless of storage cost.
**Source:** manual
