# Sol correctness review: complete-claim replay

The fresh replay completed **130 tasks across seven reconstructed historical inputs**, producing **57 complete recorded claims**. Blinded AI assessment classified **47 as real and nine as false**; one occurrence remains unresolved because its original response lacked verifiable model attribution. One real claim was pre-existing, leaving **46 valid introduced, in-charter findings**. These are conditional, AI-adjudicated results, not production precision or human ground truth.

This is the evidence follow-up to [sc-2493](https://app.shortcut.com/benordlabs/story/2493) and [merged PR #596](https://github.com/norvalbv/devkit/pull/596). Sol remains configured by owner decision. The measurement supplies evidence for the next fixture and reviewer changes.

## Results and denominators

The source runner is frozen at `12d9a3b49922fa83c80a9eb16494fb88ff0cbd07`. The condition is `gpt-5.6-sol`, `chunk:400`, native default effort, producer issue cap **3**. Complete capture means complete terminal-checklist strings subject to that producer cap; it cannot recover unreported findings or intermediate reasoning. Outcomes were **83 PASS and 47 FAIL**, with **130/130 exact captures**, complete lens coverage, and no execution or census errors. No quality miss was rerun.

| Measure | Original blinded phase one | Composite after label comparison |
|---|---:|---:|
| Factual valid / invalid / unresolved | 47 / 9 / 1 | 47 / 9 / 1 |
| Factual resolved precision | 47/56 (83.9%) | 47/56 (83.9%) |
| Introduced, in-charter valid / invalid / unresolved | 46 / 10 / 1 | 46 / 10 / 1 |
| Introduced, in-charter resolved precision | 46/56 (82.1%) | 46/56 (82.1%) |
| Resolution coverage | 56/57 (98.2%) | 56/57 (98.2%) |
| Factual unresolved-inclusive bounds | 82.5%–84.2% | 82.5%–84.2% |
| Introduced, in-charter unresolved-inclusive bounds | 80.7%–82.5% | 80.7%–82.5% |
| Label-noise reference floor from the earlier corpus audit | 13.9%; study-specific floor unknown | 13.9%; study-specific floor unknown |

Every reviewer ratio here carries the repository's **13.9% label-noise reference floor**, the Wilson-95 upper bound from an earlier **2/48 blind relabel** of fixture labels, as required by the [coverage-cell ruling](../../../decisions/corpus-rows-admitted-by-coverage-cell.md). Its population differs from this replay: it is **not an estimated error rate for these AI judgments**. This study has no measured adjudicator-calibration floor. The displayed unresolved-inclusive bounds account only for unresolved captured claims, not mistakes in resolved judgments; neither those bounds nor the reference floor establish a quality improvement.

No comparison output proposed a factual revision, so the factual columns remain identical. [phase1.json](phase1.json) preserves the blinded assessment; [composite.json](composite.json) adds separately authored label relations and grouping. [comparison-counts.json](comparison-counts.json) records the transition.

The grouping response assigned **55 of 56 assessed claims to 42 causal groups**, omitting one claim. It contained no repeated or unknown member IDs. The original complete-partition validator rejected it; a separately audited partial-coverage adapter retained every returned membership and evidence string unchanged, leaving the omitted claim ungrouped as a host-derived coverage fact. It did not invent an AI judgment, repair an ID or rerun the call. The 57th captured claim was unadjudicated and never submitted to grouping.

All **10 introduced/in-charter-invalid occurrences** are among the grouped claims: **eight groups and two repeated invalid occurrences beyond the first**. Nine are assessed factually false; the tenth is real but pre-existing. The two repeats concern delayed callbacks across component lifetimes and a send guard whose input was already synchronously changed. The phase-one report's zero grouped repeats means grouping had not happened, not that repetition was absent.

One native causal group contains conflicting phase-one truth judgments for the same alleged mechanism in the same reconstructed input: one REAL and one NOT. Their caller-lifetime assumptions disagree. Both judgments remain unchanged; grouping does not establish which is correct. This is a direct limitation of the AI assessment and a reason to require executable caller controls before promoting these cases to durable benchmark labels.

Seven of the nine AI-rejected claims came from one input; the other two came from another. The aggregate therefore hides substantial variation across inputs.

Every emitted occurrence remains in the denominator after grouping. Repetition counts describe emitted alarms, not measured developer time or production repeat-block frequency. The bounds are V/N to (V+U)/N for captured claims; correlated occurrences do not justify an independent-observation confidence interval. There are no tasks with unknown missing-claim counts in this completed replay.

The [holdout-reset run](../../holdout-reset-2026-09-05.md) passed only **35/65 clean fixtures**. That clean-pass rate measures false blocks on labelled-clean examples; the claim precision above measures emitted findings from historical FAIL-selected inputs. Their populations and units differ, so the higher claim score is not evidence that the clean-case problem improved.

## Selection, reconstruction and sensitivity

The cohort was selected from historical FAIL archives. Eight archived inputs were checked; seven could be reconstructed and one was excluded after unsuccessful base reconstruction. All evaluated changed-file preimages, postimages and patch bodies are verified. Six inputs reproduce the entire archived diff bytes; the seventh differs only in index-hash abbreviation. None proves the full original observation state outside changed files.

The fixed six-byte-exact sensitivity excludes that seventh input and preserves existing judgments and groups without re-adjudication or regrouping: **120 tasks, 53 occurrences and 102 labels**. Both stages give factual precision **44/53 (83.0%)** and introduced/in-charter precision **43/53 (81.1%)**, with 100% resolution coverage. The composite still has 10 invalid occurrences in eight groups and two repeats. See [six-byte-exact-phase1.json](six-byte-exact-phase1.json) and [six-byte-exact-composite.json](six-byte-exact-composite.json).

The final transfer audit verified exact source rows, task and parent rosters, occurrence identities and text hashes, and all **107 historical-label bindings** against seven pinned censuses. Equal counts alone were insufficient. Hashes and sanitized per-input counts are in [provenance.json](provenance.json).

## Adjudication and limits

Phase one hid producer model, arm, waivers, repetition counts, other judgments and label candidates. Truth, change scope and charter scope were judged separately against neutral verified source snapshots. Native init and every root assistant message identify **claude-sonnet-5** as the author; auxiliary usage models are preserved separately. The original failed probe returned raw UNSURE but ambiguous author metadata. It was retained unresolved and never rerun. A different previously unattempted claim verified the corrected stream-attribution protocol.

Phase two compared full claims with historical labels and separately grouped causal mechanisms. The original blinded assessments remain immutable; any complete model-authored factual revisions are recorded separately and applied mechanically. Consequently the composite is explicitly post-label evidence. Of 11 comparison batches, nine passed validation; two batches covering 16 occurrences failed strict label-reference checks. Their whole outputs are preserved and unaccepted, without ID repair or reruns. Their original factual judgments remain intact and label relations stay NOT_COMPARED; all 56 assessed claims remain available to the separate grouping pass. No valid or failed comparison output proposed a factual revision. Raw native events, tool errors, schema repairs, limitations and field provenance remain private. No human labels or independent adjudicator-calibration estimate are claimed.

Two separately documented execution checks illustrate why static AI evidence needs qualification. One reproduced a watcher-baseline race using verified modules and in-memory boundaries; it did not run the full database/poller lifecycle. The second reproduced a local intent overwrite and conditional stale fallback, but shared mutex ordering could prevent the full claimed sequence; actual application reachability was not established. These two selected checks do not calibrate the AI judgments or alter them. See [mechanical-audit.json](mechanical-audit.json).

All **107 historical labels remain CAPPED_CONTEXT**: 104 are exactly 200 characters and three are shorter projections without established completeness. No approved complete original claim supplements were recovered. Their tentative relations cannot establish confirmed novelty or parent known/extra attribution. An extra can be a valid defect; unknown attribution is not zero extra-caused blocking.

The requested production FAIL-rise attribution remains **not estimable**: none of the seven replay inputs overlaps the recorded post-switch production diffs. Its fraction is therefore null, as recorded in [production-attribution.json](production-attribution.json). This cohort cannot establish the causal effect of the model switch.

## What to improve next

[sc-2500](https://app.shortcut.com/benordlabs/story/2500) is the existing next implementation ticket. Its prerequisite, pair-group holdout integrity in sc-2723, is merged. It calls for large bug/repair pairs and a runner that actually exercises chunk:400; the current fixture guard refuses inputs that would chunk. Reuse and extend paired families rather than adding unpaired gold rows. Declare the corpus/measurement epoch change.

The recorded disproofs suggest the following executable controls. These are proposed fixture designs, not additional truth labels or tests already executed:

| Control | What the fixture must establish |
|---|---|
| Component lifetime and writer topology | Whether the real caller permits the alleged instance reuse, delayed callback or concurrent writer; a mocked impossible state cannot establish a defect |
| Synchronous effects before a guard | The full action-to-editor-to-send contract, including an earlier operation that changes the value the later guard reads |
| Cancellation and teardown ordering | The real producer and consumer behavior for already-aborted requests and pending-state cleanup, including the final observable dispatch |
| Relocation versus introduction | Whether the same failing schedule already exists before extraction; a new file does not by itself make an old defect newly introduced |

Some static assessments make differing assumptions about caller lifetime. Resolve those assumptions with executable controls before accepting durable clean labels. A before/after relocation control also needs a change-scope label distinct from a factual-clean label.

Observed cases are exposed regression and calibration candidates. Future confirmation requires separately frozen, independently labelled unseen incident families, with buggy examples, verified repairs and derivatives assigned together. Score both members of each pair, clean-pass rate, defect recall, and repeated invalid occurrences; retain abstentions and uncertainty instead of treating waivers or another model's confidence as truth.

This design draws on [CR-Bench's separation of useful additional findings from noise](https://arxiv.org/html/2603.11078v1), [c-CRAB's before/after concern validation](https://arxiv.org/html/2603.23448v1), [contrast sets](https://arxiv.org/html/2004.02709v2), and [Platinum's label auditing](https://arxiv.org/html/2502.03461v1). Those papers do not establish Sol's performance on this cohort.

## Implementation validation

At the frozen implementation commit, **6,479 local tests passed, 14 were skipped**, and there were no failures. GitHub CI had **19 failing test identities and primary symptoms matching the exact base**, with no newly failing identities; non-test checks passed. The [merged publication base CI](https://github.com/norvalbv/devkit/actions/runs/33958787422), at `14224dd5864010e4942029a0f9b88665ed29eadc`, separately recorded **6,506 passed, five skipped and the same 19 failures**, including matching primary symptoms. Final publication adds documentation and sanitized evidence through normal `devkit ship` checks. Raw claims, historical labels and source paths remain in private research storage.
