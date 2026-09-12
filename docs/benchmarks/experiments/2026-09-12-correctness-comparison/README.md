# Native correctness comparison execution

[sc3124](https://app.shortcut.com/benordlabs/story/3124) implements the [PR605 preparation](../2026-09-06-correctness-reachable-witness/README.md). The owner authorized sparse, meaningful benchmarks on September 12. This supersedes the execution pause recorded in the preparation; it does not authorize invented gold labels, production promotion or automatic waivers.

The existing native runner now exposes unscored fixture execution. `runRow` remains the scoring wrapper; `runProbe` rejects scoring metadata and never calls the scorer. Both use the same assets, selection, task planner and cascade. Production agents, skills, model, four-lens routing and corpus rows are unchanged. P and L are independent experimental instruction overrides; C appends verified unchanged source only to unscored probes.

## Completed comparison: no observed improvement

The [complete sanitized result](results-7bebd9d1ec16eb58.json) records one fixed run: **48/48 cells and 192/192 native lens calls completed in 85.2 minutes**, with zero missing/incomplete cells, call errors or outages. Every task retained its exact checklist. No exploratory probes or context-C calls ran, and there were no quality-selected reruns.

| Version | Buggy cases blocked | Repairs accepted | Expected verdicts matched | Recorded finding occurrences |
|---|---:|---:|---:|---:|
| B: current instructions | 8/8 | 8/8 | 16/16 | 20 |
| P: shared reachable-trigger guidance | 8/8 | 8/8 | 16/16 | 20 |
| L: two conditional lens-rule amendments | 8/8 | 8/8 | 16/16 | 20 |

The denominators include two runs of four bug/repair pairs, drawn from three source PRs. They are familiar, clear development controls. All versions reached the same verdict ceiling; neither candidate demonstrates an improvement on these measures, and this small comparison cannot establish equivalence or production benefit. L changes two rules together and does not isolate their individual effects. This is not a new full-corpus baseline or a large-PR/context benchmark.

Finding counts also match across versions:

| Lens | B occurrences | P occurrences | L occurrences |
|---|---:|---:|---:|
| State transitions | 8 | 8 | 8 |
| Concurrency | 4 | 4 | 4 |
| Whole-diff contracts | 6 | 6 | 6 |
| Parsing and classification | 2 | 2 | 2 |

Each lens completed 16 calls per version. All 60 recorded findings belong to buggy cells; repaired cells emitted none. Exposed root-agent inspection of every finding found the intended causal mechanisms repeated across lenses, but this is **diagnostic inspection, not blinded independent adjudication**. One L/round-two retry finding names a poller function absent from the fixture while describing the intended failure. Its exact text is retained privately. No finding is credited as independently qualified truth or target diagnosis; all 60 remain unresolved for precision reporting. The counts therefore establish neither 100% precision nor the unique value of a lens.

The original execution is pinned to PR608 commit `6c536a00a48d209c5c8296bf4186378c45057078`; later caller-validation and CI-test fixes were made separately without changing that running source. The final source/configuration identity still matched registration. All 32 row/lens code-input groups have identical native input hashes across versions and rounds, all have three distinct arm briefs, and all 96 row/arm/lens briefs remain stable between rounds. The remaining requested arguments and observed capability fingerprint were constant. Usage and complete tool-read transcripts remain unavailable.

The artifact SHA256 is `7bebd9d1ec16eb58fa3d31dfc5e803699295aebe17f1c991bcbd7d4ba8950cd9`; it includes registration/event/report hashes. Raw receipts and exact claims stay in private research storage. An initial directory-permissions preflight failed before registration or model dispatch; its zero-call log is retained, followed by this one registered run.

**Next decision:** qualify actual caller/lifetime/conditional-write source cases through [sc3144](https://app.shortcut.com/benordlabs/story/3144), reserving family-separated confirmation before further development comparisons. These results support keeping the existing production instructions while investigating that coverage gap. They do not justify a fifth lens, automatic prompt optimization, another immediate guardrail run or promotion of either candidate.

## Reproduce

From a source checkout containing this implementation, with dependencies and the configured native Codex judge available, use Node24:

```sh
node gate-engine/review/eval/reviewers/comparison/cli.mts census scored
node gate-engine/review/eval/reviewers/comparison/cli.mts census exploratory
```

Census materializes temporary source fixtures and uses the native planner; it does not call a model. The scored phase contains 48 cells and 192 first-pass lens tasks: eight exposed source-backed rows, B/P/L, two rounds. The exploratory phase contains seven authored probes under B/P/L/C over two rounds. It is supported independently; the CLI has no automatic combined phase.

A run requires an explicit new directory under an existing private research parent and explicit budgets:

```sh
node gate-engine/review/eval/reviewers/comparison/cli.mts run scored \
  ~/.devkit/research/comparison-execution-20260912/scored-run-1 \
  --execute --max-calls 192 --max-minutes 180 --judge-minutes 10
```

These ceilings allow at most 192 first-pass calls, three hours overall and ten minutes per dispatch. The per-dispatch ceiling differs from the native maximum of thirty minutes; it is identical across arms and recorded. A deadline can shorten the last call. Budget exhaustion leaves missing/incomplete cells visible; it never becomes PASS and does not trigger a quality retry. No token/dollar ceiling is enforced because the native delegate does not expose usage to this adapter. Usage is reported unavailable, never zero. This is a call/time budget, not a price guarantee.

The runner is sequential, uses cap400 and explicit singleton lenses, fixes Sol and issue cap3, disables cascade escalation and saved-task reuse, and isolates benchmark telemetry from production. No manual retries or quality-selected reruns occur. The first round orders B/P/L within each family; the second reverses it. Each cell uses a fresh native fixture.

## Evidence and interpretation

The old protocol and source hashes remain unchanged. Before dispatch, a new private registration records that preparation identity, historical/current source hashes, the new transitive local runner hash, dependency-lock hash, runtime, exact roster, asset/packet hashes and budgets. Hashes prove consistency, not label truth or execution authenticity.

An exclusive output directory prevents overwriting or resuming prior evidence. Synchronous append-only receipts preserve requested native argv, original and augmented input bytes/hashes, returned output/errors, observed capability fingerprint, outage classification and runtime. Complete native task captures are stored before cleanup. The native delegate translates requested argv internally; these receipts do not claim to capture the final provider CLI argv or every tool-read transcript. A missing capability callback or usage field is unavailable. Missing artifact coverage must be distinguished from complete execution when assessing claims.

Only source-backed rows receive verdict-agreement scores. Those are regression proxies: a matching expected lens or verdict does not prove the target bug was diagnosed. Every claim still needs separate factual, introduced-scope, charter and target assessment before a precision claim. No factual precision, independent-sample confidence, winner, fifth lens or production gain follows automatically from this report. The eight rows represent four structural pairs but only three source PRs; all are exposed development data.

Authored probes have no expected verdicts and never enter `runRow`/`scoreRow`. Their returned statuses and source observations cannot produce accuracy, target-hit rates, repair acceptance, candidate rankings or optimizer rewards. C remains unscored. Source-anchored direct cases and untouched family-separated confirmation remain prerequisites for measuring the motivating mechanisms and production benefit.

## Validation and rationale

The existing repair-controls suite passed ten tests, including base/bug/repair behavior and the distinction between a pre-existing race and an introduced regression. Before paid execution, the final adapter tests passed 18 checks and the native planner regression tests passed nine checks. The subsequent direct-caller validation fixes passed 20 adapter checks and nine planner checks without another benchmark run. They cover scorer rejection, native task preservation, independent asset overrides, packet/source consistency, missing outcomes, capture persistence and exhausted/zero-timeout dispatch. The fresh-home evidence-directory test was corrected after CI exposed an assumption that the research parent already existed. All 20 adapter checks passed after the fix; it uses a temporary canonical home through an OS-method spy, leaving the real home environment untouched. No paid comparison was repeated for these fixes.

Prior-art: **INSUFFICIENT_EVIDENCE · followed / unverified** because no reference checkouts are declared. Native reuse was confirmed; [promptfoo's provider interface](https://www.promptfoo.dev/docs/providers/custom-api/) can wrap this integration later but does not replace the source/provenance boundary. The pre-implementation critique returned PROCEED, with the zero-timeout dispatch guard incorporated. Semantic duplicate retrieval was unavailable (no embedded symbols); local reuse inspection and clone checking found no duplicates touching these files.

Durable rationale and authorization updates are appended in [claim measurement](../../../decisions/reviewer-claim-measurement.md), [source admission](../../../decisions/benchmarks-grow-from-telemetry.md) and [reviewer precision](../../../decisions/correctness-reviewer-precision.md). The separate [sc2832 history experiment](https://app.shortcut.com/benordlabs/story/2832) is not silently included in this comparison.

## Additional source investigation

The [sanitized control receipt](source-controls.json) records a separate source investigation that admitted **zero rows**. Exact archived draft-store functions preserve replacement storage when a write stamp is stale or absent, and clear it when the stamp matches. The actual unmounted cleanup callback may intentionally ignore a false clear result while clearing its old local mirrors. The actual before/after send guard prefix admitted an attachment-only message with the reconstructed attachment callback and explicit synchronous editor/formatter doubles; an empty unadorned message did not pass.

These controls establish only those paths under the stated doubles. Historical unchanged input state remains unproven; full editor DOM, React lifetime, authenticated dispatch, cross-window behavior, timestamp uniqueness and storage errors were not executed. They do not establish that the whole change is clean. The script and raw source receipt remain private, identified by hashes in the sanitized record. [sc3144](https://app.shortcut.com/benordlabs/story/3144) records the exact evidence locations and the remaining source-qualification work. [sc2286](https://app.shortcut.com/benordlabs/story/2286), which exposes absent conventions-coverage categories, is related tooling but does not block this explicitly declared correctness coverage gap.

The primary citations were rechecked on September 12. [SWE-Review v1, Appendix B.2](https://arxiv.org/html/2607.06065v1) reports insufficient reproducers and code misreading in its LLM-assisted error analysis; passing investigator tests alone therefore cannot establish our labels. [CR-Bench v1](https://arxiv.org/abs/2603.11078v1) studies the tradeoff between resolving issues and producing spurious findings. These motivate checking actual source behavior and complete finding text. They do not establish that either candidate improves Sol, and the reported effects from other agents are not imported as our results.

## Full-suite validation limits

The development full-suite run completed with **6,766 passed, two failed and 14 skipped tests** (354 passing files, one failing and one skipped). Both failures are fixed-date expectations in `cli/__tests__/judge-preflight.test.mts`; its stored reset timestamp has expired. The same two failures reproduce on the clean PR605 base `05dcafae`, which passes the other 30 tests in that file. This unrelated clock-dependent test defect is recorded as autonomous issue `4fa275e3-919b-45e5-b8a4-06f624c2e8b7`. It is not hidden or fixed in this comparison change.

[CI on PR608 revision f342418d](https://github.com/norvalbv/devkit/actions/runs/34692737602) had 22 failures: 19 have matching test identities in [merged PR605's CI](https://github.com/norvalbv/devkit/actions/runs/34003888566), two are the reproduced fixed-date failures, and one was the new research-parent test assumption. Commit `d5b47c001fee92883ed4ccb53d75ce984ccdf559` fixes that new test, with 20 focused checks passing locally. The existing Linux failures concern subprocess supervision, Git identity, Bash arrays and judge-tamper setup. These results do not constitute a green full suite. Subsequent CI status remains visible on PR608.
