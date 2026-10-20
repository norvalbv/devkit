# Benchmark evidence tracker

This directory is the public, machine-verifiable record of devkit benchmark evidence. It answers three different questions without collapsing them into one badge:

1. What agents, judges, tools, and benchmark runners exist?
2. Which claims have accepted evidence, and is that evidence current for today’s implementation and methodology?
3. What changed between comparable checkpoints: quality, coverage, methodology, or a no-ship decision?

## Sources of truth

- `catalog.json` declares canonical subjects, suites, adapters, hash inputs, and acceptance policies.
- `history.jsonl` is the semantic append-only ledger. Existing event IDs and bytes are immutable; a correction appends a superseding event.
- `checkpoints/<sha256>.json` preserves sanitized row-level evidence for every accepted event. The filename is the SHA-256 of its canonical bytes.
- `assets/dashboard-{light,dark}.svg` and the marked README sections are deterministic generated views.

Suite-local `results.baseline.json` files may continue to move for regression mechanics. They are not historical storage.

## Independent status axes

| Axis | Values | Question answered |
| --- | --- | --- |
| Lifecycle | `shipped`, `experimental`, `no-ship` | Is the subject in production, under study, or deliberately not shipping? |
| Evidence | `accepted`, `evidence-only`, `external-required`, `none` | What provenance supports the claim? |
| Freshness | `current`, `stale`, `unknown` | Do implementation, corpus, scorer, and runner hashes still match? |
| Change type | `quality`, `coverage`, `methodology-reset`, `no-ship` | What kind of movement occurred? |
| Assessment | `improved`, `regressed`, `flat`, `mixed`, `unknown` | How did comparable metrics move under the suite adapter? |

Coverage growth is not quality growth. A methodology reset is not a regression. A no-ship result is useful evidence, not a failed benchmark.

## Event and checkpoint contract

Metric observations retain their stable ID, direction, unit, raw numerator/denominator where available, interval method and bounds, inference unit, suite threshold, and MDE/noise floor when defined. Comparisons retain the predecessor, shared-row population, discordant flips, statistical method, and adapter verdict.

Each suite adapter owns its acceptance semantics. LLM suites can require K=3 and zero outages; deterministic, external, and no-ship studies use different contracts. The renderer never invents a universal significance rule.

## Decision rationale and history

The [benchmark evidence decision](../decisions/benchmark-evidence-append-only.md) contains the
retrospective PR595–603 map and the boundary for reusing this work in other agents. Detailed
commands, measurements and receipts stay here; durable choices and their tradeoffs live in decisions.

| Question | Governing record |
| --- | --- |
| What makes a source case and its repair admissible? | [Telemetry and source controls](../decisions/benchmarks-grow-from-telemetry.md), [coverage and family admission](../decisions/corpus-rows-admitted-by-coverage-cell.md) |
| Did a block identify the intended bug, and were repeated findings valid? | [Claim measurement](../decisions/reviewer-claim-measurement.md), [precision constraints](../decisions/correctness-reviewer-precision.md) |
| What evidence did each native task receive? | [Chunking and its measurement limits](../decisions/correctness-chunking-ships-dark.md) |
| What must a comparison with review history preserve? | [History experiments](../decisions/reviewer-history-experiments.md) |
| Which evidence can be committed publicly? | [Third-party data boundary](../decisions/scale-track-third-party-data.md) |

The retrospective notes preserve the earlier conclusions and later corrections. They do not
turn exposed cases into unseen evidence, qualify unresolved repairs, or claim a history benefit.

## Findings and research records

Hand-written records that sit beside the ledger; each number in them names its population, `n`, and query.

