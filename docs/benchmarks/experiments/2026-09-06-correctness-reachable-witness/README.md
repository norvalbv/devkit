# Correctness: ground the failing scenario in reachable code

**Prepared, not run.** [sc-2872](https://app.shortcut.com/benordlabs/story/2872) stores one experimental prompt patch and a frozen development comparison. The user paused all benchmark execution on 2026-09-06. No baseline, candidate, census, fixture execution or adjudication was performed for this preparation. Production agents, skills, corpus and runner are unchanged. Merging this preparation does not authorize a run or activate the candidate.

The candidate asks the reviewer to establish that its proposed failure can happen through the actual caller or exported contract, accounting for earlier writes, guards and instance lifetime. The existing instruction already demands a concrete failing input; the addition makes the reachability check explicit. It stays within the same review call and keeps the adversarial check before PASS. It does not add a verifier, confidence filter, model change or requirement to execute a test for every finding.

For example, a JS handler might call `editor.setText(value)` synchronously, then check `editor.getText()` before sending. A claim that the later guard sees the old empty text needs to account for that earlier write. Conversely, an `await` between reading a job and updating it can permit another real writer to change its status. The reviewer must preserve that genuine race while rejecting impossible sequences. This illustration is not an admitted case or evidence that the candidate works.

## Evidence and choice

The [complete-claim replay](../2026-09-05-sol-claims/README.md) nominated repeated send-guard and lifetime claims, but retained conflicting caller assumptions. Those observations motivate the hypothesis; they are not newly resolved labels. [Research notes](research.md) distinguish arXiv evidence, vendor methods and our inference.

Prior-art: **INSUFFICIENT_EVIDENCE · followed / unverified**. Research narrowed the intervention; no reference checkouts or deep-research service were available, and no proven devkit/Sol fix was found. The pre-implementation critique returned PROCEED_WITH_CHANGES. Its fixes are included: exact runtime knobs, full task-archive retention, and no claim of mechanism benefit from generic guardrails.

We chose one prompt factor over automated prompt/model search or a new retrieval service: the present task needs a falsifiable, bounded candidate, and the native reviewer already supports targeted source reads. The research does not justify transplanting another model's rejection filters or the removed same-family verifier. Rationale is appended under [correctness precision](../../../decisions/correctness-reviewer-precision.md) and [claim measurement](../../../decisions/reviewer-claim-measurement.md).

## Artifacts

- [agent.patch](agent.patch): exact unapplied addition to `agents/correctness-reviewer.md`.
- [protocol.json](protocol.json): source revision, asset and exact row hashes, cohort, proposed order and pending status. A null task count or measurement means not measured, not zero.
- [source audit](source-audit.md): four existing bug/repair pairs, requirements and limitations established by reading source and existing controls.
- [research](research.md): primary sources and transfer limits.

The four pairs are exposed regression guardrails. They do **not** test the disputed caller-lifetime/send-guard mechanism directly. They comprise four structural families from three source PRs; they are not four independent incidents. Historical `holdout` fields stay untouched and cannot make these exposed examples unseen again. Neither favorable results nor fewer comments on this set would establish a production improvement.

## Future execution — only after explicit permission

1. Freeze authorization and operator/tool versions. Use the exact source revision in `protocol.json`, not a newer main. Verify listed source hashes and exact eight row hashes before interpreting any results. Keep the entire source corpus unchanged and confirm each family prefix selects exactly its two pinned rows. A changed prefix set, source asset or hash requires a new protocol before any run.
2. Make 16 fresh isolated checkouts: one for each arm × round × family. Each starts at the pinned revision. Apply `agent.patch` only in candidate checkouts, verify before/after SHA-256, and ensure the only tracked difference is that agent file. `buildAssets` reads this file into native fixtures; no alternate runner is needed. Keep experiment annotations and expected labels outside judge-visible fixture trees. Pin the same dependencies and judge CLI versions in both arms.
3. Once authorized, execute existing controls for the selected four pairs and read their actual assertions/results. Do not run all six families merely because they share a test file. If selective control execution needs preparation, stop before model spend. A failing control or unresolved introduced-scope label prevents interpreting the affected pair; record it and revise the protocol rather than silently dropping it.
4. Use the environment and argument array in `protocol.json` for each invocation. These are documentation, not an auto-running script. The source pins correctness to `gpt-5.6-sol`; `BENCH_MODEL` alone is not a model override. Keep the native default effort, issue cap and timeout fixed. Clear unrelated inherited review overrides; verify effective model, lens groups, chunk cap, escalation and runtime versions in evidence. Stop interpretation on any mismatch.
5. Round one: baseline then candidate for each family in listed order. Round two: candidate then baseline in the same family order. Both pair members run each time: 32 planned row executions. Native task counts remain unmeasured until the permitted census. Use `BENCH_CASCADE=off`, not `CASCADE=0`; explicit chunk/split settings are captured before the native runner cleans environment overrides.
6. Omit `--dev`: it would exclude three historically held-out families. Omit `--against` and `--fail`: they trigger quality-selected stability reruns. Omit `--baseline`: this pilot must not replace shared results. Each fresh checkout prevents checkpoint reuse and evidence overwrites. Preserve failures without manually retrying or changing the prompt mid-round; native retry attempts must remain visible. If execution pauses, report incomplete coverage. Later recovery needs a separately declared phase.
7. Retain console output, exit status, row outcomes, hashes and **all task records** from `progress-*.jsonl` or the successful `progress-*-completed-*.jsonl` archive before cleaning any checkout. In task records, `task.capture` preserves outputs and checklist snapshots; final row `execution.tasks` is reduced metadata and is insufficient. Preserve every occurrence, including repeated claims and native failed attempts. Store raw artifacts privately; never publish source-sensitive traces merely to complete this doc.

## Interpretation registered before results

Report all 32 planned row executions, attempted/completed/paused counts and capture coverage. Report target diagnoses among eight planned buggy-row executions per arm, and repaired-row acceptance among eight planned repaired-row executions per arm. Missing execution or capture is unknown, never a successful review. Include completed-only rates and explicit missing denominators; do not hide them in an aggregate accuracy score.

A failed expected lens is only a proxy. Assess complete claims against the source: factual truth, introduced-change scope, charter scope and target relation are separate. A valid extra bug is not a target hit or a false claim. A pre-existing real race is not a valid introduced finding. Use blinded human or independently attributed cross-family assessment per the claim-measurement ruling; unresolved judgments stay unresolved. No adjudicator was run or calibrated in this preparation.

For captured claims, retain V valid, I invalid and U unresolved occurrences. Give resolution coverage and bounds V/(V+I+U) to (V+U)/(V+I+U); if capture is incomplete, these describe captured claims only and cannot bound missing text. If no claims are emitted, claim precision is undefined. Group repetitions only after preserving every occurrence in the denominator. Keep within-invocation repeats separate from repeated experimental presentations of the same family. Report time, cost if available, native retries and failures without turning timeout into a clean PASS. Do not treat correlated rounds, lenses or pairs from one PR as independent samples.

Any lost genuine target diagnosis, additional unsupported repair block, increased execution failure or tracing cost is a reason to investigate, not to select a favorable rerun. Stable or improved guardrails justify, at most, continuing development. Direct source-controlled lifecycle/send-guard cases and independently labelled, separately frozen confirmation data are still needed before claiming mechanism benefit or proposing production promotion. sc-2832's five-round history experiment remains separate and blocked on its own prerequisites.

## Preparation checks

Checked artifact JSON, pinned row/source hashes, patch applicability and candidate hash without importing the benchmark runner or materializing fixtures. Existing controls were read, not executed. Normal ship integrity checks do not measure reviewer performance. No performance result or improvement claim is recorded here.
