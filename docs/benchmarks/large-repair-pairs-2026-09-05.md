# Executable repair pairs and native chunking (sc-2500)

The benchmark now executes the same lens/chunk plan as production. Six repaired siblings extend
existing mined defect rows; the number of defect rows stays at 75. This changes coverage and the
measurement method. The Sol model pin remains unchanged.

| Corpus property | Previous epoch | This epoch |
|---|---:|---:|
| Total rows | 140 | 146 |
| Defect rows | 75 | 75 |
| Clean rows | 65 | 71 |
| Repaired siblings | 50 | 56 |
| Standalone clean rows | 15 | 15 |
| Repair pairs / paired families | 50 / 50 | 56 / 55 |
| All transitive families | 90 | 89 |
| Families split across dev/holdout | 0 | 0 |
| Rows activating native chunking at cap 400 | 0 | 4 |
| Planned first-pass tasks | 560 | 608 |

Two large pairs share a reporting feature adapted from devkit-owned source at the merged prerequisite
`0289621e33e9a8417011a9374b2797281466f8a3`. They form one four-member family. Each row has approximately
33 KB of native diff identity and produces three chunks: nine local lens tasks and one whole-diff
writer/reader task. All imports resolve and the report command executes its consumers in the controls.
The contexts cover classification defects; this does not establish large-input sensitivity for every lens.

## Executable controls

The assertions remain outside judge-visible fixture trees. Each target invariant passes in the base
and repair, and reproduces the defect in the buggy postimage. Existing gold IDs and source references
remain attached, while their six behavior hashes change explicitly for this new epoch.

| Existing defect | Executed invariant |
|---|---|
| `corr-retry-stuck-unclaimable` | Retrying a failed wait-mode job makes it claimable by the poller. |
| `corr-read-then-write-clobber-terminal` | A lifecycle signal cannot overwrite a newer terminal status in the controlled interleaving. |
| `corr-lock-timeout-runs-unlocked` | A held lock prevents the callback from running after the acquisition deadline; owner lock survives. |
| `corr-json-string-result-dropped` | Transition writes preserve fields from object and stringified-JSON results. |
| `corr-only-selector-silent-drop` | Empty and unknown selections fail through the actual report command. |
| `corr-asymmetric-flip-classifier` | Mirrored loss/gain inputs receive symmetric classifications even when success flags stay unchanged. |

The lock control advances a substituted clock outside the fixture to exercise contention deterministically;
it is not a production timing estimate. Happy paths, missing rows, terminal states, malformed JSON and
callback cleanup are checked alongside the target counterexamples.

PASS labels judge the staged change against its base. For example, the retry repair changes only a
parameter name relative to its base. An additional controlled interleaving reproduces the same
cancellation race in the base, defect and repair: that inherited race is not introduced by either
diff and does not invalidate the repair's PASS label. The JSON-result repair also changes only a
parameter name relative to its fixture base; a separate control reproduces its terminal-status race
in all three postimages. Both races were verified against the exact reviewed base `5f05749c4a31`.

## Measurement contract

The zero-judge census uses native selection and task planning. Validation executes each derived checklist
command and checks its scoped artifact. Tasks run sequentially inside six row workers, bounding total
judge concurrency at six. Production retains its own scheduling policy.

Runner, planner, scorer, corpus and effective execution settings are frozen before measurement. Cap,
lens groups, model, cascade and escalation identity prevent stale checkpoint reuse. Each task persists
its captures before the next starts; quality misses remain eligible for recovery. One process owns
the shared ledger and baseline through archival, using the existing asynchronous file lease. Incomplete execution
is retried, and one FAIL cannot conceal a missing or malformed sibling task. Completed-run ledgers
retain raw attempts privately. Only sanitized execution facts enter the published row evidence.
Lens captures use the canonical final-verdict parser, so a quoted or retracted FAIL cannot hide
another lens's actual failure.

