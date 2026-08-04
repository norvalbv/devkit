---
slug: correctness-lens-split-shipped
created: 2026-08-04
---

# correctness-lens-split-shipped

## Target · 2026-08-04 — Ship the four-way split ON by default (GUARD_CORRECTNESS_SPLIT unset => one judge per lens), on DIRE

**Context:** The 2026-08-04 A/B (docs/benchmarks/experiments/2026-08-04-correctness-lens-split/) ran four 140-row arms. The registered two-group arm FAILED its co-primary (clean-pass 0.63->0.59, mid-p 0.125). The unregistered four-way arm led on both co-primaries (recall 0.76->0.85, clean-pass 0.63->0.66) with the guardrail unharmed and zero regressions, but its null-adjusted +4 sits under the repo's ~5-flip decision floor. The corpus cannot resolve the question at 46 gold / 32 decoy on the weak pair, and hand-authoring rows a batch at a time cannot close that gap: halving a confidence interval takes ~4x the rows, not +10.
**Ruling:** Ship the four-way split ON by default (GUARD_CORRECTNESS_SPLIT unset => one judge per lens), on DIRECTIONAL evidence rather than a cleared bar. 'off'/'0' restores the monolith; '1'/'on' still addresses the registered paired arm so the A/B stays runnable. The per-lens vector must survive the merge: item_count and item_tally are recomputed across all parts and the element cap and inline budget re-applied after joining, and a lens_parts vector carries per-group status and secs.
**Consequences:**
- Positive: Every commit runs four correctness judges instead of one. Measured cost is LOWER, not higher — 0.74 vs 1.09 min per row, because each judge holds a quarter of the checklist — and all three arms finished with zero inconclusives, so the feared compounding of the 4.2% single-judge rate did not appear. Bench section keys now carry the four-way arm suffix by default, so runs no longer pair with monolith-era baselines; that is correct, the behaviour changed. run-review.test.mts pins the split off because it asserts the undivided cascade contract, with the shipped default covered end to end by its own describe block.
- Negative: Shipping a configuration whose pre-registered arm failed risks entrenching a change that later measurement does not support. Accepted because a configuration nobody runs mints no telemetry to decide it with, the corpus cannot be grown to decide it without shipping first, the downside is bounded (guardrail unharmed, zero regressions, cheaper per row), and reverting is one env var. The evidence and its limits are recorded rather than dressed up.
**Vision-fit:** Benchmarks grow from telemetry. Running the split is what mints per-lens rows to grow them FROM, and fixing the merge is what makes those rows attributable to a lens instead of collapsing into one reviewer.
**Source:** manual
