---
slug: webhook-retry-policy
created: 2026-01-01
---

# webhook-retry-policy

## Target · 2026-01-05 — Webhook retries back off exponentially, capped at five attempts

**Context:** A downstream outage caused a retry storm that amplified load on the failing service instead of relieving it, and the only way to stop it was a manual deploy that disabled delivery entirely.
**Ruling:** Webhook delivery retries with exponential backoff (1s, 2s, 4s, 8s, 16s) and gives up after five attempts, moving the payload to a dead-letter queue for manual replay.
**Consequences:**
- Positive: A failing downstream service degrades gracefully instead of being hammered by a retry storm during its own outage.
- Negative: A payload that would have succeeded on a sixth attempt now needs a manual replay from the dead-letter queue.
**Vision-fit:** Supports the platform's reliability-by-default goal for third-party integrations.
**Scope:** src/webhooks/**
**Source:** manual
