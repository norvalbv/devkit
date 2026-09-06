# Typed-reply source qualification (sc-2866)

**The original resend is reproduced; the clean label remains withheld.** This investigation adds
source evidence for another incident, `family-005`, using the existing qualification workflow.
It admits zero rows, creates no qualified five-round timeline, and runs no reviewer benchmark.
The [sanitized receipt](source-family-qualification-2026-09-06.json) preserves the controls and
native coverage census. [Source-control decisions](../decisions/benchmarks-grow-from-telemetry.md)
and [history-experiment decisions](../decisions/reviewer-history-experiments.md) govern the result.

## What the example shows

A task starts with its original instructions and crashes before its first assistant response.
On retry, the archived extractor treats those instructions as a new user reply. Its caller then
uses them instead of the continuation nudge. The source repair excludes the initial message while
retaining later replies. That narrow behavior is testable without running a model.

| Transcript scenario | Archived extractor | Adapted partial repair | Source repair |
| --- | --- | --- | --- |
| Original instructions only | Resends instructions | Returns no new reply | Returns no new reply |
| Instructions, then a newer reply | Includes both | Keeps newer reply | Keeps newer reply |
| Replies before a delivered hidden continuation, then a newer reply | Includes old replies again | Includes old replies again | Keeps newer reply |
| A hidden continuation was saved but dispatch has not happened | Keeps preceding reply | Keeps preceding reply | Returns no new reply |

The last row is a different condition from a **delivered** continuation. The source repair assumes
that saving a hidden continuation establishes a delivery boundary. Its actual send path persists
the message before awaiting machine identity and before notifying the execution listener.

A separate control executes the unmodified source `sendMessage` with explicit dependency doubles.
It pauses the identity dependency after a file-backed persistence double has saved the hidden
message. At that point there are **zero execution-listener calls**, but the repaired source
extractor already returns no pending reply. Releasing the pause produces one execution call.
This demonstrates why persistence alone cannot certify dispatch.

This is **not a complete application-loss reproduction**: actual SQLite, app restart, admission
recovery and the provider are not executed. The full recovery outcome remains unresolved. The
clean label is withheld rather than resolving that uncertainty in the repair's favor. This also
does not assert that today's production implementation still has the same behavior.

## Controls and source identity

The original correctness-scoped archive contains 14 files: 436 additions and 149 deletions,
**585 changed source lines**. The old scale readout's 1,054-line figure is not reused as a changed-LOC
count. No tests or documentation were added to inflate the selected input.

All 14 archived preimages match the parent of the eventual source implementation commit. Applying
the archive there reproduces its complete diff bytes exactly, including Git's nine-character blob
abbreviations. Every captured repaired-source file was checked against that implementation commit:
29 files, with full Git blob IDs and SHA-256 hashes retained privately.

Those checks establish a reproducible selected-source reconstruction. They do **not authenticate
all unchanged historical context**: the available original telemetry does not record HEAD. The
archive is the correctness scope, while the original ship formatted 22 staged files. The complete
original staged change and exact native checklist captures have not been recovered. Neither a
merely applicable parent nor the final PR description fills those gaps.

The extraction control executes the unchanged source extractor, marker helper and synchronous
image readers. A fail-closed stub prevents access to the unused authentication dependency; there
are no real credentials, network requests or production database writes. Across 12 explicitly
chosen cases, the archived extractor matches five expected outputs, the adapted partial version
eight, and the source repair twelve. These are **control outcomes, not reviewer accuracy scores**.
Cases cover initial/newer/multiple replies, assistant and conditional delivered-wake boundaries,
both image shapes, image-only input, empty input and non-image files.

The partial version changes only the initial-message boundary in the original extractor. It is an
investigator adaptation, not an observed intermediate repair or an independent incident. The final
source repair also changes surrounding modules; it is not transplanted into the original archive
and presented as an observed clean whole change.

The helper is absent from the original source base. The actual base caller was inspected and sends
the continuation nudge directly, but was not executed by these controls. No executable base PASS
is claimed. Source inspection establishes the normal task-created, kickoff-first transcript path;
other imported or concurrent ordering remains unqualified. A type permitting system messages
alone does not prove a reachable system-prefix defect.

## Exposure, other findings and native coverage

