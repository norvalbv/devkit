# Growing the reviewer benchmarks — the operating manual

> **What this is:** the runbook for the corpus-growth system built 2026-08-01. The *rules* live in
> [`benchmark-methodology.md`](benchmark-methodology.md) (20-item checklist + telemetry-corpora
> addendum); the *why* lives in
> [`../decisions/benchmarks-grow-from-telemetry.md`](../decisions/benchmarks-grow-from-telemetry.md);
> the *bench mechanics* live in
> [`../../gate-engine/review/eval/reviewers/README.md`](../../gate-engine/review/eval/reviewers/README.md).
> This file is the how-and-when: the loop, the tools, the cadence, and what's still pending.

## The core idea

Every row used to cost human authoring. But the gates adjudicate real findings every day and used
to discard the evidence. The durable target (decision record above): **benchmarks grow from
verdict-labeled telemetry, not authoring.** A reviewer FAIL that gets fixed is a gold candidate. A
FAIL that gets waived/overridden with a rationale is a decoy candidate. A ship that PASSed but an
external bot (or human) later flagged is a recall-miss candidate — and the thread's resolution
(fix committed vs rebutted) is the label. Humans do disagreement-triage only (methodology item 19).

## The loop

```
ship gates adjudicate ──► telemetry captures ──► mine ──► propose ──► adapt ──► finalize
        ▲                                                                          │
        │                                                                          ▼
   reviewer improves ◄── decide (A/B, pre-registered) ◄── publish ◄── bench ◄── validate
```

Each stage, concretely (all paths under `gate-engine/review/eval/reviewers/` unless noted):

| Stage | Tool | What it does / enforces |
|---|---|---|
| capture | `gate-engine/review/evidence/diff-archive.mts` | On every reviewer FAIL in the real gate, archives the exact staged diff bytes to `<telemetry>/diffs/<diff_sha256>.diff.gz` — content-addressed, fail-open, 8 MiB cap. Bench runs can never trigger it. Join key = the `diff_sha256` already on the `review_scope` event. |
| mine | `mine-bots.mts` | Sweeps bot PR comments via `gh api` (+ GraphQL thread resolution). Labels each candidate: `outcome` (fixed / rebutted / unresolved) + `outcomeEvidence` (addressed-marker › bot-withdrawal › resolved+line-touched › human-rebuttal › outdated-only) + `scopeConfirmed` via the collector join (`commit_ships.pr_number` → `commit_review_scope.files_json`). Writes `candidates.jsonl` (gitignored, merged by url). |
| propose | `propose.mts --suite <s> --max N` | Deterministic triage: hard drops (unresolved, no commit anchor, no line info, outdated-only, truncated hunk, already-in-corpus), category+path routing to the five suites, priority sort, base-content fetch pinned to `?ref=<originalCommitId>` (observation-instant inputs — item 13). Output: `raw/queue-<suite>.jsonl`. |
| adapt | agents (workflow) | Each queue entry becomes an ANONYMIZED minimal fixture (1–2 files, ≤25 lines, generic identifiers — devkit is public) + **a minimal-pair decoy per gold** (real fix applied, `variantOf`, shared `caseId`). Rebutted threads become standalone PASS decoys. Every proposal self-validates via `finalize.mts --check` before it counts. |
| finalize | `finalize.mts --check / --append` | `--check`: structural lint → real-fixture `validateRow` → private-repo leak scan. `--append`: exclusive stale-aware lock, audit-overlay application, pre-append lint + leak scan, deterministic holdout (PASS→dev bias; ≥3-holdout floor outranks it, flips reported), caseId groups never split. Proposals in `raw/` are IMMUTABLE — audit edits only via `raw/audit-overlay.jsonl` `{ref, set}` lines (item 5). |
| validate | `bench.mts validate [reviewer]` | 0 LLM calls. Real fixture materialization, expectItems vs the real checklist, reasonPattern must compile (hard fail), comment-leakage warnings (non-fatal). |
| bench | `bench.mts run <reviewer> [--baseline]` | Drives the REAL `runCascade` — bench and gate cannot drift. Correctness is pinned sonnet single-pass; domain reviewers run `BENCH_MODEL` first-pass with opus escalation (cascade). Progress checkpoints per row; salvage is per-row (`rowHash`), so re-runs are cheap. |
| publish | `gate-engine/eval/cli.mts publish --suite reviewer-<x> --tree WORKTREE --baseline ... --change-type coverage` | Corpus changes MUST publish as `coverage` (the hash guard blocks `quality`). Acceptance: zero outages + floors. Needs a completely clean worktree. |

### Why appending rows is safe (the row-set hash)

`corpusHash` is a hash of sorted per-row content hashes, and every consumer — baselines, progress
salvage, the stability rerun, `compareReviewer` — pairs **per-row** via `rowHash`. Appending rows
never invalidates comparisons over retained rows. This is what makes a continuously-fed corpus
possible at all; before 2026-08-01 any append reset comparability.

## Capture points — built vs pending

