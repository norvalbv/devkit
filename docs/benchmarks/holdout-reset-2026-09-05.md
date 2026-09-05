# Reviewer holdout partition reset — 5 September 2026

This is the fresh measurement required by [sc-2723](https://app.shortcut.com/benordlabs/story/2723).
It establishes a new partition epoch; it does not establish a reviewer-quality improvement.

## Partition repair

The implementation in `27541a7ed6529cf09b9d32abcd3f4be0f91a0363` validates the transitive union
of `caseId` and `variantOf` before benchmark filtering, preserves existing assignments during
admission, rejects contradictory anchors, and admits whole groups under an append budget.
Empty case IDs are rejected at structural validation.

| Suite | Rows (gold / clean) | Groups / pairs | Straddling groups, before → after | Holdout gold | Holdout clean, before → after |
|---|---:|---:|---:|---:|---:|
| Correctness | 140 (75 / 65) | 90 / 50 | 25 → 0 | 37 | 20 → 33 |
| API security | 44 (23 / 21) | 28 / 16 | 8 → 0 | 9 | 3 → 9 |

Only 33 decoys' `holdout` booleans changed. Each follows its gold sibling's existing partition.
Gold assignments, labels, fixture content, ordering, and behavior hashes are unchanged.
All five reviewer corpora now have zero straddling groups. Strict row hashes change for the
moved rows, and both affected corpus hashes change. Previous checkpoints remain immutable;
they must not be force-paired across this partition change.

Repartitioning does not erase previous exposure. These examples are useful diagnostics and
a baseline for the repaired split, but final confirmation after tuning needs new, frozen
incident families whose repairs and derivatives remain in the same partition.

## Frozen execution

Both suites run from the clean implementation commit above with frozen dependencies and an
initially absent baseline file. The effective model settings match the shipped configuration:
correctness uses Sol with four lenses and no cascade; API security uses Terra high with Sol
escalation. These small fixtures do not exercise production-sized chunking.
The runner reported the optional named-agent `codebase` profile unavailable and used its
configured subset under strict isolation; this tool-context limitation is part of this run.

```bash
env GUARD_CORRECTNESS_CHUNK=400 BENCH_MODEL=gpt-5.6-sol BENCH_CASCADE=off BENCH_CONCURRENCY=2 \
  node gate-engine/review/eval/reviewers/bench.mts run correctness --fresh --baseline
env GUARD_CORRECTNESS_CHUNK=400 BENCH_MODEL=gpt-5.6-terra@high BENCH_CASCADE=on BENCH_CONCURRENCY=2 \
  node gate-engine/review/eval/reviewers/bench.mts run api-security --fresh --baseline
```

The runs retain their native baseline evidence. Verification checks the complete row sets,
row and behavior hashes, partitions, model/cascade settings, corpus and gate identities, and
outcome fields before publication. Publication uses `methodology-reset` and `assessment:unknown`.

## Results

Correctness completed at **2026-09-05T04:11:55.116Z**, with all 140 rows verified and no final
outages or engine errors. Its [sanitized checkpoint](checkpoints/8a4d6cc13bd61117f57758e43fbcc32db9ae829a95a2afee850cdd2b1567cfbc.json)
records the complete row outcomes and a non-comparable methodology reset.

| Correctness metric | Sol single pass |
|---|---:|
| Labelled defects blocked | 71/75 (94.7%) |
| Clean fixtures passed | 35/65 (53.8%) |
| Both pair members correct | 21/50 (42.0%) |
| Repaired clean siblings passed | 23/50 (46.0%) |
| Standalone clean fixtures passed | 12/15 (80.0%) |
| Holdout gold blocked | 34/37 (91.9%) |
| Holdout clean passed | 17/33 (51.5%) |

Of 30 false blocks against the clean labels, 27 were repaired siblings. Of the 71 correctly
blocked gold rows, 67 matched the expected checklist lens and four matched only the verdict;
a matching lens still does not prove the specific claim identifies the labelled defect.

The original full run retained 140 outcomes and refused baseline publication because
`corr-pr138-ci-breaking-gate-engine-coverage-pair` had one execution outage. Its completed
ledger was saved privately before recovery. Repeating the same command **without `--fresh`**
salvaged all 139 non-outage outcomes and reran only that fixture's four lenses; it then passed.
No quality miss was rerun. The final native baseline SHA-256 is
`3cf6a02f02654cca7b7ee15920a21bfa2a197a43c714d486a1564b5bd4edfac4`.

API security completed at **2026-09-05T03:00:07.641Z**, with all 44 rows verified and no outages
or engine errors. Its [complete experiment evidence](experiments/2026-09-05-holdout-reset/api-security.json)
is retained separately because the run fails the accepted tracker's clean-pass floor.

| API-security metric | First pass | After Sol escalation |
|---|---:|---:|
| Labelled defects blocked | 21/23 | 20/23 (87.0%) |
| Clean fixtures passed | 13/21 | 14/21 (66.7%) |

Both members were correct in 7/16 pairs (43.8%). Repaired clean siblings passed 9/16 times;
standalone clean fixtures passed 5/5. Holdout gold blocking was 8/9 and holdout clean pass 5/9.
The 29 Sol escalations rescued one of eight first-pass clean blocks and overturned one of
21 correctly blocked gold rows. These are measurements against the corpus labels.

The final 20/23 gold result meets the 75% floor; 14/21 clean fails the 85% floor. No quality
miss was rerun. The accepted-checkpoint schema has no rejected-measurement mode, so the new
API result remains a standalone experiment and the earlier accepted checkpoint is preserved.
Its older corpus identity is not evidence for the repaired partition.

## Interpretation

Gold-row blocking is verdict-level recall against the corpus labels. It does not establish
that every emitted claim is true or identifies the labelled defect. Clean pass and pair
consistency show discrimination against those labels; neither is claim precision. The complete
finding adjudication in sc-2493 addresses a separate uncertainty on realistic replay inputs.

The tracker accepts complete Sol single-pass evidence without a correctness quality floor.
An accepted checkpoint therefore must not be read as approval of its false-block burden.
The owner ruling to keep Sol remains unchanged.

## Validation

The full suite passed: 6,385 tests passed, 14 skipped across 334 files. The 54 focused corpus
tests passed, including the empty-case-ID regression. Corpus lint checked all 237 rows with
zero problems, and all 184 affected correctness/API fixture repositories validated. Benchmark
typecheck passed. The implementation passed the managed ship gates in PR #595.

GitHub CI remains red on inherited failures: all 18 failing test names in
[PR #595's run](https://github.com/norvalbv/devkit/actions/runs/33937755797) also fail on the
[exact base run](https://github.com/norvalbv/devkit/actions/runs/33875075343), which has 19
failures. They concern supervisor fixtures, Git author identity, preserved ship resume under
Bash 4, and judge-tamper fixtures; none is new in this change. All 37 new holdout tests passed
in CI. Missing fixture identity is
tracked by [sc-1896](https://app.shortcut.com/benordlabs/story/1896). The distinct missing-helper
resume failure was recorded as autonomous issue `36048c7b-132c-4222-aae7-6e2acb6c8c6e`.
