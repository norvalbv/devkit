# Correctness lens split — A/B, 2026-08-03/04

**Outcome: the registered arm did not pass. The unregistered 4-way arm moved both co-primaries but
is not decisive at this corpus size. Nothing here is published to the tracker — see Provenance.**

Pre-registration: [`../../pre-registration-lens-split.md`](../../pre-registration-lens-split.md).

## Question

`correctness-reviewer` judges four lenses in one pass (`concurrency-races`, `state-transitions`,
`writer-reader-contracts`, `error-and-edge-classification`). The hypothesis was attention dilution:
one judge holding four checklists does each of them worse than a judge holding one.

`GUARD_CORRECTNESS_SPLIT` (dark, off by default) partitions the lenses across judges: `1` uses the
default two groups of two, an explicit `a,b|c,d` spec sets any partition, and a four-group spec
gives one judge per lens.

## Arms

All four ran on the same corpus (140 rows, 75 gold) at `sonnet`, `BENCH_CASCADE=off`, concurrency 2.

| arm | command | purpose |
|---|---|---|
| control-1 | `bun bench.mts run correctness-reviewer --baseline` | baseline |
| control-2 | same, `--against control-1.json` | **noise floor** — identical config, re-run |
| 2-way | `GUARD_CORRECTNESS_SPLIT=1 … --against control-1.json` | the registered arm |
| 4-way | `GUARD_CORRECTNESS_SPLIT='state-transitions\|concurrency-races\|writer-reader-contracts\|error-and-edge-classification' … --against control-1.json` | not registered |

## Results

| | pooled recall | pooled clean-pass | weak recall | weak clean-pass | strong (guardrail) | stable flips |
|---|---|---|---|---|---|---|
| control-1 | 0.81 (61/75) | 0.69 (45/65) | 0.76 | 0.63 | 0.90 / 0.78 | — |
| control-2 (null) | 0.84 (63/75) | 0.69 (45/65) | 0.80 | 0.59 | 0.90 / 0.72 | ↓3 ↑2, mid-p 0.688 |
| 2-way (registered) | 0.84 (63/75) | 0.72 (47/65) | 0.83 | 0.59 | 0.86 / 0.83 | ↓1 ↑5, mid-p 0.125 |
| 4-way | 0.87 (65/75) | 0.75 (49/65) | **0.85** | **0.66** | 0.90 / 0.83 | ↓0 ↑5, mid-p 0.031 |

Per-lens and flip tables are reproducible from the committed logs:

    bun lens-analysis.mjs <corpus>.jsonl runs/control-1.log runs/split4.log --labelA ctl1 --labelB SPLIT4

## Reading

**The registered 2-way arm failed its co-primary.** The pre-registration requires *both* weak-pair
metrics to move. Recall did (0.76 → 0.83); clean-pass fell (0.63 → 0.59). mid-p 0.125. Per the
stopping rule, this is **UNRESOLVED** — recorded as such rather than re-cut post hoc.

**The 4-way moved both co-primaries** (recall 0.76 → 0.85, clean-pass 0.63 → 0.66) with the
guardrail unharmed (strong recall unchanged at 0.90, its clean-pass 0.78 → 0.83), and was the only
arm with zero regressions. It was **not** the registered arm, so this is not a result to publish.

**Subtract the noise before believing any of it.** Rows that also flip in the null comparison move
regardless of arm. Excluding them, on the weak pair:

- 4-way: **+4** (4 improvements, 0 regressions)
- 2-way: **+1** (2 improvements, 1 regression)

against a repo decision floor of roughly 5 net flips. `corr-asymmetric-flip-classifier` improved in
*all three* arms including the null — it is an unstable row, not evidence.

**The direction was predicted in advance.** `error-and-edge-classification` was recorded before
these runs as the lone weak lens (0.71) with isolating it named as the next candidate. The 4-way
does exactly that and moves it to 0.86. A confirmed prior prediction is worth more than a
post-hoc subgroup, but it still is not the registered arm.

## Two prior claims these runs falsified

1. **Splitting was argued down from 4 groups to 2 partly on latency (~4× judge calls).** Measured
   per fresh row: control **1.09 min**, 4-way **0.74 min**, 2-way **0.70 min** — the split arms are
   ~35% *faster*, because each judge gets a quarter of the checklist and returns sooner. Judges run
   sequentially (`runLensCascades`), so this is not parallelism. Token spend is still higher, as the
   diff is re-sent per lens.
2. **The 4.2% single-judge inconclusive rate was expected to compound to ~15.8% over four judges.**
   All three arms finished with **zero** inconclusives. The four outages in the 4-way's first
   attempts were rate limits, and re-ran.

## Provenance — why nothing here is published

These numbers were produced at worktree tree `a319770` **plus one uncommitted file**
(`gate-engine/review/eval/reviewers/bench.mts`, the stability-pass fix now tracked as sc-1436). That
tree exists as no commit.

Two behaviour fixes landed on `main` after the runs and are absent from the benched tree:

- `b5ef9a3` — salt the commit-path verdict cache with reviewer identity (sc-1437, #326)
- `f09f7bc` — stop judges deleting the checklist artifact the gate must read (sc-1438, #327)

Publishing these as an accepted checkpoint would attribute the scores to code that did not produce
them, and every later comparison would inherit the error. The **relative** comparison between arms
stays valid — all four ran on the identical tree.

`#327` addresses the "checklist artifact missing" inconclusive (219 occurrences across reviewers),
so a clean baseline may differ materially from control-1.

## Next

1. Re-run one baseline on clean `main` once sc-1436 lands, and publish *that* as the accepted
   checkpoint. Do not publish control-1.
2. Grow the weak pair before re-testing. At 46 gold / 32 decoy, +4 under a floor of 5 cannot be
   resolved no matter how many times it is re-run.
3. Then pre-register the 4-way, or an `error-and-edge`-isolated cut, and run it once as the primary.
