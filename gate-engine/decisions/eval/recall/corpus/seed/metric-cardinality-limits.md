---
slug: metric-cardinality-limits
created: 2026-01-01
---

# metric-cardinality-limits

## Target · 2026-02-25 — Metric labels are capped at 100 distinct values and validated at emission

**Context:** A single label carrying a raw user id on a request-duration histogram multiplied the service's timeseries count past the backend's ingest limit; the backend rejected writes for every metric from every service until the label was pulled, taking down unrelated dashboards during an unrelated deploy.
**Ruling:** Every metric label is capped at 100 distinct values per label key. Allowed label values for each label key are declared in code at build time as a per-service allowlist; the metrics client checks each sample against that allowlist and drops any sample carrying a label value outside it, rather than queuing or best-effort forwarding it.
**Consequences:**
- Positive: one runaway label can no longer take down metrics ingestion for every other service.
- Negative: a label value that should be tracked but was never declared silently disappears from the data instead of erroring loudly.
**Vision-fit:** n/a — internal tooling.
**Scope:** src/metrics/**
**Source:** seed
- 2026-03-18 — Allowlist enforcement caught a would-be regression before rollout on the first 12 onboarded services; working as intended so far.
- 2026-04-22 — Found a gap: the client only validated the first label key in a sample's label set, so a second high-cardinality key on the same metric could still slip through undetected until the backend's own hard limit tripped. The cap was effectively enforced on only one dimension at a time.
- 2026-05-09 — Fix shipped: the client now validates every label key in a sample against its allowlist, not just the first. Backfilled cardinality reports show no undetected multi-key breaches since.
