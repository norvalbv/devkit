---
slug: backup-restore-testing
created: 2026-01-01
---

# backup-restore-testing

## 2026-02-16 — A full restore is executed against a scratch instance every week, not just backup-success checks

**Ruling:** A scheduled job restores the latest backup onto a scratch database instance once a week and runs a row-count and checksum comparison against production before the run is allowed to report success. A green backup-job status alone is never treated as evidence the backup is usable.
**Why / target:** A backup had reported "completed successfully" for months while a corrupted WAL segment silently made it unrestorable; the corruption was discovered only during a real incident, when the restore was actually needed and failed.
**Source:** seed
- 2026-05-02 — Complicated: the weekly restore catches data corruption but not silent schema drift between the backup and the current migration state. The restore job now also runs the full migration suite against the restored copy before declaring success, since a restorable-but-outdated backup is not actually a passing test.
