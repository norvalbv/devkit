# Reporting-family claim audit — 5 September 2026 (sc-2831)

The [PR598 measurement](large-repair-pairs-2026-09-05.md) blocked both large bug cases and both
large repaired cases. This audit establishes target detection for the selector case but not the
classifier case. All four repair-side claims remain unresolved. No repaired-case false-positive
rate or model-quality improvement follows from these results.

This is an exposed, source-grounded investigation with executable counterexamples. Investigators
saw the labels and earlier results; their assessments are not blinded, human ground truth, or
independently calibrated precision. The exact evaluator model family was not captured in the
research receipt, so these records cannot qualify cross-family AI precision. A separate investigator
reviewed the handoff and source identities, and the root investigator independently executed the
classifier counterfactual. Neither step makes this a blinded study.

## Scope and provenance

The frozen reporting family contains four rows and 40 completed tasks: eight claim occurrences on
bug cases and four on repaired cases, 12 total. The two repairs share the same behavior identity;
they are not independent samples. Every recorded occurrence remains in the table below.

| Identity | Value |
| --- | --- |
| Reviewed source head | `c81a110377a379e7c8a119051655a9788b47e67f` |
| Merged implementation | `3a8a88de60caa7d201674fee517836bbdcd4cd67` |
| Gate / corpus identity | `26aaa6242a5d` / `15e41709a260` |
| Final ledger SHA-256 | `e1d5d55e8e8e2278cc36bfd2883434996105d9c6764ac1bc73e512d1b0f68ef3` |
| Extracted census SHA-256 | `36274996481259aceb89f2f1a5725828b7966555134e99d000e7a0b8d4b64ff6` |
| Frozen corpus file SHA-256 | `fbc2afd974944cc094d957f6b8c29153349be4a0f90f54c9df26a23c64497a15` |
| Assessment criteria SHA-256 | `32c81b5d9302b67ccef6b98bb095aa49d5955e910db016ef57efd69ee95038a0` |

The private source is the final completed ledger under `~/.devkit/research/sc2500-large-pairs/`.
The census, materialized source manifests, criteria, full claims, observations and provisional
assessments are under `~/.devkit/research/epic2491-followup/adjudication/`. Read full terminal
strings from `task.capture[].snapshot.items[].issues`; capped `task.res.items` is not equivalent.
The extraction manifest is not a native claim-cli results envelope or an accepted benchmark.

Initial behavior probes preceded the criteria freeze. The subsequent contract tracing and
base/bug/repair counterfactuals followed it. This ordering is retrospective evidence development,
not prospective registration. Nine contract-control subprocesses and four independent root
counterfactual checks completed on Node24.19.0; no reviewer rerun supplied these conclusions.

## Complete occurrence accounting

REAL means the investigator found source and executable support. UNSURE means a load-bearing
requirement or input-domain premise remains unresolved. Both remain ineligible for qualified AI
precision here. SAME_DEFECT identifies the selector's demonstrated target; DISTINCT compares with
that case's specific labelled target, not with an exhaustive inventory of possible defects.

| Occurrence | Case | Truth assessment | Target relation | Full claim SHA-256 |
| --- | --- | --- | --- | --- |
| 01 | selector bug | REAL | SAME_DEFECT | `570f1be76a354d0cf9ee4d2872e4857a52313630a82612d9eeb72394475e85e8` |
| 02 | selector repair | UNSURE | DISTINCT | `f8577c742c76b58bde54c70b5ef42fc8ac029b84e3b304d0ae2454ac23c1a769` |
| 03 | classifier repair | UNSURE | DISTINCT | `26c4e8dafc1131d774e1cc32f090d960d60e10d510300e3cda57463dcd972385` |
| 04 | selector bug | REAL | SAME_DEFECT | `abb9ea94cf46aadf89447e70567e264924178d5aca2264d084ac3a977141e3ee` |
| 05 | selector bug | REAL | SAME_DEFECT | `2706c04140c9d016528b22dfd9f9f1bb8c9a35b2cf87c71e2ca4700fb61004a0` |
| 06 | classifier bug | UNSURE | DISTINCT | `501e819f78922b7b3850ed51dfff88bb2149d35f397b332f8fbcb3b3a2453ade` |
| 07 | selector bug | UNSURE | DISTINCT | `9eaf018e8eb26f7ce011dd3f3e943315fcf4a0e929820c034630ef168c8d6181` |
| 08 | selector repair | UNSURE | DISTINCT | `4f3afa586bba5934ebc9fa5efc6de8451a03521d88b07ad20ee88930e54f97fa` |
| 09 | classifier bug | UNSURE | DISTINCT | `d92b84330a12a9717ca8001ff693de9d02337aee777d9051cd5d6fb038774536` |
| 10 | classifier repair | UNSURE | DISTINCT | `2ce912a883efa9badb3a80144d212de46ba659679c1470d68a2e946ce10d5b1a` |
| 11 | selector bug | REAL | SAME_DEFECT | `dd0bdf80d3d09ef8105d53f49b26d1436d4e42571466c8e77ca8f48cf0f40963` |
| 12 | classifier bug | UNSURE | DISTINCT | `60c3c5700505487202db2f24e06e9123d55d3bf07e1d7b9767f79488abf90c9e` |

