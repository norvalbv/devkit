# Corpus audit — row value as a computed property

Ruling: `docs/decisions/corpus-rows-admitted-by-coverage-cell.md`. Command:

```
bun gate-engine/review/eval/reviewers/corpus/audit.mts [--suite correctness] [--json <out>]
```

The audit reads only what is already on disk — the committed reviewer checkpoints under
`docs/benchmarks/checkpoints/` and the `cases-*.jsonl` corpora — and prints, per suite, the rows
that carry information and the rows that do not. It makes no judge calls and edits nothing.

## 2026-09-02 reading (checkpoints of 2026-08-01..02: correctness at sonnet, domain suites at haiku)

| suite | rows | never measured | multi-observed | constant-correct | always-wrong | flipped | pairs (straddling holdout) | holdout floor |
|---|---:|---:|---:|---:|---:|---:|---|---|
| correctness | 140 | 12 | 90 | 70 | 9 | 11 | 50 (25) | FAIL 37 · PASS 20 — ok |
| api-security | 44 | 30 | 0 | – | – | – | 16 (8) | FAIL 9 · PASS 3 — ok |
| frontend-security | 21 | 2 | 0 | – | – | – | 3 (0) | FAIL 3 · PASS 2 — **below** |
| frontend-performance | 19 | 0 | 0 | – | – | – | 2 (0) | FAIL 2 · PASS 1 — **below** |
| backend-performance | 13 | 0 | 0 | – | – | – | 1 (0) | FAIL 1 · PASS 1 — **below** |

These reproduce the 2026-08-31 research's verified figures (44 never-measured across suites,
70 of 90 always-correct, 25 of 50 correctness pairs straddling the boundary). Near-twins at a
5-shingle Jaccard of 0.5 or more: 35 pairs in correctness, **all** of them intended minimal pairs
(linked by `caseId` or `variantOf`) — the leakage is straddling, not unlinked copies, which is
exactly what group-wise holdout assignment removes.

What the numbers mean and do not mean:

- **constant-correct 70 / 90** describes the sonnet/haiku epoch. It is a saturation *report*.
  Story sc-2494 rules that no row is retired on the old model's numbers; demotion to a tripwire
  tier happens after the re-baseline, on current-epoch observations.
- **always-wrong 9** are candidate mislabels: `corr-retry-stuck-unclaimable`,
  `corr-sync-source-target-divergence`, `corr-decoy-targeted-broadcast`,
  `corr-decoy-tight-anchor-classifier`, `corr-pr200-ref-mutated-during-render-move`,
  `corr-pr21-fail-closed-when-the-remote-pair`, `corr-pr26-cover-the-restart-interrupted-flow`,
  `corr-pr26-keep-the-mcp-inputschema-in-pair`, `corr-pr48-cn-ts-src`. Only opening each row's
  fixture and note settles whether the label or the reviewer is wrong (methodology item 19).
- **never measured 44** is the cheapest gap: those rows have cost judge time zero and carry no
  evidence either way; the re-baseline measures them.
- **pairs straddling 25** is why holdout scored easier than dev. `finalize.mts` now assigns
  holdout per pair group (union of `caseId` and `variantOf`); the reassignment lands inside the
  re-baseline's epoch break so the corpus re-baselines once.

## What changed alongside the audit

- `finalize --check` refuses a proposal that is an unrelated near-twin of an existing row and
  prints the coverage cell (suite × lens × difficulty) the row would fill.
- `loadRows` warns when a suite is under the ≥3-holdout-per-class floor
  (`DEVKIT_HOLDOUT_FLOOR_STRICT=1` refuses); `corpus/corpus-lint.mts` runs the structural lint in the
  pre-commit benchmark stage.
- Checkpoint rows carry `caseId`, `holdout` and `reasonClass`; `summarize()` publishes
  `pairConsistency` and the tracker emits `<arm>:pair-consistency` beside the marginal.
- Every reviewer ratio carries `noiseFloor: 0.139` (the Wilson upper bound of the 2 / 48 blind
  relabel), so `metricAssessment` reads a sub-floor delta as `flat` instead of a win.
- Mined fail→fix candidates carry `labelRule` (lens-pass · reviewer-pass · absence-exit0 ·
  fallback), `sameDiffGuardArmable` and `evidenceShrunk`, so noise is reportable per tier.
