# External second-detector probes (lens holes, precision, recall)

Ruling: `docs/decisions/correctness-lens-hole-instrument.md`. Committed-artifact rule:
`docs/decisions/scale-track-third-party-data.md` — this directory holds **counts, names, hashes and
count tables only**. Per-finding rows, finding text, third-party file paths, PR diffs and judge
transcripts stay under `~/.devkit/research/**` (mode 0700).

## The instrument

`gate-engine/review/eval/reviewers/external/holes.mts` joins a second detector's labelled findings
to what devkit's correctness reviewer **held in scope**, **saw in full**, and **said** on the same
change, and partitions every finding before any lens attribution:

| bucket | meaning |
|---|---|
| `not-reviewed` | the change never reached the correctness reviewer with scope telemetry |
| `not-in-scope` | the finding's file was never in the reviewer's file set |
| `evidence-uncertain` | in scope, but every attempt holding the file omitted or truncated files (per-file lists are not recorded — counts only) |
| `in-evidence-unmatched` | fully shown at least once, no lens issue landed on the file (±10 lines) — **the only bucket eligible for the lens question** |
| `matched` | a lens issue landed on the same file and lines, or the external judge matched it |

`eligible` per category means the catchable denominator (`matched` + `in-evidence-unmatched`)
reaches the pre-registered minimum (8). An ineligible category is reported as such, never as a
null result.

Miss attribution is **triage only** (`triage-lens.mts`): a light judge classifies each
`in-evidence-unmatched` finding against the four lens definitions plus an explicit `none`, and its
column counts only once its agreement with hand labels reaches kappa ≥ 0.6. The verdict on a fifth
lens waits for the re-baseline (sc-2494) and a prompt-bullet A/B under the nearest existing lens.

## CodeRabbit × lens cross-tab (primary, $0) — story sc-2499

Adapter: `external/crosstab-coderabbit.mts`. Inputs: CodeRabbit root comments on devkit's own two
repositories since 2026-07-27 (when `commit_review_scope` began recording file sets), joined to
`~/.claude-usage/usage.db` through `pr_url` and, for the attempts that carry no `pr_url`, the PR
head branch. A root that is only a verification-agent trace (`🏁 Script executed` / `🌐 Web query`
with no bold finding title anywhere in the body) is dropped: 1 on devkit, 1 on frink. Bodies are
dumped in full — a first pass truncated at 1,500 chars and misread ~50 real findings per repo whose
title followed a long analysis chain as traces. Marker parse rate 100%.

Tables: `coderabbit/coderabbit-devkit-lens-holes.json`, `coderabbit/coderabbit-frink-lens-holes.json`
(generated 2026-09-02).

**devkit — 268 findings, 89 PRs, 67 reached the reviewer with scope telemetry**

| category | not-reviewed | not-in-scope | evidence-uncertain | in-evidence-unmatched | matched | eligible |
|---|---:|---:|---:|---:|---:|:--:|
| Data Integrity & Integration | 18 | 15 | 3 | 26 | 10 | yes |
| Functional Correctness | 23 | 23 | 4 | 36 | 15 | yes |
| Maintainability & Code Quality | 5 | 34 | 5 | 8 | 2 | yes |
| Performance & Scalability | 0 | 0 | 0 | 1 | 1 | no |
| Security & Privacy | 1 | 3 | 0 | 4 | 1 | no |
| Stability & Availability | 3 | 4 | 1 | 13 | 9 | yes |

**frink — 171 findings, 55 PRs, 48 reached the reviewer with scope telemetry**

| category | not-reviewed | not-in-scope | evidence-uncertain | in-evidence-unmatched | matched | eligible |
|---|---:|---:|---:|---:|---:|:--:|
| Data Integrity & Integration | 1 | 6 | 0 | 13 | 3 | yes |
| Functional Correctness | 7 | 19 | 0 | 23 | 3 | yes |
| Maintainability & Code Quality | 6 | 32 | 0 | 15 | 1 | yes |
| Performance & Scalability | 0 | 0 | 0 | 1 | 1 | no |
| Security & Privacy | 1 | 4 | 0 | 11 | 0 | yes |
| Stability & Availability | 0 | 4 | 0 | 18 | 2 | yes |

Matched, by lens — devkit: writer-reader-contracts 16 · state-transitions 8 · error-and-edge-classification 7 · concurrency-races 7; frink: concurrency-races 3 · state-transitions 3 · writer-reader-contracts 2 · error-and-edge-classification 2.

