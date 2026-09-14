# Correctness evidence pipeline candidate

Status: complete. The candidate failed the no-detection-loss criterion and is not promoted.

The owner requested a broader intervention after the first instruction-only candidate lost four
bug detections for seven additional clean accepts on its completed subset. The merged corpus and
baseline remain frozen in [the September 13 experiment](../2026-09-13-corpus-growth/README.md).
The new candidate combines revised reviewer instructions with source preparation, lens ownership,
evidence delivery and chunk packing. A comparison can assess that bundle; it cannot attribute an
outcome to one component.

## Existing evidence informing the implementation

- The [source-family census](../../source-family-census.md) measures initially supplied source
  spans. Its large dispatcher diagnostic lacks unchanged counterpart source in the contracts
  task. It does not observe later reviewer retrieval, and has no qualified clean large pair.
- The [scale probe](../2026-08-23-scale-probe/README.md) found that reducing the earlier Sonnet
  chunk cap from 1000 to 400 added calls without additional pooled target hits. Those historical
  results are not a measurement of the current Sol reviewer or this candidate.
- The [ship-attempts research](../2026-08-22-ship-attempts-research/README.md) already covers context,
  chunking, incremental reuse and measurement. The private follow-up document
  `~/.devkit/research/epic2491-followup/reviewer/methods-and-recommendations.md`, section 2,
  specifically calls for separating supplied, retrieved and absent context before claiming that
  chunking caused a miss. No new literature search was commissioned for this implementation.
- The [precision decision](../../../decisions/correctness-reviewer-precision.md) and
  [chunking decision](../../../decisions/correctness-chunking-ships-dark.md) retain the experimental
  status and comparison limits. History input remains a separate experiment; supplied prior
  claims are leads to recheck, never automatic findings or permanent suppressions.

## Candidate behavior

`GUARD_CORRECTNESS_CONTEXT=bounded-v1` enables source preparation and packing. Unset or `off`
retains the control planner and delivery path. The measured candidate instructions are archived;
active instruction assets were restored after the failed comparison.

Each derived task owns an immutable packet containing its changed hunks, the selection's complete
file inventory and bounded supporting source. The cascade and its retries consume that packet
directly. The prompt names the assigned lenses and distinguishes ownership from investigation
reach. An owned change may introduce a cross-file defect, but supporting files do not create
additional review ownership. Captured Git trees govern source recovery after preparation.

Automatic support uses Git enclosing-function hunks and direct relative ES-module imports on both
sides, including literal dynamic imports and reverse links among selected changed files. Changed
import statements receive priority when the lookup budget is exhausted. Identical enclosing-function and
owned diff segments are deduplicated. Rename discovery retains old paths. The module lexer does
not establish all actual callers/readers: aliases, computed imports, CommonJS, unsupported syntax,
ambiguous resolutions and preparation limits remain explicit unknowns.

Preparation permits at most 64 source paths, 128 blobs, 256 KiB per blob, 4 MiB source content and
16 relative import records per selected file and source side. Git output is capped at 8 MiB per operation under a shared
15-second preparation deadline. Discovery never scans repository source bodies recursively.

Owned diff evidence receives the existing cap first. Supporting envelopes use up to 24000 of the
remaining 60000 UTF-16 source characters, with 8000 per segment. Inventories and omission metadata
are additional bytes and are reported in total input size. A full owned-diff budget can therefore
leave no room for support. Missing context is neither a defect nor evidence of safety.

Whole files remain the ownership unit. The candidate weights them by planned bounded source
evidence in UTF-8 bytes, prefers directly related changed files in deterministic packing, and
keeps oversized files intact. The nominal 400 × 40-byte target, 1.5 trigger, 24-chunk backstop,
all lens partitions and whole-selection contracts groups remain. Shared context is deduplicated
when rendering a task; per-file weights are conservative when multiple owners share support.

Semantic cache identity includes raw owned changes, supporting content and discovery limits.
Snapshot tree IDs provide retrieval provenance without invalidating every task for an unrelated
staged edit. Execution fingerprints include the experimental mode and local runtime module
closure. Private task receipts record exact input identity, source-budget units and omissions.

## Measurement boundaries and current diagnostics

The frozen regression corpus contains 285 rows: 105 bug labels and 180 clean labels, with 1164
baseline tasks. Only four rows exercise chunking, and all four belong to one family. The baseline
initially blocked 102/105 bug labels and accepted 117/180 clean labels; those are label agreements,
not independent adjudication of every emitted claim. The former reserve has since had partial
outcome exposure and is not an untouched confirmation set for this candidate.

