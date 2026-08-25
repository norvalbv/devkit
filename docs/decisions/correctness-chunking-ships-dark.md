---
slug: correctness-chunking-ships-dark
created: 2026-08-24
---

# correctness-chunking-ships-dark

## Target · 2026-08-24 — planReviewWork chunks the correctness reviewer only when GUARD_CORRECTNESS_CHUNK=<loc> is set AND th

**Context:** The scale-track probes (2026-08-23 sonnet round, 2026-08-24 codex round) showed chunked and effort-based review both beat whole-diff sonnet on tier-A recall but chose different winners per model; the machinery is model/size-agnostic while the config choice is not. Owner ruled: build the infrastructure now, keep every knob runtime, let production telemetry decide — superseding the sc-1997 pre-registered confirmation round as the gate for sc-1907.
**Ruling:** planReviewWork chunks the correctness reviewer only when GUARD_CORRECTNESS_CHUNK=<loc> is set AND the diff's identity bytes exceed 1.5x the cap: local lens groups fan out per whole-file next-fit chunk (max 4 chunks, re-packed at doubled caps); any group carrying writer-reader-contracts stays whole-diff and SHARES the un-chunked key; chunk keys carry the chunk's membership hash; per-chunk checklist state files (--chunk / +c<n>) keep concurrent same-lens judges collision-free; the sc-1999 wire format is the rollout readout. OFF is byte-identical to the pre-chunking engine — pinned by test.
**Consequences:**
- Positive: Attempts-per-shipped-commit on large PRs becomes measurable per arm from live telemetry with a one-env-var kill switch; model and cap decisions decouple from machinery. Arming without sc-2073 would corrupt the weekly mining corpus — arming is BLOCKED on it; verdict-store retention quadrupled (bounded by the store size cap).
- Negative: Shipping dark on directional probe evidence (n=23 labels) instead of the pre-registered 112-label confirmation trades statistical certainty for build momentum and zero spend — accepted because the flag defaults off, keys are byte-identical when off, and the same telemetry that would judge a rollout also falsifies a bad probe signal.
**Vision-fit:** n/a — internal tooling
**Source:** manual