- [`benchmark-methodology.md`](benchmark-methodology.md) — the house checklist for building any benchmark; items 21–26 cover numbers derived from gate telemetry.
- [`decisions-findings.md`](decisions-findings.md) — decision-log benchmarks: findings, corrections, open work (sc-1236).
- [`reviewer-yield-vs-diff-size.md`](reviewer-yield-vs-diff-size.md) — the review gate returns ~1 issue per run above ~1k LOC and the corpus never measures that regime (2026-08-22).
- [`corpus-growth.md`](corpus-growth.md) — how corpus rows are mined from telemetry and adapted.
- [`2026-09-13 source qualification`](experiments/2026-09-13-source-qualification/README.md) — actual Vue retry and TanStack resubscription controls; one qualified proposal pair, no corpus admission or new model scores.
- [`source-family-census.md`](source-family-census.md) — source-qualified candidate families and exact native initial-evidence coverage (zero reviewer calls).
- [`source-family-qualification-2026-09-06.md`](source-family-qualification-2026-09-06.md) — source-controlled reply extraction and unresolved delivery-boundary qualification (sc-2866).
- [`correctness-rebaseline-2026-09-04.md`](correctness-rebaseline-2026-09-04.md) — correctness re-baselined on the shipped gpt-5.6-sol pin: recall 0.92, clean-pass 0.60, and the precision loss sits entirely in the fix-pair decoys (sc-2494).
- [`experiments/`](experiments/) — one folder per investigation with its inputs, arms, and reports (for example: [`2026-08-24-codex-judge-probe`](experiments/2026-08-24-codex-judge-probe/README.md) — OpenAI codex-CLI models as gate judges on the round-1 corpus: gpt-5.6-sol@chunk:400 13/23 and gpt-5.6-terra@xhigh WHOLE-diff 11/23 vs sonnet's best 8/23, ~perfect checklist compliance across 840 tasks (839 terminal); chunk size and reasoning effort proved ALTERNATIVE strategies, and terra's effort curve is a cliff at xhigh. Prior: [`2026-08-23-scale-probe`](experiments/2026-08-23-scale-probe/README.md) — whole-diff vs chunked correctness review on 8 real 1k–7.2k-LOC diffs: chunking pooled ≥ whole-diff under all five mining/scoring rulesets tried (shipped ruleset: chunk:1000 8/23 vs whole 5/23 on decontaminated labels), but the ratio moves 1.375×–2.0× with the ruleset so no registered bar is treated as cleared — decision moved to the confirmation round; ~half the round's original labels were test-retest contamination, since fixed; haiku judges failed their arms; full correction record inside. Prior: [`2026-08-22-ship-attempts-research`](experiments/2026-08-22-ship-attempts-research/README.md)).

## Backfill rule

Every folder in [`experiments/`](experiments/) dated 2026-08-01 or later whose subject is the
correctness reviewer and that records a written verdict (adopt, reject, no-ship or do-not-build) has
a ledger event, whatever the result. A folder with no accepted checkpoint gets an `evidence-only`,
`committed-summary` event whose `sourceCommit` is the commit that added its README. A folder the rule
selects but the ledger cannot hold is listed below with the reason.

## Not in the ledger

Correctness experiments with a verdict but no ledger event:

- [`2026-08-04-correctness-lens-split`](experiments/2026-08-04-correctness-lens-split/README.md) — its [ruling](../decisions/correctness-lens-split-ab-unresolved.md) bars publishing any arm to the tracker: the runs used an uncommitted scorer.
- [`2026-10-12-lens-first-attempt-recall`](experiments/2026-10-12-lens-first-attempt-recall/README.md) — do-not-build (0/20 and 0/20 on two real misses); no suite measures first-attempt recall on real misses.

Decision-log experiments with a verdict; no suite covers the decisions writers:

- [`2026-10-11-note-restatement`](experiments/2026-10-11-note-restatement/README.md) — FAIL; the `--kind alters --ruling` option was not built.
- [`2026-10-11-retarget-carry-replay`](experiments/2026-10-11-retarget-carry-replay/README.md) — FAIL; the writer carried 8 of 18 retired notes (bar 4), so the carry/drop listing was not built.
- [`2026-10-16-note-mention-replay`](experiments/2026-10-16-note-mention-replay/README.md) — measured, not built: no arm met the pre-fixed pass rule.

## Contributor workflow

When a suite's registered `results.baseline.json` moves, its checkpoint and accepted event must land
in the SAME commit as the new baseline — that is what the staged gate checks. Publish from the Git
index so the published bytes are the bytes being committed:

```bash
# 1. re-run the suite, then stage the change together with the baseline it moved
git add gate-engine/judge/matcher-core.mts gate-engine/critique/eval/results.baseline.json

# 2. publish from the index; this is the LAST staging step for source files
node gate-engine/eval/cli.mts publish --suite critique --tree STAGED \
  --change-type methodology-reset --note "measured prompt revision"

# 3. stage publish's own outputs, then commit all of it at once
git add docs/benchmarks/history.jsonl docs/benchmarks/checkpoints/<sha256>.json \
  README.md docs/benchmarks/README.md docs/benchmarks/assets/dashboard-*.svg
```

Staging further source changes after publishing moves a suite hash and flips its freshness, which
reports `Generated output is stale`. Re-render from the index with
`bun run benchmarks:render -- --tree STAGED` and re-stage; never publish a second time for it.

```bash
# Publish an adapter-accepted baseline from a committed tree and regenerate views
node gate-engine/eval/cli.mts publish --suite critique --tree HEAD \
  --change-type quality --assessment improved --note "measured prompt revision"

# Correct an accepted claim by appending a new event; the referenced event remains byte-for-byte intact
node gate-engine/eval/cli.mts publish --suite critique --tree HEAD \
  --supersedes <event-id> --recorded-at <new-ISO-8601-time> --assessment improved

# Render without publishing
bun run benchmarks:render

# Validate the working tree, Git index, or committed tree
bun run benchmarks:check
bun run benchmarks:check -- --mode staged
bun run benchmarks:check -- --mode tree --tree HEAD --base <base-sha>

# Inspect historical candidates; local logs are aggregate-only and opt-in
node gate-engine/eval/cli.mts backfill --since 2026-07-01

# Union parallel-worktree additions; duplicate IDs with different bytes fail
node gate-engine/eval/cli.mts reconcile left.jsonl right.jsonl --output merged.jsonl
```

`publish` derives assessment from adapter metrics, their MDE/noise floors, and shared-row flips. The optional `--assessment` value is an assertion: publication fails if it contradicts that derived result. Publishing defaults to a committed Git tree. `--tree STAGED` publishes the Git index, so the published bytes are the bytes being committed; it refuses an unmerged index, an empty one, and a `history.jsonl` or checkpoint that differs between index and working tree, and its `sourceCommit` names the parent commit the index was staged over. `--tree WORKTREE` is only accepted when the entire working tree is clean, so its commit provenance cannot describe uncommitted bytes; it stays the route for a gitignored baseline, which can never be staged and never dirties the tree.

`publish`, `render`, and `check` are deterministic and make no network or LLM calls, except that `--tree STAGED` stamps wall-clock capture time — pass `--recorded-at` to pin it. Corrections become authoritative generated-view inputs through `supersedes`, while both the original and corrective event bytes remain in the ledger.

## Privacy boundary

Committed evidence rejects raw prompts, transcripts, absolute paths, email addresses, unpublished Git refs, local branch names, and private source text. Backfill reads opted-in local ledgers only to count aggregate rows. Rejected candidates leave counts, not content.

<!-- benchmark-details:start -->
## Current suite dashboard

| Suite | Lifecycle | Evidence | Freshness | Change | Assessment | Latest evidence |
| --- | --- | --- | --- | --- | --- | --- |
| Prior-art validation | experimental | evidence-only | unknown | — | ? unknown | No accepted local checkpoint |
| Feature critique | shipped | accepted | stale | methodology-reset | ? unknown | Gold finding recall: 23/25 (92.0%) · Clean-plan pass rate: 5/5 (100.0%) |
| Feature completeness | shipped | accepted | stale | methodology-reset | ? unknown | Gold gap recall: 25/35 (71.4%) · Decoy false-flag rate: 2/27 (7.4%) |
| Repository conventions | shipped | accepted | stale | quality | ? unknown | Gold gap recall: 18/18 (100.0%) · Decoy false-flag rate: 1/14 (7.1%) |
| API security reviewer | shipped | accepted | stale | coverage | ? unknown | first-pass FAIL recall: 8/8 (100.0%) · first-pass clean pass: 5/6 (83.3%) · block recall: 8/8 (100.0%) · clean pass: 6/6 (100.0%) |
| Backend performance reviewer | shipped | accepted | stale | coverage | ? unknown | first-pass FAIL recall: 7/7 (100.0%) · first-pass clean pass: 3/6 (50.0%) · block recall: 7/7 (100.0%) · clean pass: 6/6 (100.0%) |
| Frontend security reviewer | shipped | accepted | stale | coverage | ? unknown | first-pass FAIL recall: 11/11 (100.0%) · first-pass clean pass: 7/8 (87.5%) · block recall: 10/11 (90.9%) · clean pass: 8/8 (100.0%) |
| Frontend performance reviewer | shipped | accepted | stale | coverage | ? unknown | first-pass FAIL recall: 10/11 (90.9%) · first-pass clean pass: 7/8 (87.5%) · block recall: 10/11 (90.9%) · clean pass: 7/8 (87.5%) |
| Correctness reviewer | shipped | accepted | stale | methodology-reset | ? unknown | first-pass FAIL recall: 102/105 (97.1%) · first-pass clean pass: 117/180 (65.0%) |
| Decision governance | shipped | evidence-only | unknown | quality | ↑ improved | Detect accuracy: 45/49 (91.8%) · DECISION recall: 8/9 (88.9%) |
| Sentry capture judge | shipped | evidence-only | unknown | quality | ↑ improved | Commit-message F1: 56/100 (56.0%) · Focused-diff F1: 87/100 (87.0%) |
| Edge-case autonomy | no-ship | accepted | stale | no-ship | ? unknown | Judge-free ceiling: 51.2% · Pre-registered target: 35.0% |
| Decision-log retrieval recall | experimental | accepted | stale | methodology-reset | ? unknown | Gold axis retrieved: 12/12 (100.0%) · Multi-axis set recall: 3/4 (75.0%) |
| Decision-log save quality | experimental | accepted | stale | coverage | ? unknown | Defect recall (perturbation corpus): 15/15 (100.0%) · False-positive rate at R80: 0/20 (0.0%) |
| Decision brief: rule kept on edit | experimental | accepted | stale | quality | ↑ improved | Rule kept: brief only, agent cannot read on (best-case tasks): 36/40 (90.0%) · Rule kept: brief, agent may read on (best-case tasks): 38/40 (95.0%) |
| Semantic search retrieval | experimental | evidence-only | unknown | — | ? unknown | No accepted local checkpoint |
| Duplication matcher | shipped | evidence-only | unknown | — | ? unknown | No accepted local checkpoint |
| Commit-guard retrieval | shipped | evidence-only | unknown | quality | ? unknown | Clone retrieval recall at 10: 59.0% · Semantic retrieval recall at 10: 25.0% |
| Ship fixture setup cost | experimental | accepted | stale | methodology-reset | ? unknown | Fixture CPU candidate/baseline: 19.0% · Fixture elapsed candidate/baseline: 31.4% |

## Complete subject inventory

| Subject | Kind | Lifecycle | Evidence | Suite(s) |
| --- | --- | --- | --- | --- |
| API security agent | agent | shipped | evidence-only | reviewer-api-security |
| Backend performance agent | agent | shipped | evidence-only | reviewer-backend-performance |
| Commit guard agent | agent | shipped | evidence-only | commit-guard-retrieval |
| Conventions agent | agent | shipped | accepted | conventions |
| Correctness agent | agent | shipped | evidence-only | reviewer-correctness |
| Feature completeness agent | agent | shipped | accepted | completeness |
| Feature critique agent | agent | shipped | accepted | critique |
| Frontend accessibility agent | agent | shipped | none | — |
| Frontend performance agent | agent | shipped | evidence-only | reviewer-frontend-performance |
| Frontend security agent | agent | shipped | evidence-only | reviewer-frontend-security |
| Prior-art agent | agent | experimental | evidence-only | prior-art |
| devkit CLI | bin | shipped | none | — |
| Clone gate | bin | shipped | evidence-only | co-occurrence |
| Changed-comment paragraph budget gate | bin | shipped | none | — |
| Coverage gate | bin | shipped | none | — |
| Decisions gate | bin | shipped | evidence-only | decisions, decisions-recall, decisions-save-quality |
| Deterministic orchestrator | bin | shipped | none | — |
| Semantic duplication gate | bin | shipped | evidence-only | co-occurrence |
| Duplication allowlist CLI | bin | shipped | none | — |
| Folder fan-out ratchet | bin | shipped | none | — |
| Prefix cache gate | bin | shipped | none | — |
| Ship-time screenshot reminder for UI changes | bin | shipped | none | — |
| Reviewer gate | bin | shipped | accepted | completeness, conventions, reviewer-api-security, reviewer-backend-performance, reviewer-frontend-security, reviewer-frontend-performance, reviewer-correctness |
| Sentry judge gate | bin | shipped | evidence-only | sentry |
| Size ratchet | bin | shipped | none | — |
| Structure gate | bin | shipped | none | — |
| API security reviewer | reviewer | shipped | evidence-only | reviewer-api-security |
| Backend performance reviewer | reviewer | shipped | evidence-only | reviewer-backend-performance |
| Frontend security reviewer | reviewer | shipped | evidence-only | reviewer-frontend-security |
| Frontend performance reviewer | reviewer | shipped | evidence-only | reviewer-frontend-performance |
| Commit guard reviewer | reviewer | shipped | evidence-only | commit-guard-retrieval |
| Correctness reviewer | reviewer | shipped | evidence-only | reviewer-correctness |
| Conventions reviewer | reviewer | shipped | accepted | conventions |
| Feature critique judge | judge | shipped | accepted | critique |
| Completeness judge | judge | shipped | accepted | completeness |
| Decision detect/alignment/depth judges | judge | shipped | evidence-only | decisions |
| UI-evidence visible-change judge | judge | shipped | evidence-only | — |
| Sentry commit-message judge | judge | shipped | evidence-only | sentry |
| Decision-log retrieval recall | benchmark | experimental | none | decisions-recall |
| Decision-log save quality | benchmark | experimental | none | decisions-save-quality |
| Decision brief: rule kept on edit | benchmark | experimental | accepted | decisions-brief |
| Semantic search retrieval | benchmark | experimental | evidence-only | search-tool |
| Edge-case autonomy study | benchmark | no-ship | accepted | edge-cases |
| Vitest ship fixture setup | benchmark | experimental | accepted | vitest-fixture-setup |

## Provenance-tiered historical audit

Observations below are useful context but are excluded from ordinary accepted trend lines. Reported prose and aggregate-only local evidence cannot become accepted retroactively without a sanitized checkpoint.

| Date | Suite | Provenance | Change | Assessment | Finding |
| --- | --- | --- | --- | --- | --- |
| 2026-07-06 | reviewer-fleet | committed-summary | quality | mixed | The haiku-to-opus cascade reduced gold recall from 0.78 to 0.67, motivating the correctness single-pass design. |
| 2026-07-10 | reviewer-fleet | committed-summary | quality | mixed | Model choice raised correctness recall from 29/38 to 35/38 while clean-pass stayed 24/28. |
| 2026-07-17 | reviewer-fleet | committed-summary | coverage | flat | Five gold rows were added and all 48 shared rows had zero outcome flips; this is coverage growth, not a quality gain. |
| 2026-07-17 | sentry | reported | quality | improved | Source comments report focused-diff and elimination-tier gains, but no immutable accepted checkpoint was preserved. |
| 2026-07-17 | decisions | local-aggregate | quality | improved | Aggregate-only local ledger evidence is useful for audit but is not accepted history. |
| 2026-07-07 | commit-guard-retrieval | reported | quality | unknown | Decision prose reports retrieval evidence, but no formal persisted suite checkpoint exists. |
| 2026-08-24 | reviewer-correctness | committed-summary | quality | mixed | On 7 large real diffs, a different workload from the suite corpus, gpt-5.6-sol at chunk:400 re-found 13/23 labelled defects against Sonnet's best 8/23 and was adopted with extras precision unverified. The re-baseline evt-2026-09-04-reviewer-correctness-fa20ee64d5de later showed suite clean pass 0.60 against Sonnet's 0.83, a drop a harness bug fixed in #581 had hidden. Backfilled 2026-10-20 under the ledger's backfill rule. |
| 2026-09-05 | reviewer-correctness | committed-summary | quality | unknown | A replay of seven FAIL-selected historical inputs produced 57 complete Sol claims, judged blind as 47 real, 9 false and 1 unresolved, with 7 of the 9 false claims from one input. Sol stayed configured by owner decision. Backfilled 2026-10-20 under the ledger's backfill rule. |
| 2026-09-12 | reviewer-correctness | committed-summary | no-ship | flat | Both candidate instruction changes matched the current instructions exactly on familiar development controls (8/8 bugs blocked and 8/8 repairs accepted each), so no improvement was observed and neither was promoted. Backfilled 2026-10-20 under the ledger's backfill rule. |
| 2026-10-10 | reviewer-correctness | committed-summary | quality | mixed | For the Claude-family fallback, Haiku 5.5 flagged more labelled bugs than Sonnet 5.5 (92/105 against 84/105, McNemar 10:2, p=0.039) but accepted fewer clean cases (130/180 against 150/179), so the fallback moved to Haiku 5.5. The shipped default stays gpt-5.6-sol, which flagged more bugs than either. Backfilled 2026-10-20 under the ledger's backfill rule. |

## Growth interpretation

No curve shape is classified in v1. Comparable adjacent checkpoints may show marginal per-metric deltas, but there is no defensible effort axis and too little homogeneous history to claim exponential growth or diminishing returns. Status: **insufficient comparable evidence**.
<!-- benchmark-details:end -->
