# Source-family census (sc-2002)

This delivery adds an opt-in, zero-judge census around the existing production planner. It records
which required source lines are initially supplied to each task, independently of whether a
candidate's bug or repair label is established. It does not change reviewer prompts, scoring,
production selection, corpus rows or accepted checkpoints.

## Source investigation

The September 5 scan found 577 candidate-labelled diffs among 780 archived, scoped diffs. Those
are repeated observations, not 577 independent defects. The miner's tier A establishes a file's
normalized diff identity across attempts; it does not establish the finding's truth, full caller
context, or a clean repaired counterpart. The historical target of 230 admitted rows is superseded.

Four incident families were investigated:

| Family | Evidence established | Admission outcome |
| --- | --- | --- |
| family-001 | An existing command works in the source base, fails in the archived large change, and works after a narrow source-grounded repair | Two exposed diagnostic members; other claims remain unresolved |
| family-002 | A synchronized two-writer control reproduces divergent persisted values in the archive, with the same invariant passing in the base and source fix | Excluded from the large clean-pair cohort: changed context and a disclosed separate residual |
| family-003 | Existing small lock control remains useful; source implementation is substantially smaller than its total PR | Excluded from large coverage; no padding added |
| family-004 | Existing small race control remains useful; the inspected source PR retains the affected implementation | Excluded: no independently observed source repair for a large pair |

**Zero new qualified clean pairs are admitted.** The first family supplies a real, source-controlled
large diagnostic pair for testing the census. Its qualification is `target-controlled`, which is
deliberately weaker than `qualified-pair`. This work does not establish eight independent families,
a clean-pass rate, or a production improvement. sc-2832's measured history experiment remains
dependent on qualified family selection; adapter development can proceed independently.

The command control runs `baseline-status --help` in isolated source views. The base exits 0; the
archived bug exits 1 with an unknown-command response; the derived repair exits 0. The repair restores
only the missing dispatch and preflight entries, retaining the surrounding large change. The final
source fix independently restores those entries but changes other code, so it is corroboration,
not the paired repair. This proves that specific compatibility invariant, not the absence of other
bugs. The original base is anchored by the archived ship log and checked against the archived patch;
patch applicability alone is insufficient provenance.

## What the census measures

Private manifests bind the complete declared family universe, original base and diff hashes,
provenance/requirement/control/assessment hashes, exposure, qualification and exact base/post source
spans. A span identifies its file hash and inclusive line range, plus the hash of those lines joined
with LF without adding a final LF. Missing evidence, changed snapshots and broken family links
refuse a completed result. The schema validates receipts structurally; it cannot establish that an
investigator's requirement is true or that an undeclared incident is independent.

`censusSource` reads an explicitly reconstructed private Git worktree. It freezes the staged tree, verifies its diff against the archived hash, and uses explicit
base/tree reads throughout configuration resolution, planning and evidence rendering. Untracked
configuration is excluded; the native snapshot config resolver applies the usual defaults and
environment precedence, with both raw and resolved configuration identities retained. Live index changes cannot substitute
transient content. It calls existing `selectReviewers` and `planFixture`, which calls production `planReviewWork`. Each task's evidence
comes from `buildCappedDiffEvidence`, the renderer used by the cascade. Required spans never change
selection or add privileged context to the reviewer. The fixed condition is cap 400 with the four
current lenses and the Sol pin; no judge is launched.

Each required span is reported as supplied, partial, out-of-scope, not-in-diff, omitted or truncated.
Only complete source lines at their actual coordinates count. A filename in the inventory, matching
text elsewhere, or an omission marker cannot earn coverage. Renamed/deleted base paths are mapped
separately from post-image paths. Native caps slice UTF-16 string units, while evidence sizes and
hashes use UTF-8 bytes; the implementation uses the real rendering rather than approximating caps.

The two large diagnostic views each plan 11 chunks and 34 first-pass tasks. Their contracts task
receives part of the required dispatcher span; the unchanged handler and caller spans are outside
the selected diff. Local-lens coverage is reported separately, and only the contracts lens is the
labelled target's lens. Those absences are **initial supply**, not measured reviewer misses. Every
retrieval field says `not-observed-zero-judge`; a future run must establish actual retrieved spans
from retained evidence before claiming exposure.

| Coverage cell | Source-controlled large diagnostic families | Qualified large repair pairs |
| --- | ---: | ---: |
| State / retry | 0 | 0 |
| Race / caller lifetime | 0 | 0 |
| Parsing / edge classification | 0 | 0 |
| Whole-diff writer / reader contracts | 1 | 0 |

Artificial 2k-line, 100-small-file and single-5k-file shapes are deterministic adapter tests only.
They verify file packing and counterpart separation, and never become labelled benchmark cases.
The existing four-row reporting family remains exposed and unresolved as documented in
[the sc-2831 audit](reporting-family-audit-2026-09-05.md).

## Reproduction and boundaries

Private inputs and complete receipts live under `~/.devkit/research/sc2002-families/`, including
`manifest.private.json`, `dispatcher-provenance.private.json`, source controls and retained exclusion
analysis. These files are necessary to reproduce the historical source census. Missing artifacts
mean unavailable evidence; do not guess a source base or regenerate historical findings.

Run on Node24 or a supported runtime, from the repository root:

```sh
node gate-engine/review/eval/reviewers/scale/corpus/census-cli.mts \
  ~/.devkit/research/sc2002-families/manifest.private.json case-001 \
  ~/.devkit/research/sc2002-families/dispatcher-bug \
  ~/.devkit/research/sc2002-families
```

Use `case-002` with `dispatcher-derived-repair` for its counterpart. Each invocation owns a fresh
private output directory. Successful stdout contains only fixed categories, generated/validated
aliases, counts and hashes. Detailed errors remain private. Source, manifest, renderer/planner
closure, dependency lock and runtime identities accompany each census. The committed readout is
`source-family-census.json`; it is unmeasured diagnostic evidence, not an accepted tracker baseline.

Validation uses `bun run test:run gate-engine/review/eval/reviewers/scale/corpus/__tests__`,
`bun run benchmarks:corpus`, `bun run benchmarks:check`, and `bun run benchmarks:typecheck`.
The nested `scale/corpus/tsconfig.json` additionally checks the new manifest and visibility core
strictly. Including the native census wrapper also traverses the pre-existing untyped decisions
benchmark; that broader check reports legacy dependency errors, with no diagnostics in the new
modules. Wrapper behavior is covered by real private-repository and CLI tests. Neither the ordinary
benchmark typecheck nor the focused core check is described as full strict coverage of that legacy
dependency tree.

Research informed the separation of target, verdict and evidence: [MalPR-Bench
v1](https://arxiv.org/html/2608.25730v1). [SWE-Review
v1](https://arxiv.org/html/2607.06065v1), Appendix B.2, documents inadequate or faulty reproducers.
Neither paper validates these cases or implies that more context or history improves Sol. Native
reuse was confirmed locally; complete prior art remains unverified because no reference checkouts
were declared. The next data step is to resolve or exclude remaining defects in coherent repaired
contexts and acquire independent missing-cell families before any registered model comparison.
