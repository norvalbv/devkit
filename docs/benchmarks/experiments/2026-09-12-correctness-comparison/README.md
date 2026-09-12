# Native correctness comparison execution

[sc3124](https://app.shortcut.com/benordlabs/story/3124) implements the [PR605 preparation](../2026-09-06-correctness-reachable-witness/README.md). The owner authorized sparse, meaningful benchmarks on September 12. This supersedes the execution pause recorded in the preparation; it does not authorize invented gold labels, production promotion or automatic waivers.

The existing native runner now exposes unscored fixture execution. `runRow` remains the scoring wrapper; `runProbe` rejects scoring metadata and never calls the scorer. Both use the same assets, selection, task planner and cascade. Production agents, skills, model, four-lens routing and corpus rows are unchanged. P and L are independent experimental instruction overrides; C appends verified unchanged source only to unscored probes.

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

The existing repair-controls suite passed ten tests, including base/bug/repair behavior and the distinction between a pre-existing race and an introduced regression. Twenty focused adapter/native-planner tests passed before paid execution. They cover scorer rejection, native task preservation, independent asset overrides, packet/source consistency, missing outcomes, capture persistence and exhausted/zero-timeout dispatch. Ordinary full-suite validation and measured outcomes are recorded separately when available.

Prior-art: **INSUFFICIENT_EVIDENCE · followed / unverified** because no reference checkouts are declared. Native reuse was confirmed; [promptfoo's provider interface](https://www.promptfoo.dev/docs/providers/custom-api/) can wrap this integration later but does not replace the source/provenance boundary. The pre-implementation critique returned PROCEED, with the zero-timeout dispatch guard incorporated. Semantic duplicate retrieval was unavailable (no embedded symbols); local reuse inspection and clone checking found no duplicates touching these files.

Durable rationale and authorization updates are appended in [claim measurement](../../../decisions/reviewer-claim-measurement.md), [source admission](../../../decisions/benchmarks-grow-from-telemetry.md) and [reviewer precision](../../../decisions/correctness-reviewer-precision.md). The separate [sc2832 history experiment](https://app.shortcut.com/benordlabs/story/2832) is not silently included in this comparison.
