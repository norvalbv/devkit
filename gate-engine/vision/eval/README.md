# vision-eval

Accuracy benchmark for the **product-vision judge** (`../check-vision.mjs`). This gate blocks
HARD on a confident OUT, and a hard gate ships **only behind a passing bench** (the
review-gate-in-chain rule: no advisory tier — a judge is benched before it blocks, never trusted
on vibes). A prompt or scaffold edit is unverifiable without this.

The bench composes the judge call **from the gate** (`visionJudgeArgs`, `buildJudgeInput`,
`parseVisionVerdict`), so it exercises the exact argv/stdin/parse path the gate runs — prompt and
logic never drift (the sentry-eval rule).

## Methodology (per the 2026-07-13 critique + `bench-gates-on-flips-not-deltas`)

- **Multi-run majority** — every row judged `BENCH_RUNS` times (default 3); majority verdict; no
  majority → UNSTABLE (wrong). Per-row flip rate reported. Single-sample judging turns LLM noise
  into false signal (arXiv:2606.13685 — ~13.6% pairwise flip rate; arXiv:2408.04667).
- **Honest statistics** — OUT precision/recall print with Wilson 95% intervals + an MDE line
  (arXiv:2503.01747). Floors met on the point estimate but inside the CI are flagged loudly.
- **Sealed holdout** — rows carry `split: "dev" | "holdout"`. Iterate the prompt on dev ONLY
  (`BENCH_SPLIT=dev`); `--fail` evaluates the floors on the HOLDOUT split (arXiv:2511.18619 —
  dev==test overfits). Every run appends to `runs.log` so the dev↔holdout gap stays visible.
- **OUT-binary flips, never aggregate deltas** — regression vs baseline is a McNemar mid-p test
  on per-row OUT-binary verdict flips; the aggregate-delta epsilon gate was REJECTED by
  `bench-gates-on-flips-not-deltas`, and accuracy folds in the deliberately-fuzzy DRIFT↔FIT
  boundary, so neither ever gates.
- **De-confounded corpus** — OUT is NOT predictable from surface cues: `out-deconfounded` rows
  carry the semantics with no announcing path/comment (Stripe Connect `on_behalf_of` in
  `billing/`, app-account credential tables in neutral migrations); `fit-deconfounded` rows put
  own-infra work under cue-bearing paths (`hosting/` self-deploy, "user backend" test fixtures,
  marketing copy affirming the line). Contrast-set discipline per arXiv:2004.02709 / 2005.04118.
- **Real negatives** — `fit-real` rows are genuine merged commits (messy, un-announced), not
  self-authored synthetics.

## Shipping floors (evaluated on the holdout; `--fail` enforces)

| Metric | Floor | Why |
|---|---|---|
| OUT precision | ≥ 0.90 | a false OUT costs a blocked commit and trains reflexive bypass |
| OUT recall | ≥ 0.75 | the gate must actually catch the class it exists for |

Known limitation, stated not hidden: at the current holdout size (~11 OUT) the floors sit inside
their Wilson CI — a pass is necessary, not sufficient. Grow OUT positives (the MDE line prints
the target) before treating the margin as real.

## Corpus (`cases.jsonl`)

One JSON object per line:

```json
{ "id": "...", "split": "dev|holdout", "paths": "a.ts\nb.ts", "diff": "+...", "expected": "FIT|DRIFT|OUT", "category": "...", "note": "...", "statement": "optional override" }
```

Categories: `fit-own-infra` (false-OUT traps: own auth/billing/DB/deploy, codegen into the user's
project, dev tasks on the user's own infra), `fit-feature`, `fit-chore`, `fit-real`,
`fit-deconfounded`, `out-user-backend` (announced), `out-deconfounded` (un-announced),
`drift-off-spine` (incl. FIT-labelled traps), `edge` (verdict injection, mixed diffs,
deletion-of-OUT, flag-gated OUT, statement variants). Keep labels deliberately reviewed — the
de-confounded rows are the ones that make the floors mean anything.

## Run

```bash
node bench.mjs                       # 3-run majority, per-split metrics + CI + floors
BENCH_SPLIT=dev node bench.mjs       # prompt-iteration loop (never tune on holdout)
node bench.mjs --baseline            # write current run as the baseline (results.baseline.json)
node bench.mjs --fail                # exit 1 if HOLDOUT floors missed or OUT-binary flips regressed

BENCH_MODEL=sonnet node bench.mjs    # cheaper-model sweep
BENCH_RUNS=1 BENCH_ONLY=id node bench.mjs   # single-row smoke
```

Budget ≈ rows × runs ÷ `BENCH_CONCURRENCY` × ~30s. No `results.baseline.json` or `runs.log`
ships — generate yours; only a holdout `--fail` pass licenses the hard gate.
