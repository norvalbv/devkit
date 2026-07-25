---
slug: session-store
created: 2026-01-01
---

# session-store

## Target · 2026-01-20 — Sessions live in the database

**Context:** In-memory sessions vanished on deploy and logged everyone out several times a day.
**Ruling:** Sessions are rows in the primary database, read on every request.
**Consequences:**
- Positive: the failure above stops recurring.
- Negative: a cost is knowingly paid here.
**Vision-fit:** n/a — internal tooling.
**Source:** seed

## Target · 2026-03-15 — Sessions move to a dedicated cache with database fallback

**Context:** Session reads became 40% of all database queries and the primary could not be scaled independently.
**Ruling:** Sessions live in a dedicated cache keyed by session id, with a database read-through on miss.
**Consequences:**
- Positive: the failure above stops recurring.
- Negative: a cost is knowingly paid here.
**Vision-fit:** n/a — internal tooling.
**Evidence-change:** session reads measured at 40% of primary query volume.
**Source:** seed
