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
| propose | `propose/propose.mts --suite <s> --max N` (bot-mined) · `propose/propose-telemetry.mts [--max N]` (gate telemetry — no PR/commit anchor, diff bytes ride in the rows, evidence-tier sort) | Deterministic triage: hard drops (unresolved, no commit anchor, no line info, outdated-only, truncated hunk, already-in-corpus), category+path routing to the five suites, priority sort, base-content fetch pinned to `?ref=<originalCommitId>` (observation-instant inputs — item 13). Output: `raw/queue-<suite>.jsonl`. |
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
   known-answer imports. **Scoped 2026-08-02 — the original plan (c-CRAB arXiv 2603.23448 /
   CR-Bench arXiv 2603.11078 "filtered to TS/JS") is not viable**: both are Python-derived
   (c-CRAB builds on SWE-CARE, CR-Bench transforms SWE-Bench — neither contains any TS/JS
   instances to filter), c-CRAB's artifact repo (github.com/c-CRAB-Benchmark/dataset) carries no
   license, and CR-Bench has no publicly released artifact. RATIFIED 2026-08-03 (owner): replacement (a) is BUILT — `mine-ghsa.mts` + `propose/propose-ghsa.mts` sweep npm advisories with fix-commit anchors (165 anchored candidates on the first sweep); adapted rows carry `provenance:'known-answer'`, the only provenance whose golds support absolute-recall claims. (b) stays deferred post-epic. Original options for the record:
   (a) mine GHSA/npm advisories with fix commits directly — public known-answer facts,
   re-expressed as anonymized fixtures like every other row, the natural api-security /
   frontend-security source (SecBench.js catalogs ~600 such vulns but is itself unlicensed —
   use it as an index, not a source); (b) apply CR-Bench's transformation recipe (blame →
   PR lookup → detectability filter, Alg. 1 of the paper) to SWE-Bench Multimodal's JS/TS
   repos for correctness-suite known-answer rows. Absolute-recall numbers stay blocked until
   one of these is ratified and built.
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

## State as of 2026-08-02

- Corpus: correctness 66→120 (65 gold / 55 decoy), api-security 14→30 (first mined domain rows).
  Backend-perf 13, frontend pair 31 each — untouched this cycle.
- Checkpoint `evt-2026-08-01-reviewer-correctness-b0dc29a7d531` (sonnet pin, 90 rows, zero
  outages): first-pass FAIL-recall 44/50 = 0.88 [0.76, 0.94], clean-pass 32/40 = 0.80 [0.65, 0.90].
  The mined rows hardened the suite (0.92 → 0.88 vs the 66-row checkpoint); 5 of 8 false FAILs
  were minimal-pair decoys — the predicted precision weakness, now measurable.
- **κ blind relabel (2026-08-02, cross-family per item 12)**: Codex labeled the 48-item blind
  bundle — raw κ 0.662 (agreement 0.833). Disagreement triage (item 19): 6 of 8 stored labels
  stood; **2 were genuine fixture errors** (an empty BUNDLED_RULES array gutting a validation
  gate in a PASS row; an unvalidated shell-interpolated branch name in another) — both repaired.
  **First empirical label-noise floor: 2/48 ≈ 4.2%, Wilson 95% CI [1.2%, 13.9%]** — the interval
  is wide at n=48 and its upper bound is ~3× the point estimate, so 4.2% is a working lower bound,
  not a settled figure; re-estimate as the corpus grows. Item 4's rule is
  `Delta < (floor + paired CI)`, and the floor carries its own sampling uncertainty on top of the
  benchmark delta's — a 6pp delta is not automatically a win. Excluding the 2 defective items,
  κ = 0.735 (above the 0.667 bar); post-triage effective agreement ≈ 0.87.
- **House rule the triage established, now enforced across minimal pairs**: within a pair, only the
  labeled defect may differ, and a PASS twin may carry no unlabeled defect of its own. A PASS row
  that splices request-derived data into a shell string is a false-FAIL magnet — the reviewer that
  reports it is right and gets scored wrong. Three rows were normalized under this rule beyond the
  two the relabel caught. In the `corr-pr21` pair, both twins now execute via argv-based
  `execFileSync`, leaving the gold twin's missing `TARGET_RE` shape check as the sole behavioral
  difference. In the `apisec-masked-pipe-failure-approval` pair, both twins shape-check the uuid
  and both keep `runShell` — the gold defect is a masked pipe exit status and a pipe needs a shell,
  so holding the mechanism constant is what keeps `| head -1` the sole behavioral difference.
  These three came from review, **not** from the blind bundle, so they do not enter the 2/48 floor
  above — that figure is the blind relabel's measurement and stays as measured.
- Yield funnel from the first mining pass: 749 candidates → 479 fixed / 34 rebutted / 236
  unresolved → hard drops (232 unresolved-outcome, 179 out-of-charter, 113 truncated-hunk, 27
  already-in-corpus) → 23 gold+pair sets landed across two batches. (The "rebutted threads mostly
  fail extraction" premise was falsified 2026-08-02: 25 of 34 already survived; #306 waived the
  two hunk drops for rebutted rows, freeing the remaining viable 3 — none die on line anchors.)

## Pending work, in order

1. `guard-review waive` + collector attempt-correlation (capture points 1–2) — makes the loop
   fully CodeRabbit-independent.
2. cleanlab confident-learning floor (the remaining precondition for any Phase-5/pin decision —
   the κ blind relabel landed 2026-08-02, see "State as of 2026-08-02"). cleanlab multiannotator
   was uninformative at 2 raters without model `pred_probs`; it needs per-row predicted
   probabilities from a bench run, not another labeler.
3. Calibration slice (localized vs full-context delta).
4. Domain-suite cascade re-bench (needs opus) now that api-security has 30 rows.
5. Known-answer import for absolute recall (security suites especially): ratify and build one of
   the replacements in measurement-rule 2 (GHSA/npm advisory mining, or the CR-Bench recipe over
   SWE-Bench Multimodal) — the original c-CRAB / CR-Bench TS/JS import was scoped 2026-08-02 and
   is not viable.
6. Mine the override-valve history + human review comments (decoy/gold sources already banked).
7. Optional: weekly scheduled routine (mine → propose → adapt → draft corpus PR).
