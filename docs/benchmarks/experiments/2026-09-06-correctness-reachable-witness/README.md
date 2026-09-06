# Correctness improvement: compare instructions, lens rules and context

**Prepared, not run.** [sc-2872](https://app.shortcut.com/benordlabs/story/2872), [PR605](https://github.com/norvalbv/devkit/pull/605). All benchmark, census, fixture-control, exploratory-probe and optimizer execution remains paused until explicit user permission. Production agents, skills, corpus, runner and four-lens routing are unchanged. Merging does not activate a candidate or authorize execution.

The original PR proposed one reachability paragraph and four indirect bug/repair pairs. Those pairs can reveal regressions but cannot establish an effect on caller/lifetime false positives. V2 prepares competing interventions and illustrative mechanism probes. **Only the eight existing source-backed rows may produce benchmark scores. The seven authored probes are unscored and cannot select a winner.** The native [source-anchoring ruling](../../../decisions/benchmarks-grow-from-telemetry.md) forbids minting gold from invented examples; passing their checks would not change that.

## Interventions

| Arm | Exact change | Permitted use after authorization |
| --- | --- | --- |
| B | Existing pinned reviewer | Reference on eight scored guardrails; separate unscored probes |
| P | [agent.patch](agent.patch): shared same-pass reachability guidance | Compare with B on guardrails; explore probe behavior without scoring it |
| L | [lens-rules.patch](lens-rules.patch): conditional concurrent-write and ignored-result rules in both agent and skill | Compare this two-rule bundle with B; no isolated CAS-versus-return effect claim |
| C | Baseline prompt with [exact unchanged source packets](context-packets.json) | Unscored, qualitative source-delivery exploration only |

P and L apply independently to baseline, never on top of each other. C uses neither patch. Model, tools, four lenses, issue cap and timeout stay fixed. No fifth lens, retriever or self-verifier is added.

## Source-backed rows and authored probes

The [source audit](source-audit.md) covers the eight existing exposed bug/repair rows and their limitations. They remain pinned and unchanged. Historical holdout flags do not restore unseen status; these four structural families originate in three source PRs.

[draft-cases.json](draft-cases.json) now contains **unscored probe definitions**, not native corpus rows: source maps and inert control programs for stale editor reads, shared versus separate callback state, and an intentionally ignored deletion result. It has no `expected` verdict or native row-scoring metadata. Anticipated observations explain the examples; they are not gold labels. The callback topology derivative remains in its originating probe family.

The probes are newly authored after observing failure themes. They are not production source reconstructions and do not resolve historical REAL/NOT disagreements. Ordinary source contracts are available to every arm; control programs, anticipated observations and probe metadata are excluded from reviewer input. C supplies only exact unchanged source already available for tool reads to the other arms. Its manually chosen relevance is privileged; no retriever quality is measured.

## Research and tooling

[Research](research.md) covers arXiv, CodeRabbit and Macroscope. [Tooling](tooling.md) assesses promptfoo's API, inspected optimizer source and GEPA. Native review execution is reusable. Promptfoo could orchestrate it, but its default row split does not preserve bug/repair families and its validation scores are used for candidate selection. Truth, scope and target diagnosis still need independent evidence. No optimizer or dependency is installed.

Prior-art: **INSUFFICIENT_EVIDENCE · followed / unverified** for a proven integrated solution; native and upstream capabilities were inspected. The plan critique supported separate interventions and explicit readiness limits. Ship review additionally identified the source-anchoring violation in the initial v2 proposal; the scored synthetic roster was removed in response. The decision notes retain that correction.

## Readiness and proposed execution

[protocol.json](protocol.json) pins the preparation bytes. The prior 32-execution plan is superseded by **48 proposed scored guardrail executions** (B/P/L × eight rows × two rounds) and **56 separate unscored probe executions** (B/P/L/C × seven probes × two rounds). These are proposed budgets, not completed calls or a native task census. They must never be pooled into one benchmark score.

The two patches, source/control definitions, packets and [handoff contract](comparison.md) are reviewable. **The mixed experiment is not runnable yet:** its native scored/unscored adapter is not implemented or validated. Probes cannot be sent to `runRow`/`scoreRow` or a corpus importer. The old per-prefix CLI commands cannot execute this proposal.

After permission, validate the existing source-backed controls and adapter parity before scored runs. Probe execution may inspect concrete program/reviewer behavior but cannot generate precision/recall, candidate rankings or an optimizer reward. To score the motivating mechanisms or context delivery, first qualify independently source-anchored cases under the existing admission workflow. Control success alone cannot provide provenance. Separate untouched confirmation remains required for production decisions.

## Measurement rules

For the scored partition, report all 48 planned cells, attempted/completed/missing counts, target diagnoses and repaired acceptance. Each arm has four buggy and four repaired rows per round. Expected-lens failure is a proxy, not proof of target diagnosis. Assess every captured claim's factual truth, introduced scope, charter and target relation separately; valid extras are neither target hits nor false claims. Unknown or missing evidence is never a successful review.

Preserve every occurrence before grouping and keep experimental repetition separate from repeated alarms within a review. Report per-lens unique valid findings, overlap, invalid/unresolved occurrences and judge time. No-claim precision is undefined; incomplete captures cannot bound missing claims. Report unresolved-inclusive bounds only for qualified, complete captured evidence and retain the existing adjudication/noise limitations. Do not rank candidates from probe outcomes or describe probe observations as additional benchmark findings.

Guardrail improvements only support further development. Resolve real source/caller assumptions and obtain separately frozen confirmation before claiming production benefit. The fifth-lens question still requires the [recorded eligible-gap criteria](../../../decisions/correctness-lens-hole-instrument.md). sc-2832's history experiment remains separately blocked.

## Preparation validation

Static JSON, source/row/probe hashes, both independent patches, family membership and source-packet checks passed. Embedded JS syntax was checked without executing it. No control or benchmark runner was executed or fixture materialized for preparation. Normal ship gates validate this PR, not reviewer quality.
