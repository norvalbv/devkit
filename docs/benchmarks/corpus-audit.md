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
- **always-wrong, adjudicated 2026-09-03** (methodology item 19, every fixture opened and diffed):
  only 3 of the 9 are sound rows scoring a true reviewer error — `corr-pr200-ref-mutated-during-render-move`
  (render-body ref write, missed), `corr-pr48-cn-ts-src` (`cn` last-wins drops `rounded-full`, missed)
  and `corr-pr21-fail-closed-when-the-remote-pair` (exit-status 2 handling is right; over-flagged on a
  `checkout -b`-before-check wart). The other 6 are the corpus's fault: 2 decoys are **label-wrong**
  (`corr-decoy-targeted-broadcast` — the new `q.sent` guard sits ahead of the retry path and kills the
  retry it protects; `corr-pr26-keep-the-mcp-inputschema-in-pair` — the schema's `items` omits
  `required: ['choices']`, so discovery still admits what the parser rejects) and 4 fixtures are
  **defective** (`corr-retry-stuck-unclaimable` — the staged change is a comment, the defect is in base;
  `corr-sync-source-target-divergence` — no caller passes a custom root and the 3-arg call is now a
  compile error; `corr-pr26-cover-the-restart-interrupted-flow` — nothing writes `restartRunId`;
  `corr-decoy-tight-anchor-classifier` — the diff adds a `\d{3}` requirement the note never defends).
  Those 6 were repaired on 2026-09-03 inside sc-2494's epoch break, each by the minimal edit the
  adjudication named: the broadcast decoy drops the retry-killing `q.sent` guard and ships `queue.ts`;
  the classifier decoy drops the undefended `\d{3}` narrowing; the schema decoy adds
  `required: ['choices']`; the retry gold's base now resets `startMode` so the diff introduces the
  dead state; the sync gold gains `cli.ts`, the caller that threads a custom root; the restart gold
  gains `resume.ts`, the writer that leaves `flowRunId` null (its decoy sibling gets the same file so
  the extra file is not a gold-only tell). Their rowHash changed, so the re-baseline measures them fresh.
- **never measured 44** is the cheapest gap: those rows have cost judge time zero and carry no
  evidence either way; the re-baseline measures them.
- **pairs straddling 25** is why holdout scored easier than dev. `finalize.mts` now assigns
  holdout per pair group (union of `caseId` and `variantOf`); the reassignment lands inside the
  re-baseline's epoch break so the corpus re-baselines once.

## What changed alongside the audit

- `finalize --check` refuses a proposal that is an unrelated near-twin of an existing row and
  prints the coverage cell (suite × lens × difficulty) the row would fill; `--append` applies the
  same rule to the post-overlay batch, so nothing enters the corpus that `--check` would refuse.
- `loadRows` warns when a suite is under the ≥3-holdout-per-class floor
  (`DEVKIT_HOLDOUT_FLOOR_STRICT=1` refuses); `corpus/corpus-lint.mts` runs the structural lint in the
  pre-commit benchmark stage.
- Checkpoint rows carry `caseId`, `variantOf`, `holdout` and `reasonClass`; `summarize()` publishes
  `pairConsistency` (grouped over both links, the same relation holdout uses) and the tracker emits
  `<arm>:pair-consistency` beside the marginal.
- Every reviewer ratio carries `noiseFloor: 0.139` (the Wilson upper bound of the 2 / 48 blind
  relabel), so `metricAssessment` reads a sub-floor delta as `flat` instead of a win.
- Mined fail→fix candidates carry `labelRule` (lens-pass · reviewer-pass · absence-exit0 ·
  fallback), `sameDiffGuardArmable` and `evidenceShrunk`, so noise is reportable per tier.
