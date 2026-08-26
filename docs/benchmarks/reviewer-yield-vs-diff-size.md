# Reviewer yield vs diff size — findings from ship telemetry (2026-08-22)

Working record, same rules as [`decisions-findings.md`](decisions-findings.md): every number carries its
population, its `n`, and the query that produced it ([`experiments/2026-08-22-ship-attempts-research/reports/queries.md`](experiments/2026-08-22-ship-attempts-research/reports/queries.md)).
Numbers without those are not usable. Population is **every repo shipped from this machine** (the
default telemetry sink is per-machine — see `gate-telemetry-self-describing`), read from the local
collector DB on 2026-08-22. Branch names are anonymised (`branch-NN`), per the README privacy boundary.

## Why this record exists

Ship iteration is the dominant time and cost sink: 23 branches needed ≥20 ship attempts (max 55),
60 more needed 10–19; the costliest branch spent $465.98 of judge calls over 23 ships. The question
was whether the review gate's *yield* — real defects surfaced per run — depends on how much code it
is given. It does, and the shape of the dependence changes what is worth building.

## Finding 1 — one finding per attempt is a prompt convention, not a code cap

| fact | value | source |
|---|---|---|
| blocked correctness attempts carrying exactly 1 blocking lens | 675 / 726 (93%) | `commit_reviews.reason` regex `(\d+) un-overridden finding` |
| failing lenses carrying exactly 1 issue | ~99% | `commit_review_lenses.issue_count` |
| issues per failing review (all lenses summed) | 1×335 · 2×145 · 3×31 · 4×13 · 5×1 | same, grouped by ship |

The code already accepts more: `.claude/skills/_devkit/checklist-store.mjs` appends every
`--fail "reason"` to `item.issues`, `finalize` flattens them, and telemetry keeps up to 3 per item
(`gate-engine/review/evidence/items.mts ISSUES_PER_ITEM`). The reviewer brief's workflow
("check each item, one at a time … `--fail "reason"`") is what makes the judge stop at the first
defect per lens. Consequence: a diff with N defects is drained one per attempt.

## Finding 2 — yield saturates with diff size (the critical point)

correctness-reviewer, uncached runs with a recorded diff size, n = 1,043. LOC ≈ `diff_bytes / 40`.
Issues = `sum(commit_review_lenses.issue_count)` per run.

| diff size (LOC) | reviews | ≥1 issue | issues / review | issues / 1k LOC |
|---|---|---|---|---|
| 0–100 | 115 | 22% | 0.28 | 4.9 |
| 100–300 | 216 | 34% | 0.46 | 2.3 |
| 300–600 | 182 | 52% | 0.74 | 1.8 |
| 600–1000 | 223 | 60% | 0.87 | 1.1 |
| 1000–2000 | 198 | 66% | 1.05 | 0.77 |
| 2000–4000 | 83 | 61% | 0.98 | 0.35 |
| 4000+ | 26 | 69% | 1.00 | 0.14 |

Per-branch retry chains (branches with ≥5 attempts, correctness findings summed over the chain vs the
largest correctness diff seen):

| final diff (LOC) | branches | median findings / branch | median attempts | findings per 1k LOC (median) |
|---|---|---|---|---|
| 0–300 | 32 | 1 | 6 | 4.4 |
| 300–1000 | 79 | 2 | 7 | 3.1 |
| 1000–3000 | 41 | 3 | 10 | 1.9 |
| 3000+ | 9 | 5 | 18 | 0.6 |

Reading: above ~1k LOC the reviewer returns ~1 issue per run regardless of how much more code it is
given; per line reviewed, a 4k-LOC diff yields ~35× fewer issues than a 100-LOC one. Two mechanisms
beyond Finding 1 are known: attention dilution (SWE-PRBench, arXiv:2603.26130 — adding ~25% more
context tokens halves contextual-issue detection across 8 models) and the 60 KB evidence cap
(`gate-engine/review/diff-evidence.mts`: 60000 total / 8000 per file / 40 omitted-list) — 219 of
1,580 correctness reviews (13.9%) exceeded it, so the judge never saw part of those diffs.

## Finding 3 — the benchmark does not cover this regime

| | reviewer corpus fixtures | real reviewed diffs (correctness, uncached) |
|---|---|---|
| rows | 261 | 1,043 |
| LOC | median 21, p90 46, max 71 | mean ~945, max ~12,900 |
| files | ≤2 | up to 63 |
| >1k LOC | 0 | 307 (29%) |
| >5k LOC | 0 | 24 |

This is by design — focused fixtures isolate one defect (`benchmark-methodology.md`) — but it means
no benchmark number speaks to the regime where the gate actually runs or where the retry churn happens.

> **Follow-up (2026-08-23):** the saturation prediction was tested on the SAME diffs by the
> scale probe ([`experiments/2026-08-23-scale-probe/`](experiments/2026-08-23-scale-probe/README.md)):
> chunking pooled ≥ whole-diff under all five mining/scoring rulesets tried (shipped ruleset:
> chunk:1000 8/23 vs whole 5/23 decontaminated known defects re-found), largest gains exactly on
> the biggest and most label-dense diffs — the content confound does not explain the plateau. No
> registered bar is treated as cleared (ratio 1.375×–2.0× by ruleset; ~half the original labels
> were test-retest contamination, since fixed); see the experiment's correction record.

## Limitations that travel with every number above

- **Content confound.** Small and large diffs are different changes; part of the 4.9 → 0.14 drop is
  content, not the reviewer. The reviewer-side signal is the plateau at ~1.0 issue/review above 1k LOC.
  It must be reproduced on the *same* diffs (the scale-track benchmark) before it drives a default.
- **Per-machine sink.** Counts mix every repo shipped from this machine; devkit-only numbers are much
  smaller (max 19 attempts; $14.85 of judge calls per shipped commit in the costed era).
- **Cost is a floor.** `cost_usd` is populated only since ~2026-08-07 (5,770 of 16,147 judge rows).
- **Cached PASSes** leave no `commit_reviews` row; all review counts are over runs that actually executed.
- **`issue_count` counts the judge's own issue strings**, capped at 3 per lens by the telemetry
  encoder; it is not a precision-checked count of true defects (the correctness reviewer's measured
  clean-pass is ~0.86, `correctness-reviewer-precision`).

## What this changed

Plan of record (research record: [`experiments/2026-08-22-ship-attempts-research/`](experiments/2026-08-22-ship-attempts-research/README.md)):
truncation telemetry on `review_scope`; multi-finding disclosure per lens (bounded, direct change);
a scale-track benchmark that runs reviewer configurations — whole-diff vs chunked parallel reviewers —
against real large diffs with telemetry-mined labels; production chunking only if that benchmark
clears a pre-registered rule.
