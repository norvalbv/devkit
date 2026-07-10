# reviewer-eval

Benchmark for the **domain pre-commit reviewers** (api-security, backend-performance,
frontend-security, frontend-performance) — the `guard-review --gate` cascade judges. It exists to
answer two questions with numbers instead of vibes:

1. **Model choice** — can the first pass drop from sonnet to haiku without losing blocks?
2. **Regression protection** — did a brief/checklist/catalog edit help or hurt?

It drives the **real gate** (`runCascade` from `../../run-review.mts`) over disposable fixture
repos, so bench and gate cannot drift. The **correctness reviewer** (`cases-correctness.jsonl`,
domain `all`, single-pass haiku) is in the cohort. commit-guard is out of scope (its allowlist
needs the consumer's semantic-search MCP tool, unresolvable in a bare fixture); a further reviewer
joins by adding its `cases-<skill>.jsonl` + REVIEWERS entry.

**Bench-only, never shipped.** This directory is excluded from tsc and the build
(`**/eval/**`), and the package publishes `dist/` only. `mine-bots.mts` calls the GitHub API on
private repos — it is quarry-gathering for corpus authorship, must never run in any gate or
production path, and its output (`candidates.jsonl`) is gitignored.

## Usage

```bash
node bench.mts validate [reviewer]      # 0 LLM calls — corpus linter (run before any spend)
node bench.mts coverage                 # 0 LLM calls — catalog + per-lens gold counts + difficulty
node bench.mts run [reviewer|all] [--dev] [--only <idPrefix>] [--baseline] [--fail]
node bench.mts run <reviewer> --against <before.json>   # A/B a prompt edit (directional; §A/B below)
```

Knobs: `BENCH_MODEL` (first-pass model, default `sonnet` = production) · `BENCH_CASCADE=off`
(short-circuit the opus escalation: first-pass metrics only, zero opus spend) ·
`BENCH_CONCURRENCY` (default 2, the gate's own judge-contention default).

**Checkpoint/resume (rate-limit safe).** Every completed row is appended to
`progress-<model>-<cascade>.jsonl` the moment it lands. Re-running the **same command**
auto-resumes: rows checkpointed under the same (model, cascade, gateHash, corpusHash) are
salvaged instead of re-run; outage/engine-error rows always re-run; `--fresh` discards the
checkpoint. After 3 consecutive judge outages (drained credit pool / rate limit) the run pauses
itself — completed rows are safe, partial numbers are labelled PARTIAL and never gate or become
a baseline — switch accounts and re-run the same command. The checkpoint file is deleted when a
run completes.

The standard workflow — **iterate on haiku, spend on sonnet/opus only at the end** (any
expensive-model numbers collected before an agent edit are invalidated by the gateHash change,
so collecting them early is pure waste):

```bash
node bench.mts validate                                        # free
BENCH_MODEL=haiku BENCH_CASCADE=off node bench.mts run --dev   # ~25–35 min shakeout
BENCH_MODEL=haiku node bench.mts run --baseline                # haiku "before" number, ~1–1.5 h
# … improvement loop: edit brief/checklist → cascade-off --dev re-run (~30 min) →
#   confirm cascade-on → --baseline again. Repeat until the floors hold comfortably.
node bench.mts run                                             # sonnet, IMPROVED agents, ~1.5–2 h
BENCH_MODEL=opus node bench.mts run                            # opus ceiling, run once, ~2.5–3 h
```

## Corpus

One JSONL file per reviewer (`cases-<skill>.jsonl`). The four **domain** reviewers carry 12 rows
each: 6 gold seeded-bugs (distinct catalog items; 3 clear / 2 borderline / 1 adversarial), 3 clean
decoys (trigger ≥2 checklist items, genuinely fine), 2 near-miss decoys (look vulnerable, provably
safe), 1 minimal pair (`variantOf`: the fixed twin of a gold row, expected PASS). 2 rows per file
are `holdout: true` (excluded by `--dev`, included in baselines). Dataset-card fields per row:
`note` (mandatory why), `difficulty`, `provenance` (`authored`/`mined`/`adapted` — mined rows are
anonymized adaptations of real CodeRabbit/Macroscope findings from our PR history), `variantOf`.

**`correctness` is the exception — a larger, growing cohort (66 rows, 38 gold / 28 decoy).** Its
four always-on lenses have no per-item catalog to spread across, so it is built for bug-CLASS
coverage instead: gold by lens `state-transitions:14 · concurrency-races:7 · writer-reader-contracts:7
· error-and-edge-classification:10`. It includes a regression set for the classes that leaked PAST
the shipped reviewer to CodeRabbit — stale-state/missing-reset, documented-early-exit-bypassed,
exit-code contract, and cleanup-after-throwable/no-`try`/`finally` — each gold paired with a
**true minimal-pair decoy** (`variantOf`, same fixture differing ONLY in the bug construct) so a
precision regression from an over-broad prompt edit shows as a decoy false-block. ~40% holdout;
each leaked class carries ≥1 dev gold to tune on + ≥2 holdout golds to validate generalization.
Note `variantOf` is documentation/traceability only — no metric reads it; the decoy's protection is
its contribution to the `cleanPass` denominator.

Fixture shape: gate assets (guard.config.json with `backendRoots:["api"]` /
`frontendRoots:["web"]`, the agent brief, the checklist script) are injected into `repo.base` at
run time; backend rows stage under `api/`, frontend rows under `web/`, so `selectReviewers`
fires exactly the target reviewer — selection itself is under test (`not-selected` scores as a
miss).

## Scoring (deterministic, no LLM matcher)

Per row: the captured **first-pass verdict**, the **end-to-end cascade outcome**, and the
checklist **state-file artifact** snapshotted immediately after each judge pass (the gate
deletes it afterwards). Expected-FAIL rows that block are attributed:

- `right-item` — `expectItems ⊆` failed checklist items
- `pattern-only` — `reasonPattern` matches the failure text (right bug, adjacent item)
- `fail-unattributed` — FAIL verdict but an all-pass artifact (`verifyChecklist` never
  scrutinizes FAILs; reported, never hidden)
- `unattributed` — blocked for an unverifiable reason (the seam where an LLM matcher can plug
  in later)

Inconclusive rows keep their sub-cause (`outage` / `no-verdict` / `checklist-void`) and cost
their expected class — NULL is a verdict (house rule).

## Metrics + floors

Pooled + per reviewer, every rate with a Wilson 95% interval:

| metric | meaning | floor (`--fail`, pooled) |
|---|---|---|
| first-pass FAIL-recall | P(first FAIL \| gold) — the haiku headline | ≥ 0.60, **sonnet runs only** |
| first-pass clean-pass | P(first PASS \| decoy); complement = wasted opus escalations | — (decision input) |
| end-to-end block recall | P(final fail \| gold), cascade on | ≥ 0.75 |
| end-to-end clean-pass | P(final pass \| decoy) — a false block is the worst outcome | ≥ 0.85 |

Plus: right-reason split, live escalation count + mean opus seconds, inconclusive by sub-cause.

`--fail` = floors + a per-row **flip table vs baseline** under two-sided mid-p McNemar (p<0.05
with net-negative flips). Rows discordant with the baseline are re-run once; a flip counts only
when 2-of-2 confirmed. Baselines are keyed `<reviewer>@<model>@<cascade>` and embed
`gateHash` (run-review.mts + reviewers.mts + brief + checklist — the brief IS gate code) +
`corpusHash`; any mismatch **skips** comparison loudly instead of lying. Regenerate with
`--baseline` after deliberate changes. Even at this size (48 domain rows; 66 correctness) each
cohort is a **large-effect tripwire, not a 5pp detector** — intervals print so nobody over-reads a
point estimate.

## A/B a deliberate prompt edit — `--against <before.json>`

`--fail`'s flip table **skips** across a `gateHash` change — but a deliberate brief/checklist edit
is exactly a `gateHash` change, so it can never measure the edit it was made for. `--against` is
the opt-in paired A/B for that case:

```bash
BENCH_MODEL=haiku node bench.mts run correctness-reviewer --baseline   # baseline the CURRENT brief
cp results.baseline.json before-hunt.json                              # snapshot the "before"
# … edit agents/correctness-reviewer.md (+ skills/correctness/SKILL.md) …
BENCH_MODEL=haiku node bench.mts run correctness-reviewer --against before-hunt.json
```

It reruns the (edited) brief and prints a **directional** per-row flip table vs the snapshot,
pairing purely by `row.id`. It **bypasses the `gateHash` guard** (the edit is expected to change it)
but **keeps `corpusHash` a HARD skip** — the paired rows must be the identical fixtures, so freeze
the corpus and re-baseline the "before" before an A/B. It writes **no baseline** and always **exits
0** (informational — the accept/revert call is yours). The `before.json` is a plain `cp` of a
baseline and is never clobbered (`--baseline` only writes `results.baseline.json`).

Because a small targeted cluster can't reach McNemar significance (≤4 one-directional flips ≈
mid-p 0.06), don't gate acceptance on the pooled p-value: accept an edit when its **targeted golds
flip miss→hit and no decoy flips into a block**, confirm on a K≥3 rerun of the touched golds, then
re-`--baseline` and run `--fail` for the pooled no-regression check.

## Pre-registered haiku decision rule

Written BEFORE the first sweep; the sweep does not get to move the goalposts. Haiku is the
DEFAULT candidate: agents are improved against haiku, and at the end the expensive models must
justify their cost against the improved agents — not the other way round.

Keep haiku as the production first pass (`GUARD_REVIEW_MODEL` default → `'haiku'`) **iff both**,
measured on the final improved agents:

1. Sonnet shows no statistically significant one-directional IMPROVEMENT over haiku on
   **end-to-end block recall** (per-reviewer flip tables, McNemar mid-p ≥ 0.05, holdouts
   included) — i.e. the bigger model does not buy blocks haiku misses, and
2. Haiku **first-pass clean-pass ≥ 0.70** — below that, wasted opus escalations (≈ falseFailRate
   × ~4 min opus per commit) erase the latency/cost win.

If (1) fails but sonnet's edge is confined to one reviewer, a per-reviewer model pin is the
fallback before giving up on haiku wholesale. The opus sweep is a ceiling reference only — it
does not gate the decision.

## Measured results — correctness (66-row corpus, K=1, single-pass)

Point estimates on the 66-row corpus (38 gold / 28 decoys). K=1 + 66 rows = tripwire, not a
5pp detector; CIs are wide.

| Model | Block recall | Clean-pass (precision proxy) | Right-item |
|---|---|---|---|
| haiku | 29/38 = **0.76** [.61,.87] | 24/28 = **0.86** [.69,.94] | 19/29 |
| sonnet | 35/38 = **0.92** [.79,.97] | 24/28 = **0.86** [.69,.94] | 31/35 |

- **Recall scales with model** (0.76→0.92); **precision is model-invariant at 0.86.**
- The four false-blocks are cross-domain leaks (`xdomain-sqli`, `xdomain-render` — flagged despite
  the explicit `<exclusions>`) and surface-cue blocks (`decoy-*-broadcast`, `decoy-*-classifier`).
  Both classes have *existing* brief guidance the single-pass judge ignores → the prose is tapped out.

### Path to higher precision (research-grounded — a red-team pass)
- **First grow the decoy corpus.** At n=28, clean-pass CI is [.69,.94]; **0.95 is above the upper
  bound — literally unmeasurable** until more cross-domain + surface-cue minimal-pairs land. Chasing
  the 4 rows before that is optimizing against noise.
- **Do NOT add a same-family generate→verify/refute pass.** That *is* the haiku→opus cascade we
  removed (recall 0.78→0.67), and the literature predicts the overturn: Huang 2310.01798, Stechly
  2402.08115, Kamoi 2406.01297. Verification only pays **cross-family** (Lu 2512.02304) — unavailable
  in a Claude-only stack.
- **Split the two classes, one tool each:** cross-domain → the deterministic one-sided
  `domainExclusivityDrop` guard (`run-review.mts`, zero recall cost); in-domain surface-cue →
  **K-sample self-consistency with an asymmetric "≥⅔-to-block, lenient-to-pass" rule** (Wang
  2203.11171), generalizing the existing 2-of-2 discordant-rerun. It never asks the model to
  second-guess its own finding, so it can't eat recall. Route by **sample agreement, not the model's
  stated confidence** (poorly calibrated: 2012.00955).

## Departures from decisions-eval

- Baseline sections are keyed by `(reviewer, model, cascade)` — a sweep can never clobber or
  falsely compare against the production baseline.
- Scoring is fully deterministic (verdict + artifact + regex); no LLM matcher, no κ audit. The
  `unattributed` bucket is the designated matcher seam if item-level attribution proves too
  coarse.
- Reviewer rows run K=1 (a cascade costs minutes); the discordant-rerun rule supplies the
  stability check instead of majority voting.
- `results.baseline.json` and `runs.log` are gitignored (decisions convention), as is
  `candidates.jsonl`.

## Cost (concurrency 2)

The domain pool is 48 rows; the `correctness` cohort is 66 (single-pass haiku, no escalation). Run
one reviewer at a time during a hunt — the numbers below are the 48-row domain pool; a full `all`
run is ~114 rows. A budget line prints before any token is spent; every run appends one to `runs.log`.

| run | config | wall-clock |
|---|---|---|
| correctness A/B (dev) | haiku, single-pass, `--dev` | ~25 min |
| correctness full | haiku, single-pass | ~40 min |
| domain shakeout | haiku, cascade-off, `--dev` | ~25–35 min |
| domain production baseline | sonnet, cascade-on | ~1.5–2 h |
| domain haiku sweep | haiku, cascade-on | ~1–1.5 h |
| domain opus sweep | opus, cascade-on | ~2.5–3 h |
