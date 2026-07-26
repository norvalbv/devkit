---
slug: clock-source
created: 2026-01-01
---

# clock-source

## 2026-01-05 — Timestamps come from the system wall clock

**Ruling:** Timestamps come from the system wall clock, read at the point of use.
**Why / target:** Simplest available source; no extra plumbing to thread through call sites.
**Source:** seed
- 2026-01-08 — SUPERSEDED_BLOCK_MARKER: this note belongs to the retired wall-clock ruling.

## 2026-01-12 — All timestamps come from a monotonic source, never wall clock

**Ruling:** All timestamps come from a monotonic source, never wall clock.
**Why / target:** NTP steps produced negative durations in metrics and made latency histograms meaningless.
**Source:** seed
- 2026-02-02 — Backfilled the two remaining wall-clock call sites in the metrics exporter.
