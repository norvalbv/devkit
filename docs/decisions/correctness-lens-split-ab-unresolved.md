---
slug: correctness-lens-split-ab-unresolved
created: 2026-08-04
---

# correctness-lens-split-ab-unresolved

## Target · 2026-08-04 — The registered 2-way arm is UNRESOLVED and the split stays dark

**Context:** correctness-reviewer judges four lenses in one pass. The attention-dilution hypothesis was tested with four 140-row bench arms on 2026-08-03/04: a baseline, a null re-run for the noise floor, the pre-registered 2-way split, and an unregistered 4-way split (one judge per lens). Evidence: docs/benchmarks/experiments/2026-08-04-correctness-lens-split/
**Ruling:** The registered 2-way arm is UNRESOLVED and the split stays dark. Its co-primary requires both weak-pair metrics to move; recall rose 0.76->0.83 but clean-pass fell 0.63->0.59 (mid-p 0.125). The 4-way arm moved both co-primaries (0.85 / 0.66) with the guardrail unharmed and zero regressions, but it was not the registered arm and nets only +4 after subtracting rows that also flip in the null, against a ~5-flip floor. No arm is published to the benchmark tracker.
**Consequences:**
- Positive: GUARD_CORRECTNESS_SPLIT remains off by default. Absolute numbers from these runs must not be published: they were produced at tree a319770 plus an uncommitted scorer file, and sc-1437 (#326) and sc-1438 (#327) landed on main afterwards. The relative comparison between arms stays valid since all four ran on the identical tree. Before re-testing, grow the weak pair (46 gold / 32 decoy) — at that size the question cannot be resolved by re-running. Re-baseline on clean main and publish that instead.
- Negative: Reporting the registered null instead of the better unregistered arm forgoes a headline improvement we may well have, and costs another corpus-growth cycle before it can be claimed. Accepted because publishing a post-hoc arm as a measurement is the failure the pre-registration exists to prevent.
**Vision-fit:** The epic premise is that benchmarks grow from telemetry and measured upgrades follow. Recording a null honestly, and refusing to publish numbers whose tree no longer ships, is what makes the ledger worth consulting later.
**Source:** manual