Reading (counts): over the three correctness-charter categories the reviewer independently raised
an issue on the same lines for **34 of 109** catchable findings on devkit and **8 of 62** on frink.
The `in-evidence-unmatched` bucket (75 + 54 in charter) is the population the triage classifies.

### Hand-label pass (owner proxy, 2026-09-02) — the human side of the mini-eval

93 of the unmatched in-charter findings read one by one — the ones whose title was readable under
the first, truncated dump; the ~36 re-admitted after the full re-dump are not yet hand-labelled and
show as `untriaged`. Counts by nearest lens over the 93:

| nearest lens | count |
|---|---:|
| error-and-edge-classification | 28 |
| state-transitions | 24 |
| writer-reader-contracts | 17 |
| concurrency-races | 4 |
| none | 20 |

The 20 `none` rows split: security / tenancy policy (the api-security domain, out of correctness
charter) 8; resource or liveness bounds (non-advancing cursor loops, unbounded reads, reservations
held without bound) 6; documentation wording 3; UI copy 2; test-assertion strength 1.

**Preliminary measurement (not the verdict):** no class outside the four lenses holds anything
near a majority of eligible misses. The largest unnamed cluster, resource/liveness bounds, is
6 of ~86 in-charter unmatched findings. The misses concentrate in two EXISTING lenses —
fail-open catches and validations that accept an invalid shape (error-and-edge-classification), and
flags, defaults or cleanup left in the wrong state across an operation (state-transitions) — which
is the "lens exists but does not fire" hypothesis the research ranked as option 3, testable by a
prompt-bullet A/B after the re-baseline.

Triage mini-eval, rubric v1 (haiku vs the hand labels above): devkit n=61, agreement 0.61,
**kappa 0.45**; frink n=32, agreement 0.56, **kappa 0.45**. Both sit under the pre-registered 0.6
bar, so per the ruling the triage column is reported (the `unmatchedByTriage` tables in the JSON,
stamped rubric v1) but does **not** count toward the lens rule. The confusions are almost all
between adjacent lenses (writer-reader ↔ state-transitions, none → error-and-edge), not between a
lens and `none` — evidence that the boundaries between existing lenses are fuzzy, not that a class
is missing. Rubric v2 adds explicit tie-breaks (`triage-lens.mts`, `RUBRIC_TIE_BREAKS`); run as a
second labelling round (2026-09-03) it scored **worse** against the same hand labels: devkit n=61,
agreement 0.53, **kappa 0.36**; frink n=32, agreement 0.53, **kappa 0.42**. Two rounds under the
bar, both with adjacent-lens confusions, are read as the boundary fuzziness being real; no third
rubric is planned before the prompt-bullet A/B.

## Martian Code Review Bench probe (confirmatory) — `external/martian-bench.mts`

Source: github.com/withmartian/code-review-benchmark (MIT). Offline set: 50 PRs, 173 human-verified
golden comments with severity and category. Slice run here: **Cal.com** (the only TypeScript
repository), 10 PRs, 41 goldens (bug 23 · concurrency 4 · api 4 · data 3 · speculative 2 · style 2 ·
doc_defect 1 · perf 1 · security 1). PR merge dates: 6 × 2023, 2 × 2024, 2 × 2025.

What the probe measures: devkit's four-lens correctness cascade over each PR's diff, materialized
onto its merge base in a private worktree, under an in-process review config
(`**/*.ts,**/*.tsx`; Cal.com has no `guard.config.json` and its code lives under `apps/**` and
`packages/**`, so devkit's default `src` roots would select nothing). Reviewer model for this run:
**sonnet** (owner note 2026-09-02: codex quota exhausted; the shipped gpt-5.6-sol pin runs when
quota returns and is keyed separately). Un-chunked path only: 9 of the 10 PRs sit below the
24,000-byte chunk trigger.

Findings are exported in Martian's `benchmark_data.json` shape as tool `devkit-correctness` and
judged by Martian's own pipeline (steps 2 / 2.5 / 3, `MARTIAN_MODEL=anthropic/claude-opus-4-5-20251101`
to sit beside their published evaluations). No new matcher (methodology item 18).