The candidate census plans 1206 tasks on those 285 rows (3.6% more), with the same four chunked
rows. Each existing large dispatcher diagnostic grows from 34 to 49 tasks. Local tasks now receive
all 24 dispatcher lines, versus 13 before. The bug view's contracts task still receives only
13/24 lines (the repair view 14/24), and neither view supplies the two unchanged counterpart spans.
Those outcomes show a delivery improvement for local tasks, a remaining contracts limit and extra
planned work. They do not establish improved detection or clean acceptance. Source diagnostics
remain unscored, exposed and outside the regression cohort.

The source census now checks the actual packet's source coordinates and complete-line prefixes.
Inventory mentions, text at another coordinate, and partial trailing lines do not count as supply.
It continues to report subsequent retrieval as unobserved. The completed model run kept completed
quality misses and resumed technical incompleteness only under the same identity. It reports bug
agreement, clean acceptance, pair/family results, extra claims and measured runtime separately.
No fresh baseline is needed merely because this candidate changes the runtime.

## Frozen candidate run

[The freeze](freeze.json) pins 285 rows, 1206 first-pass tasks, Sol with cascade off, the four
singleton lenses, cap 400 and six concurrent rows. The original call budget was 1206 and the active-time ceiling
was three hours. The technical continuation added six replacement attempts, disclosed below. [Candidate assets](candidate-assets.json) preserve the measured instructions and
fixture helpers. Execution hash: `2efa55ba600afa0ef4bbe9268a7e852ed57bdfb4d5ef46a858d48b4ab5891b00`.

The full suite completed with 6827 passing tests, 14 skipped and no failures across 359 files.
Build, typecheck, lint, structure and deterministic dry gates passed; advisories and prior failed
validation attempts are disclosed in [validation](validation.json). The saved baseline is not rerun.

The provider usage limit interrupted the first invocation after 112 calls and 23 complete rows.
On the owner’s instruction, the [continuation](continuation.json) preserves all 106 complete tasks
and runs only the 1100 unfinished tasks under the same source identity. The six incomplete
dispatched attempts count toward total cost; they do not cause completed judgments to run again.

## Completed comparison and disposition

The full candidate completed all 285 rows and 1206 unique native tasks. Source verification passed
for all 975 frozen files before export. The interruption and continuation together dispatched 1212
calls: 1206 complete tasks plus six incomplete call attempts. Forty additional task records were
created after dispatch had stopped and contain no call; they are not paid attempts. No completed
judgment was retried, no quality flip was excluded and no label or corpus row changed.

| Measure | Saved baseline | Candidate |
| --- | ---: | ---: |
| Initial bug-label flags | 102/105 (97.1%) | 100/105 (95.2%) |
| Initial clean-label acceptance | 117/180 (65.0%) | 123/180 (68.3%) |
| Initial correct bug/repair edges | 34/73 | 38/73 |
| Initial whole-family agreement, including singletons | 114/174 | 117/174 |
| Final bug-label blocks | 101/105 | 100/105 |
| Final clean-label acceptance | 117/180 | 124/180 |
| Final correct bug/repair edges | 34/73 | 39/73 |
| Final whole-family agreement, including singletons | 114/174 | 118/174 |

The initial clean result contains 18 gains and 12 losses, for a net gain of six. Bug detection has
one gain and three losses, for a net loss of two. The candidate therefore fails the stated rule
that cleaner acceptance must not reduce observed bug detection. The new 139-row cohort has no
net clean gain (77/109 in both versions) and loses one bug flag (29/30 to 28/30). In the exposed
former reserve, flags change 14/15 to 13/15 and clean acceptance 23/30 to 25/30. Those cases do not
constitute untouched confirmation.

The three lost initial detections are `corr-broadcast-fanout-no-dedup`,
`corr-pr59-expand-knip-config-detection`, and `corr-empty-home-override`. The gained detection is
`corr-asymmetric-flip-classifier`. All 36 rows whose initial or final agreement changed appear in
[the transition table](flips.md), with machine-readable [comparison](comparison.json) and
[discordance](discordance.json). Native charter post-processing explains why initial and final
counts are distinct; the final-only transitions are preserved in the same table.

This is an observed failure of the promotion criterion, not a precise population-level estimate
of regression. Family net votes are 12 losses and 16 gains overall at the initial stage
(exploratory mid-p 0.458). The corpus is exposed, its historical label-noise reference is 13.9%,
and a blocked bug label does not establish that every reported claim was valid. The bundle also
includes the merged PR610 runtime/outage changes absent from the saved baseline runtime; this
comparison cannot isolate prompt, context, packing or runtime contributions.

