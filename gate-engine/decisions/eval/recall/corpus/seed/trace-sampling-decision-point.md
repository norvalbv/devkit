---
slug: trace-sampling-decision-point
created: 2026-01-01
---

# trace-sampling-decision-point

## Target · 2026-03-11 — Sample traces at a flat 1% across all endpoints

**Context:** Full-fidelity tracing on every request cost more per month than the compute it observed, and nobody could name a question it had answered.
**Ruling:** Traces are sampled at a flat 1% across all endpoints, applied at the edge before any span is created.
**Consequences:**
- Positive: tracing spend drops by two orders of magnitude.
- Negative: a rare failing request is unlikely to have a trace when someone goes looking.
**Vision-fit:** n/a — internal tooling.
**Scope:** src/observability/**
**Source:** seed
- 2026-03-11 — SAME_DAY_SUPERSEDED_MARKER: this note belongs to the flat-rate block that was replaced later the same day.

## Target · 2026-03-11 — Sampling is tail-based: always keep errors and slow requests

**Context:** The flat 1% ruling shipped in the morning and by the afternoon an incident review found the one trace that mattered had been sampled away — a flat head-based rate discards failures at exactly the same rate as successes.
**Ruling:** Sampling is tail-based: the decision is made after the request completes, keeping 100% of traces that errored or exceeded the latency objective, and 1% of the rest.
**Consequences:**
- Positive: every failed or slow request is traceable, which is when a trace is actually wanted.
- Negative: spans must be buffered until the request finishes, so the collector holds more memory.
**Vision-fit:** n/a — internal tooling.
**Scope:** src/observability/**
**Evidence-change:** an incident review found the decisive trace had been discarded by head-based sampling.
**Source:** seed
- 2026-04-02 — Buffer pressure at the collector required a per-request span cap; traces exceeding it are truncated rather than dropped whole.