| # | Capture | Status 2026-08-01 | Mints |
|---|---|---|---|
| 0 | Diff-bytes archive on FAIL | **SHIPPED** (#295) | replayable inputs (~12 correctness FAILs/day) |
| 1 | Fail → fix correlation (collector links consecutive ship attempts; next diff touches flagged lines) | pending (~1 day, dashboard side) | golds, zero human steps |
| 2 | `guard-review waive <reviewer>[:<lens>] "<rationale>"` | pending (~½ day; the `disposition:'waived'` column exists) | decoys with rationale as note |
| 3 | Bot mining (CodeRabbit/Macroscope threads) | **SHIPPED** (#295/#296) | golds + decoys, bootstrap corpus |
| — | Override valve (`OVERRIDE_<id>_RATIONALE`, `correctness-overrides.json`) | already live — mine `commit_review_lenses` | decoys (historical, unmined) |
| — | Human PR review comments | banked in the collector, unmined | labels |

CodeRabbit is the bootstrap, not the pipeline: telemetry sees every adjudication pre-PR with exact
bytes; the bots only see what reached a PR.

## When to re-bench (cadence rules)

**On change, not on schedule.** Each suite hashes four axes (implementation / corpus / scorer /
runner); freshness goes stale exactly when one moves.

- **Corpus batch merged** → `validate` immediately (free) → re-bench that suite → publish
  `--change-type coverage`. Incremental cost ≈ the new rows only (per-row salvage).
- **Reviewer prompt/skill/model edit** → A/B with `--against <before.json>` BEFORE landing it
  (gold-only + decoy-only + clustered-by-case flip tables; `--against` works across a deliberate
  gateHash change) → publish `quality` after. The publish hash guard enforces this ordering.
- **No calendar sweeps.** The only scheduled item worth having: a periodic staleness audit of the
  tracker (any suite with moved hashes and no new checkpoint).
- Cost anchors (concurrency 2): sonnet ≈135 s/row first-pass; haiku ≈70 s; escalations ≈210 s.
  Correctness at 120 rows ≈ 2.5–3 h sonnet.

## Honest-measurement rules (the ones that bite)

1. **Localized-fixture recall, not production recall.** Fixtures are 1–2 files ≤25 lines;
   production correctness inputs average ~7.9 files / 26 KB. Say so in every checkpoint note.
   The planned calibration slice (replay ~10 scope-confirmed misses at FULL context, locally,
   never committed) turns this caveat into a number.
2. **Mined gold = precision + relative recall only** (item 17). Absolute recall needs
   known-answer imports — c-CRAB (arXiv 2603.23448) and CR-Bench (arXiv 2603.11078), filtered to
   TS/JS. This is the only realistic absolute-recall path for the security suites.
3. **No delta is believed before the noise floor** (item 4): κ blind-relabel (40–60 rows, labeler
   must be non-Claude or human, sees ONLY repo.base/staged) + cleanlab confident-learning floor.
   Delta < (floor + paired CI) = unresolved, not a win.
4. **The pin question is pre-registered** (plan of record): single-pass arms only may become the
   correctness pin; the haiku→opus cascade arm is measurement-only — a scoped decision record
   (`correctness-reviewer-precision`) forbids that mechanism, and its own prescribed precision fix
   is K-sample self-consistency once decoys reach ~120 (at 55 after batch 2). MDE at current n is
   ~8–10 pp; smaller true differences will read as no-change.
5. **A bench the reviewer aces has gone stale.** The gap is the signal; the loop's job is to keep
   regenerating it, not to be driven to 1.0.

## State as of 2026-08-01

- Corpus: correctness 66→120 (65 gold / 55 decoy), api-security 14→30 (first mined domain rows).
  Backend-perf 13, frontend pair 31 each — untouched this cycle.
- Checkpoint `evt-2026-08-01-reviewer-correctness-b0dc29a7d531` (sonnet pin, 90 rows, zero
  outages): first-pass FAIL-recall 44/50 = 0.88 [0.76, 0.94], clean-pass 32/40 = 0.80 [0.65, 0.90].
  The mined rows hardened the suite (0.92 → 0.88 vs the 66-row checkpoint); 5 of 8 false FAILs
  were minimal-pair decoys — the predicted precision weakness, now measurable.
- Yield funnel from the first mining pass: 749 candidates → 479 fixed / 34 rebutted / 236
  unresolved → hard drops (232 unresolved-outcome, 179 out-of-charter, 113 truncated-hunk, 27
  already-in-corpus) → 23 gold+pair sets landed across two batches. Rebutted threads mostly fail
  extraction (no line anchors) — relaxing that path is the next miner improvement.

## Pending work, in order

1. `guard-review waive` + collector attempt-correlation (capture points 1–2) — makes the loop
   fully CodeRabbit-independent.
2. κ relabel + cleanlab floor (preconditions for any Phase-5/pin decision).
3. Calibration slice (localized vs full-context delta).
4. Domain-suite cascade re-bench (needs opus) now that api-security has 30 rows.
5. c-CRAB / CR-Bench known-answer import for absolute recall (security suites especially).
6. Mine the override-valve history + human review comments (decoy/gold sources already banked).
7. Optional: weekly scheduled routine (mine → propose → adapt → draft corpus PR).