**Not comparable to the published leaderboard.** Martian's methodology §9: "there is no standardized
harness — we're measuring product performance, not model performance." The published tools reviewed
full forked repositories with history; this probe reviews a staged diff. Their offline README also
warns of training-data leakage on these well-known PRs; memorization inflates recall, which
*shrinks* apparent holes — conservative for the lens question, invalidating for any calibration
claim. The published tools serve only as a qualitative sanity band on this slice (recall 0.12–0.78
across ~50 tool variants under their Opus 4.5 judge; every judged golden was found by at least one
tool). Profiles: **All** (41) for the miss partition, **Core / F2** (Martian's defaults) for any
score; TP and FN are category-filtered, FP is not; a golden keeps only its highest-confidence
candidate and one candidate may credit several goldens.

Goldens are not all known-answer: roughly one per PR is fix-commit anchored (Greptile's backtrack),
the rest are annotator prose (Augment's expansion). No absolute-recall claim is made from the
second group.

Run of 2026-09-02 (sonnet, whole-diff, issue cap 3, judge parallelism 2): all 10 PRs terminal,
40 lens judgements, 35 findings exported.

| PR | findings | goldens | | PR | findings | goldens |
|---|---:|---:|---|---|---:|---:|
| #7232 | 4 | 3 | | #11059 | 9 | 9 |
| #8087 | 1 | 2 | | #14740 | 6 | 6 |
| #8330 | 2 | 2 | | #14943 | 2 | 2 |
| #10600 | 4 | 5 | | #22345 | 0 | 2 |
| #10967 | 6 | 6 | | #22532 | 1 | 4 |

Scores: Martian's own step3 judge needs an OpenAI-compatible API key (any provider; the pipeline
is hardcoded to that client). Until one is configured, `external/martian-prejudge.mts` runs their
JUDGE_PROMPT verbatim through the local `claude` CLI (haiku) as a PROXY — same prompt, different
judge, no extraction/dedup steps — and `martian-report.mts` reduces it. Proxy numbers are
labelled as such wherever they appear and are superseded by the real judge run.

**Preliminary result, 2026-09-02 — reviewer sonnet, judge haiku PROXY** (`martian/cal_dot_com-sonnet-haiku-proxy-summary.json`):

| profile | tp | fp | fn | P | R | F1 | F2 |
|---|---:|---:|---:|---:|---:|---:|---:|
| strict | 18 | 17 | 17 | 0.51 | 0.51 | 0.51 | 0.51 |
| core (Martian default) | 18 | 17 | 19 | 0.51 | 0.49 | 0.50 | 0.49 |
| all | 18 | 17 | 23 | 0.51 | 0.44 | 0.47 | 0.45 |

Miss partition (All, 41 goldens): matched 18, in-evidence-unmatched 23, none in the scope or
evidence buckets (every Cal.com PR sat under the 60 KB cap, so every miss was a true in-evidence
miss). By golden category: concurrency 4 of 4 matched, data 2 of 3, api 1 of 4, security 1 of 1,
bug 10 of 23; every style / speculative / doc_defect / perf golden missed (out of the correctness
charter). Matched by lens: error-and-edge-classification 8, state-transitions 5, concurrency-races
2, writer-reader-contracts 3.

Sanity band on the SAME 10 PRs from Martian's published Opus-4.5 evaluations, Core profile
(NOT comparable — different judge, and those tools reviewed full forked repos; see above):
augment 0.74 · copilot-v2 0.71 · qodo-v2 0.69 · coderabbit 0.61 · gemini-v2 0.58 · greptile-v5
0.56 · bugbot 0.52 · macroscope 0.52 · claude-code 0.51 · cubic-v2 0.51 · claude 0.50 · devin 0.47
· graphite 0.16 (F2; 49 tool variants, upper quartile 0.51). devkit's correctness-only cascade at
F2 0.49 lands beside Claude Code and Macroscope on this slice — with only the correctness
reviewer running (no api-security / performance reviewers), which is where the api and perf
goldens would have gone.

## Reproducing

```
# CodeRabbit cross-tab (needs gh auth + the collector DB)
bun gate-engine/review/eval/reviewers/external/crosstab-coderabbit.mts --repo norvalbv/devkit
bun gate-engine/review/eval/reviewers/external/triage-lens.mts --findings <...>.findings.jsonl --bodies <...>.jsonl --human <labels.jsonl>

# Martian probe
bun gate-engine/review/eval/reviewers/external/martian-bench.mts --repo cal_dot_com --model sonnet --dry-run
bun gate-engine/review/eval/reviewers/external/martian-bench.mts --repo cal_dot_com --model sonnet
# then the printed Martian commands, then:
bun gate-engine/review/eval/reviewers/external/martian-report.mts --repo cal_dot_com --model sonnet --evaluations <evaluations.json>
```
