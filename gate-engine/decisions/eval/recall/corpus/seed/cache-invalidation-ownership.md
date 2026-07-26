---
slug: cache-invalidation-ownership
created: 2026-01-01
---

# cache-invalidation-ownership

## Target · 2026-03-20 — Each cache key has exactly one owning service

**Context:** Two services both invalidated the same cache key on their own writes; a race between the two invalidations left a stale value cached for the rest of the TTL, and a customer saw a reverted balance for eleven minutes.
**Ruling:** Every cache key belongs to exactly one owning service, identified by a mandatory namespace prefix on the key (`<owner>:<entity>:<id>`). Only the owning service may write to or invalidate keys under its own prefix; any other service that needs the value requests it through the owner's API rather than writing the cache directly.
**Consequences:**
- Positive: a cache key can no longer be invalidated out from under the service that owns its source of truth.
- Negative: a service that needs another owner's cached value pays a network hop it could have avoided by writing the cache itself.
**Vision-fit:** n/a — internal tooling.
**Scope:** src/cache/**
**Source:** seed
