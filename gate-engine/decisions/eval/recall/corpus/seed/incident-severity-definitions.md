---
slug: incident-severity-definitions
created: 2026-01-01
---

# incident-severity-definitions

## Target · 2026-05-14 — Severity is computed from measured blast radius, never declared by a human

**Context:** Two teams paged an SEV1 for a single customer's misconfiguration, tying up the incident commander rotation for an hour, while a genuine multi-region outage sat at SEV3 for twenty minutes because no one wanted to be the one who called SEV1 on someone else's system.
**Ruling:** Incident severity is computed automatically from the triggering monitoring signal, not declared by whoever opens the incident. SEV1: customer-facing error rate above 5% in more than one region. SEV2: customer-facing error rate above 5% in a single region, or any full outage of an internal-only system. SEV3: any other condition that pages. The incident tool assigns severity from the metric that fired and locks manual override behind a documented justification field.
**Consequences:**
- Positive: severity reflects actual blast radius immediately, without waiting on a judgment call.
- Negative: a real but hard-to-instrument failure mode that doesn't trip one of these specific signals gets under-classified until someone manually justifies raising it.
**Vision-fit:** n/a — internal tooling.
**Scope:** src/incidents/**
**Source:** seed