The first 24-task probe completed without execution errors but exposed two defects in the adapted
report consumer: model timing pooled every model's rows, and a hash-less predecessor could appear
in both stable and changed sets. These were fixture defects, not reviewer false positives. The
shared context was corrected identically across all four family members, with executable controls
for both counterexamples and validation of comparison inputs. Original proposals and probe captures
remain retained; an audit overlay records the corrections. The full 24-task probe was repeated under
a new corpus hash before baseline measurement, raising the planned total to 656 tasks across both
probes and the baseline. The first probe is excluded from final quality estimates.

The corrected probe completed all 24 tasks. Both large rows received the expected verdict, as did
the standalone clean case. Large rows averaged 565 seconds each; the small row took 154 seconds.
These timings include a long judge call and describe this probe, not a production latency guarantee.

The first complete 608-task run exposed further defects in that shared adaptation: the report
included unstable and unscored rows in significance, claimed hash-less predecessors had drift
metadata, and copied a comparison that excluded unstable losses but counted unstable gains.
External controls reproduced all four faulty outputs. The context was corrected identically across
all four family members, retaining their intended selector/classifier differences. Its original
71/75 gold, 42/71 clean and 25/56 pair results are retained as a fixture-development diagnostic;
the large clean failures from that run cannot establish false positives.

The complete four-member family was remeasured after that correction, including both gold rows.
The native checkpoint loader retains the other 142 rows only when behavior and execution identities
match. This costs another 40 tasks and establishes a new corpus identity. The final checkpoint is
therefore assembled across this recorded validity correction, not a new blind evaluation. Both
probes and the first full run remain retained. The total planned measurement work is 696 tasks;
provider-quota attempts are counted separately. No completed quality miss on an unchanged case is
rerun, and model, prompts, runner and scorer stay fixed during this correction.

The probe contains one large defect/repair pair and one existing standalone clean: 24 first-pass tasks.
The correctness baseline contains 608 planned first-pass tasks. Neither command uses `--fail`
or `--against`, which would trigger quality-dependent reruns. The three probe rows reappear in the
full run by design, regardless of their probe scores. The other four reviewer suites retain
their immutable evidence and become stale under the shared runner/scorer change.

## Results

The final native baseline completed at **2026-09-05T17:42:04.342Z**. All 146 rows contain complete execution facts:
608 accepted first-pass tasks, zero final execution errors, Sol single pass and no escalation.
The runner retained all 142 unaffected outcomes byte-for-byte and replaced all 40 tasks in the
four-member reporting family. None of the 142 retained cases was rejudged.

| Metric against corpus labels | Previous epoch | Final corpus |
|---|---:|---:|
| Defects blocked | 71/75 (94.7%) | 71/75 (94.7%) |
| Clean cases passed | 35/65 (53.8%) | 42/71 (59.2%) |
| Repaired siblings passed | 23/50 (46.0%) | 28/56 (50.0%) |
| Standalone clean cases passed | 12/15 (80.0%) | 14/15 (93.3%) |
| Holdout defects blocked | 34/37 (91.9%) | 34/37 (91.9%) |
| Holdout clean cases passed | 17/33 (51.5%) | 23/38 (60.5%) |
| Both repair-pair members correct | 21/50 (42.0%) | 25/56 (44.6%) |
| Whole paired families entirely correct | 21/50 (42.0%) | 25/55 (45.5%) |
| Original 50 repair pairs, both correct | 21/50 (42.0%) | 21/50 (42.0%) |

The six new repairs pass **4/6**. The four large cases score 2/2 defects blocked
and 0/2 repairs passed. Both pairs share one context; these are not four independent large-input samples.
Of 29 clean-label blocks, 28 are repaired siblings, and 22 are on cases also blocked in the preceding epoch.
This is repeated blocking against the labels, not proof that every emitted claim is false.

The final large repairs remain blocked. Their findings concern malformed internal comparison/row
inputs, whether a report should use a failing exit status, and negation in an uncalled helper.
Those claims have not received independent adjudication. The controls prove the intended target
repairs and the reproduced comparison counterexamples; they do not prove that every path in a large
fixture is defect-free. These cases remain diagnostic regression material with that label limitation.