The measured instructions remain archived in [candidate assets](candidate-assets.json). Active
agent/skill instructions are restored to the saved baseline before delivery. The TypeScript implementation
is retained for opt-in source-mode experimentation under `GUARD_CORRECTNESS_CONTEXT=bounded-v1`; unset/off
keeps the control preparation path. Using that flag with restored baseline instructions is a
different, unmeasured combination, not the measured bundle or a recommended rollout. No further
tuning cycle or benchmark is part of this result.

This feature PR runs through devkit's `.mts` source entrypoints. Under the
[dist policy](../../../decisions/typescript-source-prebuilt-mjs.md), its three new generated
context modules accompany their sources, while a release build must regenerate the existing
packaged runtime integrations before the flag affects installed consumers. The current `dist`
entrypoints therefore do not expose this experiment. The comparison used source execution and
does not claim a packaged rollout.

## Cost and supplied evidence

| Recorded cost | Saved baseline | Candidate |
| --- | ---: | ---: |
| Unique completed tasks | 1164 | 1206 |
| Dispatched calls, including incomplete attempts | 1165 | 1212 |
| Active invocation wall time | 97.4 min | 143.0 min |
| Summed captured reviewer time | 563.2 min | 849.1 min |

The candidate adds 3.6% planned tasks, 4.0% call attempts, 46.9% active wall time and 50.8% summed
reviewer time. Wall time excludes the overnight pause; summed reviewer time overlaps across the
six concurrent rows. Tokens and dollar cost are unavailable. [Cost receipts](cost.json) and
[task attempts](candidate-task-costs.json) retain the incomplete and undispatched work separately.
Preparation, validation, previous stopped candidates and PR review are outside these totals.

Native packets supplied supporting source in 846/1206 completed tasks. The median input was
2686 UTF-8 bytes and median support 1340 bytes; total supplied input was 5,417,687 bytes. These
are [initial delivery measurements](delivery.json), not system/skill tokens, observed tool
retrieval or evidence that missing context caused a quality miss. The separate large-source
diagnostics above remain unscored and still leave their contracts/counterpart gaps unresolved.

The native parser retained 383 issue strings in candidate tasks versus 349 in baseline tasks.
These [descriptive counts](claim-counts.json) can repeat a mechanism across lenses and truncate
individual strings; they do not establish unique defects, factual precision or fewer repeated
claims. No new adjudication pass was commissioned.

[Sanitized native results](candidate.json), [initial/final verdicts](candidate-verdicts.json) and
[evidence integrity](evidence-integrity.json) preserve the complete measured result. Per-packet
raw source and model output remain private, bound by ledger hashes. Native publication records
this as a no-ship experiment; after instruction restoration the measured source is historical,
so the generated tracker must disclose that freshness rather than claim a current default result.

## PR validation follow-up

Native review found that packet census diagnostics collapsed every zero-supply span into
`omitted`. The diagnostic now preserves `not-in-diff`, `out-of-scope`, `truncated` and `omitted`,
with regression tests. This post-run fix does not change the reviewer execution fingerprint;
the original frozen census and model results remain unchanged. All 14 visibility tests passed.
The two-file validation returned 17 passes and one pre-existing census CLI concurrency failure:
two workers compete for Git’s index lock. A retained reproduction confirmed that failure, reported
as `2c9512d6-7366-48a1-b4dc-2f35fdd2efc8`. It is disclosed rather than retried to obtain a green run.

A second native finding exposed inconsistent reporting for explicitly disabled context modes:
`off` disabled preparation but its truthy string tagged plan metadata as context-enabled. Planning
and execution identity now use the same normalized mode. Ten benchmark planning/recovery tests
passed, including disabled-mode parity and enabled receipt coverage. This post-run edit changes
the benchmark module closure hash; it has not received a new model benchmark. The frozen result
remains bound to its original execution hash, and no quality claim is transferred to the later code.

The cache-status CLI also needed the prepared context used by the native gate. Its planner now
receives that context; all 119 review-gate tests passed, including cache parity in disabled and
enabled modes. Tests used mocked judges. Native review also claimed captured `git diff` recovery
was forbidden; the existing shared tool grant and a runtime argument probe refuted that claim.
The local waiver records its counterevidence. The later, distinct cache-status finding was fixed.
