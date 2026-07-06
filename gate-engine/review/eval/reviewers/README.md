# reviewer-eval

Benchmark for the **domain pre-commit reviewers** (api-security, backend-performance,
frontend-security, frontend-performance) — the `guard-review --gate` cascade judges. It exists to
answer two questions with numbers instead of vibes:

1. **Model choice** — can the first pass drop from sonnet to haiku without losing blocks?
2. **Regression protection** — did a brief/checklist/catalog edit help or hurt?

It drives the **real gate** (`runCascade` from `../../run-review.mts`) over disposable fixture
repos, so bench and gate cannot drift. commit-guard is out of scope (its allowlist needs the
consumer's semantic-search MCP tool, unresolvable in a bare fixture); a future correctness
reviewer joins by adding `cases-correctness.jsonl` + its REVIEWERS entry.

**Bench-only, never shipped.** This directory is excluded from tsc and the build
(`**/eval/**`), and the package publishes `dist/` only. `mine-bots.mts` calls the GitHub API on
private repos — it is quarry-gathering for corpus authorship, must never run in any gate or
production path, and its output (`candidates.jsonl`) is gitignored.

## Usage

```bash
node bench.mts validate [reviewer]      # 0 LLM calls — corpus linter (run before any spend)
node bench.mts coverage                 # 0 LLM calls — catalog/type coverage
node bench.mts run [reviewer|all] [--dev] [--only <idPrefix>] [--baseline] [--fail]
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

The standard sweep sequence:

```bash
node bench.mts validate                                  # free
BENCH_MODEL=haiku BENCH_CASCADE=off node bench.mts run --dev   # ~25–35 min shakeout
node bench.mts run --baseline                            # sonnet cascade-on, ~1.5–2 h
BENCH_MODEL=haiku node bench.mts run                     # ~1–1.5 h → decision rule below
BENCH_MODEL=opus node bench.mts run                      # ~2.5–3 h ceiling reference (run once)
```

## Corpus

One JSONL file per reviewer (`cases-<skill>.jsonl`), 12 rows each: 6 gold seeded-bugs (distinct
catalog items; 3 clear / 2 borderline / 1 adversarial), 3 clean decoys (trigger ≥2 checklist
items, genuinely fine), 2 near-miss decoys (look vulnerable, provably safe), 1 minimal pair
(`variantOf`: the fixed twin of a gold row, expected PASS). 2 rows per file are `holdout: true`
(excluded by `--dev`, included in baselines). Dataset-card fields per row: `note` (mandatory
why), `difficulty`, `provenance` (`authored`/`mined`/`adapted` — mined rows are anonymized
adaptations of real CodeRabbit/Macroscope findings from our PR history), `variantOf`.

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
`--baseline` after deliberate changes. At 48 rows this bench is a **large-effect tripwire, not
a 5pp detector** — intervals print so nobody over-reads a point estimate.

## Pre-registered haiku decision rule

Written BEFORE the first sweep; the sweep does not get to move the goalposts.

Convert the production first pass to haiku (`GUARD_REVIEW_MODEL` default `'sonnet'` →
`'haiku'`) **iff both**:

1. Haiku **end-to-end block recall** shows no statistically significant one-directional
   regression vs the sonnet baseline (per-reviewer flip tables, McNemar mid-p ≥ 0.05, holdouts
   included), and
2. Haiku **first-pass clean-pass ≥ 0.70** — below that, wasted opus escalations (≈ falseFailRate
   × ~4 min opus per commit) erase the latency/cost win.

The opus sweep is a ceiling reference only — it does not gate the decision.

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

## Cost (48 rows, concurrency 2)

| run | config | wall-clock |
|---|---|---|
| shakeout | haiku, cascade-off, `--dev` | ~25–35 min |
| production baseline | sonnet, cascade-on | ~1.5–2 h |
| haiku sweep | haiku, cascade-on | ~1–1.5 h |
| opus sweep | opus, cascade-on | ~2.5–3 h |

A budget line prints before any token is spent; every run appends one line to `runs.log`.