Among 134 behavior-identical historical cases, correct outcomes move from 101/134 (75.4%)
to 103/134 (76.9%): 9 change from wrong to right and 7 from right to wrong. Six existing gold
behaviors changed and six repairs were added. The shared runner also changed between epochs, so even
the unchanged-row comparison is descriptive rather than a controlled model or prompt experiment.

First-pass gold blocking is 71/75 and clean passing is 42/71. Native final outcomes
are 71/75 and 43/71 respectively: the charter filter clears one first-pass clean block.
The gold attribution split is 66 expected-lens matches and 5 verdict/pattern matches; lens matching is not claim adjudication.

## Recovery and provenance

The initial run exhausted quota after 563/608 completed tasks. Its 37 usage-limit attempts were
retained, no partial baseline was accepted, and recovery reused 136 complete rows plus completed
tasks in unfinished rows. The first full ledger contains 645 attempts. After the validity correction,
the combined ledger contains 685 attempts: 608 accepted tasks, 40 obsolete family tasks and 37 incomplete
quota attempts. Including both 24-task probes, the total is 733 attempts for 696 planned tasks.
The final row-level first-pass mean is 145 seconds; it sums task timings and is not parallel wall time.

The implementation was frozen by content hash before measurement. The ship gates required the
measured report and immutable checkpoint together, so publication uses the supported Git-index
workflow in an isolated worktree over `5f05749c4a31bdcfa9bab8ed59a835b8bc8a07f2`. Its provenance
explicitly names that parent, not an implementation commit. The staged runner/corpus hashes match
the measured freeze. The [sanitized native baseline](experiments/2026-09-05-large-repair-pairs/correctness.json)
and [immutable checkpoint](checkpoints/905dc9b6c36a2eb5349dc774cbcd2921e707ecaec010cb8d939ed63b40500ce4.json)
ship together with event `evt-2026-09-05-reviewer-correctness-01fb68e13bcf`. Publication declares `methodology-reset` and
`assessment: unknown`; the previous event stays immutable.
Final gate identity: `26aaa6242a5d`; corpus identity: `15e41709a260`.
Native baseline SHA-256: `3e2855736e6e1e160236963349f6c1c5083acca96b696748f7520cdec0a3b84e`.

The optional named-agent codebase profile was unavailable, and native execution used its configured
subset under strict isolation. Production telemetry sinks and correlation IDs were removed from the
standalone benchmark environment. Raw claims and attempts remain private; published row evidence
contains only sanitized execution facts.

## Interpretation

The revised pair scorer reproduces the historical **21/50** result exactly. It now counts explicit
repair edges inside larger families. Correlated edges are descriptive and omit an independent-binomial
interval; whole paired families receive a separate consistency metric and interval.

The preceding [holdout reset](holdout-reset-2026-09-05.md) measured 71/75 defect detections, 35/65 clean
passes and 21/50 consistent pairs. Those are previous-epoch observations, not a same-condition control
for the new corpus and runner. All fixtures remain exposed regression material. Executable controls
are not new human relabeling, and the **13.9% label-noise bound** remains in force. The Sol pin is
unchanged. An accepted checkpoint establishes measurement completeness, not acceptable false-positive
burden or a causal production-quality improvement.

## Validation

The executable controls and row-value checks passed all 26 tests across two files; after adding
the inherited JSON-race control, all nine executable-control tests passed again. All four
corrected proposals pass admission checks, and the zero-judge census verifies the complete native
workload. Earlier focused runner, recovery, canonical-verdict and adapter tests pass; typecheck and
build pass. The full suite recorded 6,525 passes, 14 skips and two failures in untouched subprocess
tests (gate-log drain deadline and critique fd-0 capture). Both failing files then passed all 23 tests
in isolation. Those original full-run failures remain recorded; this is not a claim of a green full suite.
