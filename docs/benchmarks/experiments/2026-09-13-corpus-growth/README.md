# Expanded correctness corpus and completed baseline

The correctness corpus grew from **146 to 285 distinct cases**. The original reviewer completed the full expanded baseline, published through the native benchmark tracker. The active agent and skill retain that baseline implementation. An attempted research-backed rewrite is preserved as an **incomplete, unpromoted experiment** after its run was stopped. [sc3152](https://app.shortcut.com/benordlabs/story/3152).

## Completed baseline

These are initial reviewer verdicts against frozen labels, **not factual precision**.

| Scope | Bug-labelled cases flagged | Clean-labelled cases accepted | Both repair members correct |
| --- | ---: | ---: | ---: |
| All 285 cases | 102/105 (97.1%) | 117/180 (65.0%) | 34/73 (46.6%) |
| Original 146 cases | 73/75 (97.3%) | 40/71 (56.3%) | 26/56 (46.4%) |
| 139 additions | 29/30 (96.7%) | 77/109 (70.6%) | 8/17 (47.1%) |

The baseline flags 63 of 180 clean-labelled cases. Its 73 repair comparisons reuse corpus rows; they are not additional cases. Whole-family agreement is 114/174. [The saved native result](baseline.json), [recomputed summary](baseline-summary.json) and [publication receipt](publication.json) retain the measured evidence.

Initial reviewer verdicts and final gate decisions differ on one bug-labelled row. The reviewer identifies the projection-token defect, but native charter post-processing drops it as out of charter. Final gate blocking is therefore **101/105 (96.2%)**, with clean acceptance still **117/180 (65.0%)**. [Initial and final verdicts](baseline-verdicts.json) preserve both stages. No result was relabelled to hide this distinction.

The historical **13.9% label-noise reference** remains a limitation. Some clean-labelled cases have plausible adjacent defects or ambiguous caller/dependency contracts; acceptance is not independently verified absence of defects. Qualification establishes specified source behavior and adaptation parity, not exhaustive correctness or independent human ground truth. Frozen labels and all baseline outcomes are retained.

## Frozen corpus

| Measure | Original | Added | Expanded |
| --- | ---: | ---: | ---: |
| Distinct cases | 146 | 139 | 285 |
| Bug-labelled cases | 75 | 30 | 105 |
| Clean-labelled cases | 71 | 109 | 180 |
| Explicit bug/repair comparisons | 56 | 17 | 73 |

Pair comparisons reuse cases; they are not additional rows. The additions comprise 17 complete pairs, 13 standalone bug cases and 92 standalone clean controls across 85 declared new source families. The complete corpus has 174 transitive families. Approximately doubling was a scope target; qualification stopped at 285 rather than admitting rejected clean controls to meet 292 exactly.

The new cases cover asynchronous retries, cancellation and cleanup, response bytes and cache identity, event delivery, callback/error contracts, filesystem and glob behavior, query/population state, token classification, AST traversal and diagnostic/fixer contracts. Historical ESLint cases check whether a rule implements its configured policy; they do not ask this reviewer to enforce a stylistic policy on unrelated code. Multiple methods or fixes sharing source context remain one family.

The original 146 row bytes are unchanged. [The protocol](freeze/protocol.json) pins every case, label, family, fixture hash, source file and execution setting. [The native census](freeze/census.json) records **1,164 tasks**, including four existing rows requiring multiple chunks. [The baseline assets](freeze/baseline-assets.json) preserve the current reviewer and installed fixture helpers.

Admission reuses native mining, proposals, fixture/privacy/near-twin/family checks and finalize. A standalone corrective PASS uses the actual buggy fix parent, with no fabricated pre-introduction state or pair link. A standalone source-regression FAIL uses a real parent and changed endpoint with a newly introduced reachable failure. For regressions discovered inside published corrective changes, BugsJS supplies source lineage; the new defect label is an agent-verified source assessment, not BugsJS or upstream ground truth.

Three of the final four ESLint clean siblings were rejected despite repairing their intended targets. Their introducing bug rows remain; only padded-blocks adds a complete pair. Mongoose and Karma corrections with independently reproduced adjacent regressions enter as standalone bug cases, without invented later repairs. Rejected and unqualified candidates are not scored.

Historical dependencies and external ports limit these controls. Redis has a controlled transport; Mongoose has collection callbacks without a database; Karma unit controls are not browser or end-to-end coverage. The Shields repair explicitly includes an agent-derived null-prototype map extension. The Vue source is disclosed as Cursor-coauthored. Exact source/adaptation agreement and full application coverage are separate claims.

[The qualification index](qualification/index.json) links all 139 additions to executable controls, receipts and source limits. [The replay guide](qualification/README.md) explains historical dependencies, licenses and the distinction between public-source replays and adaptation-only telemetry controls. Each admitted pair has a recoverable common baseline, an introduced target defect, source repair linkage and executed pass/fail/pass target evidence, with useful positive and nearby error controls. A passing target test alone did not qualify a clean repair. Proposal inputs and original captures remain private; sanitized attribution and controls stay outside judge-visible fixture files.

## Runtime identity and publication

The baseline used **gpt-5.6-sol, cascade off, four singleton lenses, cap 400, six concurrent rows and Node v24.19.0**. It completed **1,164 unique tasks**. One incomplete task was resumed under the same identity; completed quality outcomes were cached. There were 1,165 recorded attempts, with no completed task rerun.

The [protocol](freeze/protocol.json), [native census](freeze/census.json) and [baseline assets](freeze/baseline-assets.json) pin the measured corpus, instructions and execution. Native event `evt-2026-09-13-reviewer-correctness-e609c43fd8b4` is a methodology reset because corpus and scorer identity changed. Earlier scores from another corpus or runner do not establish an instruction-quality improvement.

**Upstream moved after the freeze:** PR610 (`bcb8e083cdf0033a62ea12140b5c094e0de16e05`) adds judge-runtime code after the measured PR609 base. The accepted evidence remains attached to its original hashes; it must not be described as a new execution of PR610. Generated tracker freshness reflects the actual current source. No benchmark is rerun merely to refresh that status.

Two benchmark compatibility changes accompany the corpus. Shared-family standalone members remain outside explicit repair denominators; malformed links still fail validation and an incorrect standalone member prevents whole-family success. The historical eight-row B/C/P/L replay accepts exact append-only corpus growth and loads both verified historical instruction blobs for every arm. It retains strict helper/runtime checks. Its native isolation was verified before the candidate freeze; its own module-closure identity changed, so identical instruction bytes do not imply an identical historical runner.

## Stopped candidate experiment

The candidate rewrote the agent and skill around required results, valid executions, deciding contracts and changed causality, with coverage of every assigned meaningful hunk. The [research](research.md), [development diagnosis](development-diagnosis.md), [candidate freeze](freeze/candidate.json) and [candidate assets](freeze/candidate-assets.json) preserve the proposal. It added no fifth lens, second-model verifier, confidence filter or new checklist schema.

Its first run was stopped following the user’s usage concern after **184/285 complete rows and 769/1,164 complete tasks**. It was not resumed or published as an accepted full comparison. [Every completed row](candidate-stopped.json) and [selected interpretations](flip-analysis.md) remain available. The observed detection losses already rule out the predeclared no-detection-loss criterion; this does not supply the missing full-corpus or complete reserved-set comparison. The candidate instructions are archived and are not activated by this PR.

**Reservation history:** 45 rows from 24 wholly new families were kept outside outcome-based tuning until candidate freeze. All qualification source was already inspected. Some reserved outcomes were inspected after that freeze, including during the stopped run. The original 45-row reserve must not be represented as untouched confirmation data for a future candidate tuned on these observations. The partial completion cohort is not a random sample, and stopping was not a predeclared statistical rule.

## Recorded cost

| Measure | Completed baseline | Stopped candidate |
| --- | ---: | ---: |
| Complete rows | 285 | 184 |
| Complete tasks | 1164 | 769 |
| Recorded attempts / captured calls | 1165 | 769 |
| Invocation wall time, minutes | 97.4 | 70.9 |
| Summed captured judge time, minutes | 563.2 | 415.2 |

Six rows ran concurrently, so summed judge time is not wall-clock latency. Each captured judge call can use many tools. **Token, dollar and unrecorded in-flight costs are unavailable, not zero.** [Cost evidence](cost.json), [baseline task costs](baseline-task-costs.json) and [candidate task costs](candidate-task-costs.json) preserve the recorded attempts. Tasks are keyed by `(rowHash, taskKey)` because different rows can share task keys. A private early receipt undercounted tasks using keys alone; the final audit uses the composite identity.

The earlier stopped 148-row attempt remains separate incomplete evidence: 74 complete rows and 313 complete task records. Its recorded cost is disclosed separately; unrecorded in-flight cost is unknown. Qualification, preparation and PR-review costs are outside the table.

## Validation and reproduction

Native fixture validation and census accepted all 285 rows. Source qualification bundles retain executable controls, exact historical locks, source hashes, licenses and declared limits. Before stopping the candidate, 241 focused reviewer/fixture/replay tests and typechecking passed; earlier focused statistics/admission checks also passed. Final PR validation is recorded in the PR description.

Commit guard found no actionable duplicate or staged-file clone. Semantic coverage remains incomplete: the worktree index was missing and the older supplemental index omitted the changed source files. The full suite is not claimed green: an earlier stopped run encountered two expired-timestamp failures in `cli/__tests__/judge-preflight.test.mts`, reproduced on the then-clean base and tracked under autonomous issue `4fa275e3-919b-45e5-b8a4-06f624c2e8b7`. That historical result is not a claim about the newer PR610 test files.

Recompute the completed baseline summary without model calls:

```sh
node docs/benchmarks/experiments/2026-09-13-corpus-growth/summarize-baseline.mjs
```

The script validates the published result hash, frozen row identities, runtime conditions and initial/final verdicts, then uses native family/pair statistics and checks them against the saved native metrics. [Qualification replay instructions](qualification/README.md) cover source/adaptation controls. [Post-baseline development controls](development-diagnostics.mjs) are diagnostic evidence and do not increase pre-baseline admission totals.

Raw reviewer captures, private telemetry and proposals remain private. This PR preserves the expanded corpus and completed baseline, with stopped experimental work clearly marked. It makes no reviewer-improvement claim and is not merged by this task.

The root Oxlint configuration keeps four anti-slop rules at warning severity only for this experiment’s frozen qualification JavaScript: runtime `typeof`, shape naming, external-record access and enumeration. Their diagnostics remain visible; rewriting historical source/control bytes to satisfy current style rules would invalidate the recorded qualification hashes. Active source and test helpers retain error severity, and the anti-slop debt baseline is unchanged.
