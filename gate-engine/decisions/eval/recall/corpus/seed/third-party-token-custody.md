---
slug: third-party-token-custody
created: 2026-01-01
---

# third-party-token-custody

## Target · 2026-02-18 — Only the integration gateway holds third-party OAuth tokens

**Context:** Three separate internal services each kept their own copy of the same third-party payment provider's OAuth refresh token so they could call the provider directly. When that token turned up compromised, there was no way to tell which of the three had leaked it, and revoking it broke all three at once with no way to isolate the blast radius.
**Ruling:** Refresh tokens and other long-lived credentials for third-party integrations are custodied by exactly one integration-gateway service. Internal services never receive or persist the underlying third-party credential; instead they request short-lived, narrowly scoped access tokens from the gateway per call, and the gateway is the only thing that can revoke or rotate the underlying credential.
**Consequences:**
- Positive: a compromised third-party credential has exactly one place it could have come from, and one place to revoke it.
- Negative: the gateway becomes a hard dependency for every third-party call; an outage there stalls all of them at once instead of degrading one service at a time.
**Vision-fit:** n/a — internal tooling.
**Scope:** src/integrations/gateway/**
**Source:** seed