There are four supported selector-target occurrences and eight uncertain factual assessments.
The eight include the classifier's broader allegation and seven additional reporting/helper
occurrences. No occurrence is labelled a confirmed false alarm. The four repair-side occurrences
are all UNSURE. Repeated selector occurrences count toward emitted burden, but describe one target.

## Executable target distinction

The selector base and repairs reject empty, unknown and mixed valid/unknown selections while
preserving valid and default selections. The bug removes that validation. The command propagates
the resulting failure list. Four recorded findings describe that introduced target.

The classifier's intended defect is asymmetric counting of mirrored losses and gains when success
flags stay unchanged. Its emitted finding concerns a different combination of gains and success
flags. The following results come from the exact public fixture functions:

| Source variant | Other input: improvements | Target mirror: regressions / improvements |
| --- | ---: | ---: |
| Original base | 1 | 1 / 1 |
| Buggy change | 1 | 1 / 0 |
| Repaired change | 1 | 1 / 1 |
| Separate proposed-change counterfactual | 0 | 1 / 0 |

The counterfactual removes the reported behavior but leaves the target defect. It never modifies
an authoritative fixture. Whether the other input exposes a real pre-existing semantic defect
remains uncertain; its unchanged behavior cannot establish detection of this introduced target.

The regression in `gate-engine/review/eval/reviewers/__tests__/repair-controls.test.mts` executes
these four variants and separately demonstrates the current scorer's expected-lens proxy. A
synthetic finding in the expected lens receives `reasonClass: right-item` and a matching FAIL
verdict without mechanism validation. The test makes that limitation observable; it does not
replace claim adjudication with a new text heuristic or change the scorer.

Consequently, the original “2/2 bug cases blocked” remains a correct raw-verdict observation.
“2/2 intended bugs diagnosed” is unsupported; only the selector target is established here.
The other classifier-case findings concern distinct reporting behavior. No aggregate checkpoint
is rewritten or silently recomputed from these exposed assessments.

## Why repaired cases remain unresolved

All reporting modules are added by the fixture diffs and absent from their base. Source code copied
from an older repository revision does not make its behavior pre-existing in the reviewed fixture.
The adaptation omitted boundaries that the original consumers supplied:

- Reporting an unfavorable result does not independently establish a nonzero-exit requirement.
  The source decision benchmark makes failure conditional on an enforcement option; the adapted
  command has no consumer or equivalent policy establishing the promise.
- Malformed comparison and row inputs reproduce crashes or inconsistent grouping. The fixture
  lacks the original admission schema, so neither “this input is supported” nor “this input is
  forbidden” can be assumed. Loose parameter types are not a complete behavioral specification.
- A reason-classification helper produces a disputed category on a constructed message, but the
  adapted tree contains neither its caller nor the source producer's constrained vocabulary.
  An exported but uncalled helper is not thereby proven harmless or required to parse arbitrary prose.

These are explicit unknowns, not votes to accept the existing PASS labels. Original source
validation can guide a future reconstruction, but it cannot be retroactively supplied to the
reviewer as though it were present in the measured fixture. Restoring a source-grounded boundary
must apply consistently to all four family members, preserve target counterexamples and create a
new execution identity. Declaring problematic inputs invalid in comments merely to placate a
reviewer would not establish that boundary.

## Research and next measurement

[MalPR-Bench (26 August 2026)](https://arxiv.org/abs/2608.25730v1) separates blocking verdict,
target diagnosis and grounded evidence using case-specific rubrics. That distinction motivates
this audit; a security benchmark does not validate devkit's correctness labels.
[c-CRAB (7 April 2026 revision)](https://arxiv.org/abs/2603.23448v3) uses executable before/after
evidence while acknowledging imperfect generated-test validation. [SWE-Review (7 July
2026)](https://arxiv.org/abs/2607.06065v1) likewise describes inadequate or faulty reviewer tests.
Executed assertions still need source-grounded requirements and reachable triggers.

This report and its regression controls complete the bounded offline audit. It does not settle
unspecified report contracts, qualify a new precision estimate, change production blocking policy,
or refresh stale reviewer suites. The source-grounded boundary reconstruction feeds sc2002's
independent-family work; sc2832's history experiment must not treat these unresolved repairs as
confirmed clean controls. Paid remeasurement follows a separately frozen and budgeted protocol.
Changes only to an assessment require a new assessment identity; changed reviewer-visible code
requires new execution, including the whole affected family. Original checkpoints remain immutable.

Reproduce the committed control with the repository test script and Node24 or another supported
runtime: `bun run test:run gate-engine/review/eval/reviewers/__tests__/repair-controls.test.mts`.
The full claim trace additionally requires the private source artifacts above. If they are absent,
report that limitation rather than regenerating historical claims with a new model run.
