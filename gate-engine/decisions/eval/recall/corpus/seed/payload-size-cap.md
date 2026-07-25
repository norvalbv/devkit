---
slug: payload-size-cap
created: 2026-01-01
---

# payload-size-cap

## 2026-01-10 — Inbound payloads are capped at 1 MiB and rejected with 413

**Ruling:** Inbound payloads are capped at 1 MiB and rejected with 413
**Why / target:** Unbounded bodies let a single client exhaust memory; the cap is enforced at the edge before parsing.
**Source:** seed
