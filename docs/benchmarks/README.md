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

## Contributor workflow

```bash
# Publish an adapter-accepted baseline and regenerate views
bun gate-engine/eval/cli.mts publish --suite critique --tree HEAD \
  --change-type quality --assessment improved --note "measured prompt revision"

# Correct an accepted claim by appending a new event; the referenced event remains byte-for-byte intact
bun gate-engine/eval/cli.mts publish --suite critique --tree HEAD \
  --supersedes <event-id> --recorded-at <new-ISO-8601-time> --assessment improved

# Render without publishing
bun run benchmarks:render

# Validate the working tree, Git index, or committed tree
bun run benchmarks:check
bun run benchmarks:check -- --mode staged
bun run benchmarks:check -- --mode tree --tree HEAD --base <base-sha>

# Inspect historical candidates; local logs are aggregate-only and opt-in
bun gate-engine/eval/cli.mts backfill --since 2026-07-01

# Union parallel-worktree additions; duplicate IDs with different bytes fail
bun gate-engine/eval/cli.mts reconcile left.jsonl right.jsonl --output merged.jsonl
```

`publish` derives assessment from adapter metrics, their MDE/noise floors, and shared-row flips. The optional `--assessment` value is an assertion: publication fails if it contradicts that derived result. Publishing defaults to a committed Git tree; `--tree WORKTREE` is only accepted when the entire working tree is clean, so its commit provenance cannot describe uncommitted bytes.

`publish`, `render`, and `check` are deterministic and make no network or LLM calls. Corrections become authoritative generated-view inputs through `supersedes`, while both the original and corrective event bytes remain in the ledger.

## Privacy boundary

Committed evidence rejects raw prompts, transcripts, absolute paths, email addresses, unpublished Git refs, local branch names, and private source text. Backfill reads opted-in local ledgers only to count aggregate rows. Rejected candidates leave counts, not content.

<!-- benchmark-details:start -->
## Current suite dashboard

| Suite | Lifecycle | Evidence | Freshness | Change | Assessment | Latest evidence |
| --- | --- | --- | --- | --- | --- | --- |
| Feature critique | shipped | accepted | stale | quality | ↑ improved | Gold finding recall: 23/24 (95.8%) · Clean-plan pass rate: 4/5 (80.0%) |
| Feature completeness | shipped | accepted | stale | methodology-reset | ? unknown | Gold gap recall: 25/35 (71.4%) · Decoy false-flag rate: 2/27 (7.4%) |
| Repository conventions | shipped | accepted | stale | quality | ? unknown | Gold gap recall: 18/18 (100.0%) · Decoy false-flag rate: 1/14 (7.1%) |
| Domain and correctness reviewers | shipped | evidence-only | unknown | coverage | → flat | Gold rows before catalog refresh: 24 · Gold rows after catalog refresh: 29 |
| Decision governance | shipped | evidence-only | unknown | quality | ↑ improved | Detect accuracy: 45/49 (91.8%) · DECISION recall: 8/9 (88.9%) |
| Sentry capture judge | shipped | evidence-only | unknown | quality | ↑ improved | Commit-message F1: 56/100 (56.0%) · Focused-diff F1: 87/100 (87.0%) |
| Edge-case autonomy | no-ship | accepted | stale | no-ship | ? unknown | Judge-free ceiling: 51.2% · Pre-registered target: 35.0% |
| Semantic search retrieval | experimental | evidence-only | unknown | — | ? unknown | No accepted local checkpoint |
| Duplication matcher | shipped | evidence-only | unknown | — | ? unknown | No accepted local checkpoint |
| Commit-guard retrieval | shipped | evidence-only | unknown | quality | ? unknown | Clone retrieval recall at 10: 59.0% · Semantic retrieval recall at 10: 25.0% |
| qavis visual QA | shipped | external-required | unknown | — | ? unknown | No accepted local checkpoint |

## Complete subject inventory

| Subject | Kind | Lifecycle | Evidence | Suite(s) |
| --- | --- | --- | --- | --- |
| API security agent | agent | shipped | evidence-only | reviewer-fleet |
| Backend performance agent | agent | shipped | evidence-only | reviewer-fleet |
| Commit guard agent | agent | shipped | evidence-only | commit-guard-retrieval |
| Conventions agent | agent | shipped | accepted | conventions |
| Correctness agent | agent | shipped | evidence-only | reviewer-fleet |
| Feature completeness agent | agent | shipped | accepted | completeness |
| Feature critique agent | agent | shipped | accepted | critique |
| Upstream-fix agent | agent | shipped | none | — |
| Frontend accessibility agent | agent | shipped | none | — |
| Frontend performance agent | agent | shipped | evidence-only | reviewer-fleet |
| Frontend security agent | agent | shipped | evidence-only | reviewer-fleet |
| Testing agent | agent | shipped | none | — |
| Testing reviewer agent | agent | shipped | none | — |
| devkit CLI | bin | shipped | none | — |
| Clone gate | bin | shipped | evidence-only | co-occurrence |
| Coverage gate | bin | shipped | none | — |
| Decisions gate | bin | shipped | evidence-only | decisions |
| Deterministic orchestrator | bin | shipped | none | — |
| Semantic duplication gate | bin | shipped | evidence-only | co-occurrence |
| Duplication allowlist CLI | bin | shipped | none | — |
| Fallow staged filter | bin | shipped | none | — |
| Folder fan-out ratchet | bin | shipped | none | — |
| Prefix cache gate | bin | shipped | none | — |
| qavis advisory gate | bin | shipped | external-required | qavis |
| Reviewer gate | bin | shipped | accepted | completeness, conventions, reviewer-fleet |
| Sentry judge gate | bin | shipped | evidence-only | sentry |
| Size ratchet | bin | shipped | none | — |
| Structure gate | bin | shipped | none | — |
| API security reviewer | reviewer | shipped | evidence-only | reviewer-fleet |
| Backend performance reviewer | reviewer | shipped | evidence-only | reviewer-fleet |
| Frontend security reviewer | reviewer | shipped | evidence-only | reviewer-fleet |
| Frontend performance reviewer | reviewer | shipped | evidence-only | reviewer-fleet |
| Commit guard reviewer | reviewer | shipped | evidence-only | commit-guard-retrieval |
| Correctness reviewer | reviewer | shipped | evidence-only | reviewer-fleet |
| Conventions reviewer | reviewer | shipped | accepted | conventions |
| Feature critique judge | judge | shipped | accepted | critique |
| Completeness judge | judge | shipped | accepted | completeness |
| Decision detect/alignment/depth judges | judge | shipped | evidence-only | decisions |
| Sentry commit-message judge | judge | shipped | evidence-only | sentry |
| qavis visual QA | judge | shipped | external-required | qavis |
| Semantic search retrieval | benchmark | experimental | evidence-only | search-tool |
| Edge-case autonomy study | benchmark | no-ship | accepted | edge-cases |

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

## Growth interpretation

No curve shape is classified in v1. Comparable adjacent checkpoints may show marginal per-metric deltas, but there is no defensible effort axis and too little homogeneous history to claim exponential growth or diminishing returns. Status: **insufficient comparable evidence**.
<!-- benchmark-details:end -->