This incident already appeared in the [August scale probe](experiments/2026-08-23-scale-probe/README.md)
as `032d8860`. It is separate from the four incidents investigated by [sc-2002](source-family-census.md),
but it is **exposed development evidence**, not a new unseen holdout. All future descendants must
retain that incident linkage. Repeated findings and adapted rounds cannot increase the independent
family count.

The private ledger retains six statements visible in the original ship log: two correctness
statements and four completeness statements. The extraction finding has the controls above; the
mode-propagation claim, latch clearing and toast behavior remain unresolved. A separate capacity
classification is supported by inspected source but has no full admission execution control here.
The documentation complaint is outside the declared extractor scope. These six statements are
neither complete checklist captures nor a replacement for the older mined-label population; they
cannot support a precision estimate or establish that the remaining change is clean.

A current, zero-judge native census of the reconstructed archive produces **three chunks and ten
tasks** under cap 400, with the Sol condition explicitly pinned. The relevant parsing task receives
the complete declared extractor span and part of the caller span; the unchanged marker helper is
outside its selected files. The contracts task has the same supplied/partial/out-of-scope pattern.
Other local tasks have those target spans out of scope. These are initial-input observations,
not measured retrieval, misses or ten historical reviewer outcomes.

## Reproduction

Use Node 24.19.0 and the private evidence directory
`~/.devkit/research/source-family-next-20260906/`. Exact source and claim text remain there. The
committed receipt hashes the private source inventory, source provenance, control scripts and
results, assessment, claim ledger, research and census. Missing or mismatched files mean unavailable
reproduction; never invent replacement historical evidence.

1. Run `verify-evidence.py` from the private directory to check the committed receipt, private
   hashes, Git source bindings, byte-identical archived diff and recorded outcomes.
2. Run the extraction and send-order controls. Each writes to a new private run directory; preserve
   the original results. The recorded successful runs are `controls-ryw8hk` and
   `delivery-controls-QkOjma`. Temporary paths and output hashes differ on rerun.

```sh
node ~/.devkit/research/source-family-next-20260906/run-controls.mjs
node ~/.devkit/research/source-family-next-20260906/delivery-order-control.mjs
```

3. From a devkit checkout containing PR603, rerun the native census against the frozen source view:

```sh
export GUARD_CORRECTNESS_MODEL=gpt-5.6-sol
node gate-engine/review/eval/reviewers/scale/corpus/census-cli.mts \
  ~/.devkit/research/source-family-next-20260906/manifest.private.json case-005 \
  ~/.devkit/research/source-family-next-20260906/source-bug \
  ~/.devkit/research/source-family-next-20260906
```

The source view is sparse and privately owned. Its complete index records unchanged source objects;
only the materialized input and inspected dependencies are used. The census manifest intentionally
retains `unresolved` with no qualified-label evidence fields. No repaired-view census or complete
five-round execution is claimed. Qualification is a separate assertion from source visibility.

Validation for this documentation delivery covers the source controls, native census, private and
public receipt reconciliation, source hashes, JSON, local links and benchmark tracking. It does
not require a full product test run because implementation, corpus and scores are unchanged.

## Research and next action

[SWE-Review v1, Appendix B.2](https://arxiv.org/html/2607.06065v1#A2.SS2) motivates checking faulty or
insufficient reproducers. [MalPR-Bench v1](https://arxiv.org/html/2608.25730v1) distinguishes target
diagnosis and paired complete-fix controls. [MCR-Bench v1](https://arxiv.org/html/2608.27442v1) motivates
lifecycle consistency checks. These papers motivate the procedure; they do not verify this source
case or prove that history helps Sol. Prior-art review recommended reusing the existing workflow.
Reference checkouts and the deep-research service were unavailable; broader prior art is unverified.

The next reassessment must establish the delivery acknowledgement and recovery contract around
interrupted post-persistence/pre-dispatch sends, including concurrent typed intake, and validate
actual caller/base behavior and remaining source-context provenance. If that broad source slice
cannot be qualified, acquire another coherent source family. A smaller adapted extractor case
would still be the same exposed family and would need explicit admission; it must not silently
stand in for a clean large PR. [sc-2832](https://app.shortcut.com/benordlabs/story/2832) remains open:
qualified frozen cases and native execution integration are still required before measurement.
