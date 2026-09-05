# Source-family qualification (sc-2843)

**Reject `case-002` as a clean counterpart.** Its narrow command repair works, but the unchanged
surrounding implementation retains a reproduced correctness defect. Both members of `family-001`
remain `target-controlled`, exposed development evidence. Zero clean pairs or corpus rows are
admitted. This resolves the qualification attempt; it does not improve a measured reviewer score.

This follows [sc-2002's source census](source-family-census.md). That historical receipt remains
unchanged. The new [sanitized receipt](source-family-qualification-2026-09-05.json) binds this
investigation, controls and two new native census runs. Production code, reviewer prompts,
benchmark scores and accepted checkpoints are unchanged.

## What was established

The original requirement says a failed refresh must remain visibly unknown. In an isolated Git
repository with a known local tracking ref, the control first checks a working local remote, then
points that remote at an absent local directory. It invokes the actual archived CLI and renderer;
it does not replace their report writer with an investigator-written result.

| Actual observation | Archived bug | Narrow command repair |
| --- | --- | --- |
| Two existing public commands, help dispatch | Both exit 1 | Both exit 0 |
| Successful forced refresh, then cached check | Exit 0, then 0 | Exit 0, then 0 |
| Failed forced refresh | Unknown warning; exit 4 | Unknown warning; exit 4 |
| Next check inside the cache window, without a successful refresh | Warning disappears; exit 0 | Warning disappears; exit 0 |
| Another forced check of the still-failing remote | Unknown warning; exit 4 | Unknown warning; exit 4 |

The same two commands exit 0 in a pristine checkout of the original base. This extends the original
command-compatibility control. The newly added refresh implementation does not exist at that base:
its residual control is **not applicable**, not a fabricated base PASS or another independent gold.

The cache may legitimately suppress another network attempt. The defect is losing the failed
refresh's uncertainty in the downstream warning and exit code. The retained source specification
and CLI help establish that requirement; the original test expecting failed-then-cached does not
overrule it. A separate check of the unchanged helper covers successful caching, forced retry,
expiry and a second reader entering before the first fetch returns. The last is a deterministic
interleaving witness, not a measurement of real concurrent failures or their frequency.

These controls demonstrate enough to reject this particular clean label. They do not certify every
other finding, establish a complete repair, or imply that the final historical PR still has this
bug. The eventual source fix has a different surrounding context and is not substituted for the
paired repair.

## What the finding audit means

The investigation retained 50 occurrences, grouped into 27 investigator-defined mechanisms for
navigation. Those groups include disputed claims and test criticisms; they are not 27 verified bugs
or independent families.

| Retained population | Occurrences | Evidence limitation |
| --- | ---: | --- |
| Original correctness log statements | 17 | Expanded log findings survive; original checklist/transcript unavailable |
| Other original reviewer/completeness findings | 7 | Log statements, including repeated target and refresh findings |
| Later mined candidate labels | 26 | Truncated, later-context observations; projected into the original source separately |

Every retained occurrence has a private disposition, mechanism group and evidence reference. Among
the 17 original correctness statements: eight are source-supported, one concerns test validity,
one is partially supported, one is contradicted by the original caller path, and six remain
unresolved. Source-supported is a bounded source assessment, not independent human ground truth;
only the cited controls have executable receipts. Repeated findings about the same failed-refresh
mechanism remain separate occurrences linked to one mechanism.

The contradicted finding assumes a hook consumes the cache, while that exact original hook always
forces a refresh. The intended hook caching is itself incorrectly wired. Both facts can coexist:
substituting the intended caller for the actual one would incorrectly validate that finding.
Several later claims also describe code absent from the original snapshot, or behavior already
present in its base. Their later-source truth remains unjudged.

Unresolved entries preserve missing or conflicting requirements, including advisory delivery after
process death, warning deduplication, argument grammar and concurrent installation guarantees.
Other partial entries separate observed source mismatches from stronger unsupported build or
retrieval consequences. No majority vote, waiver or later PASS resolves these uncertainties.

The exported database has local-lens PASS/zero aggregates that disagree with the original log's
failures. Preserve both artifacts. The available rows do not recover the historical per-chunk
checklists, so this ledger is not fed into the native exact-claim scorer and cannot provide a
precision or false-positive rate. Missing original evidence stays unavailable.

## Reproduction and verification

Use Node 24.19.0 and the private evidence on the investigation host. The working repository for this
receipt starts at merged PR601, `dfb35451fb659dc9e34a2d6bc408f1f73c11d27a`.

Private inputs live under `~/.devkit/research/source-pair-qualification/`; original source snapshots
remain under `~/.devkit/research/sc2002-families/`. The JSON receipt hashes the captured log, database
export, original/later claim files, source audits, complete disposition ledger, control script and
result, assessment, manifest and research records. The original base/diff identities are retained
in each census. Raw source and finding text are not committed.

1. Verify the private files against the JSON receipt before execution. Missing or mismatched files
   mean unavailable reproduction; do not reconstruct historical authority from shortened labels.
2. Read `claim-dispositions.private.json` alongside both source audits and the archived code. These
   legacy log statements lack the checklist capture needed by the existing exact-claim workflow;
   do not synthesize that capture to satisfy its schema.
3. Run the control below. It verifies the original base, staged diff and absence of unstaged source
   changes, executes the untouched source, and rechecks its tree. Each run creates a fresh private
   `controls-*` directory and retains its temporary repositories and report. The original successful
   report is `controls-XYz1zN/report.private.json`; later output hashes can differ with temporary
   paths and generated Git identities. Compare observed behavior and pinned source/script hashes.

```sh
node ~/.devkit/research/source-pair-qualification/run-controls.mjs
```

4. Rerun the existing native census from the repository root:

```sh
node gate-engine/review/eval/reviewers/scale/corpus/census-cli.mts \
  ~/.devkit/research/source-pair-qualification/manifest.private.json case-001 \
  ~/.devkit/research/sc2002-families/dispatcher-bug \
  ~/.devkit/research/source-pair-qualification

node gate-engine/review/eval/reviewers/scale/corpus/census-cli.mts \
  ~/.devkit/research/source-pair-qualification/manifest.private.json case-002 \
  ~/.devkit/research/sc2002-families/dispatcher-derived-repair \
  ~/.devkit/research/source-pair-qualification
```

The manifest preserves family/variant links, source identities, original target requirement and
`target-controlled` state, with new control and assessment hashes. Its file-byte hash in `receipts`
is distinct from the native census's parsed/canonical `manifestSha256`. Both runs still produce
11 chunks and 34 tasks. They inventory the original command target spans; this rerun does not claim
that the residual refresh evidence was initially supplied to any reviewer. The receipts retain
resolved configuration identities, including environment effects. There are zero judge calls and
no observed retrieval; task counts are not benchmark results.

Validation for this documentation delivery consists of the real-source controls, both native census
runs, receipt/hash and population reconciliation, source/family identity checks, JSON parsing,
privacy inspection and whitespace checks. No implementation source changed, so the full product
test suite is not required for this delivery. Ship's gates are reported separately in the PR.

## Research and next work

[SWE-Review v1, Appendix B.2](https://arxiv.org/html/2607.06065v1#A2.SS2) reports inadequate and faulty
reproducers; its root-cause analysis itself uses an LLM judge. [MalPR-Bench v1](https://arxiv.org/html/2608.25730v1)
separates target identification from a blocking verdict and uses complete-fix controls.
[MCR-Bench v1](https://arxiv.org/html/2608.27442v1) follows consistency filtering with independent
human checks. These support methodological caution, not this family's truth or a claim that
history improves Sol. Broader prior art remains unverified: reference checkouts and the deep-research
service were unavailable. The source and executable observations establish this rejection.

The next acquisition should seek another coherent, source-anchored independent family with a repair
that survives its own residual audit. A new attempt to repair this family must explicitly resolve
or exclude its remaining blockers and retain the same exposed-family identity. This result does
not add state/retry, race/lifetime or parsing family coverage, supply a holdout, or unblock sc-2832's
measured history comparison. Adapter work can proceed independently; measurement needs qualified,
frozen cases first.

The [sc-2851 input adapter](review-history-adapter.md) implements deterministic chronology and
per-task history preparation while these qualification prerequisites remain open.
