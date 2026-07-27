---
slug: queue-dead-letter-routing
created: 2026-01-20
---

# queue-dead-letter-routing

## Target · 2026-02-01 — A poison message is routed to a per-queue dead-letter topic after three redeliveries

**Context:** A single malformed message was redelivered indefinitely, pinning a worker in a crash loop and starving every other message behind it in the same partition.
**Ruling:** The broker's own redelivery counter routes a message to `<queue>.dead-letter` after three failed deliveries instead of retrying forever.
**Consequences:**
- Positive: One bad message can no longer starve an entire partition.
- Negative: A message that would have succeeded on a fourth attempt (a transient dependency blip) now needs a manual replay from the dead-letter topic.
**Vision-fit:** n/a — internal queue infrastructure, no product-facing vision.
**Scope:** src/queue/**
**Category:** queue-infra
**Source:** manual
