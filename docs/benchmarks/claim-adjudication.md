# Adjudicating complete reviewer claims

The scale benchmark's location score measures whether a finding mentions a labelled location.
It does not establish that the finding is true, describes the labelled defect, or would justify
blocking a review. Historical `extras-adjudicate` and `verify-extras` outputs remain location
proxies; their old location-key judgments cannot label the exact-claim census.

The claim workflow preserves every recorded occurrence before location matching or semantic
grouping. It measures conditional precision on the selected replay inputs. A census of findings
from a historical FAIL-selected archive is not a representative sample of production reviews.

## Capture and execution

The opt-in private capture retains the terminal checklist's complete recorded strings, original
item and issue order, names, statuses and gate dispositions. Production event and sidecar budgets
remain unchanged. Producer disclosure limits still apply: this is not a transcript of intermediate
reasoning or every claim the model could have emitted.

Keep these dimensions separate:

| Dimension | Meaning |
|---|---|
| Execution | A terminal pass/fail, or an unresolved error/inconclusive attempt |
| Capture | Exact checklist, capped fallback, missing/invalid, or legacy unknown |
| Coverage | Which items in the planned lens mask were completed, pending or absent |

An exact finding from a FAIL with pending siblings remains adjudicable. A singleton mask owes
only its selected lens. A missing artifact or unattributed FAIL remains an unresolved task,
with an unknown number of missing claims; it is not a clean result. Waived and dropped findings
remain inspectable, with their dispositions, even when the final task passes. A pass item carrying
issues, or a passing task carrying an undispositioned failed item, retains its recorded text but
receives an invalid-capture error and no precision or parent-attribution credit.

Use a fresh empty output directory for a new measurement and freeze the runner and projected
assets first. Reuse checkpoints only within that measurement. Record the source commit,
configuration, planned task roster, base and index tree, archived and evaluated diff hashes,
and native artifact hashes. A patch that applies successfully does not prove that the checkout
reproduces the original reviewer's complete observation state. Report exact patch matches and
reconstructed inputs separately, with any unsupported context-dependent judgment unresolved.

The scale CLI accepts `--research-root` for isolated materialized contexts through the existing
materializer. Cached reuse verifies the repository and Git common directory, the pinned base
against HEAD, and the requested patch against the captured index and tracked working files.
Validation clears Git flags that could hide changed files only in private scratch indexes.
It accepts projected assets only when they match the intended current source; synchronization
replaces the three owned projections so stale or untracked extras cannot change execution identity.
It preserves both original indexes and rejects stale
contexts with a fresh-root remedy. Moving the source branch does not change the cached base pin.
The complete base marker publishes last, after the repository marker, so interrupted preparation
can recover without accepting an incomplete cache identity.

Raw checkpoint and results output must be below `~/.devkit/research` in a private directory.
Diff identifiers must be complete lowercase SHA-256 values before archive or output path construction.
Missing, unreadable and corrupt diff archives receive separate evidence error codes.
The writer rejects symlink ancestry and checkpoint symlinks and creates new evidence files with
owner-only permissions. `--clean` cannot be combined with a custom research root.
One output-bank owner holds the lock through checkpoint reads, asynchronous judging and final
results publication, independently of which context directory or diff the process uses.

## Private census and blinded review

From the repository root, using explicit private paths:

```bash
node gate-engine/review/eval/reviewers/scale/claim-cli.mts census \
  --namespace "$BANK" --out "$CENSUS" "$BANK"/results-*.json
node gate-engine/review/eval/reviewers/scale/claim-cli.mts report \
  --inventory "$CENSUS/inventory.json" --judgments "$JUDGMENTS" --out "$REPORT"
```

The census writes the private inventory, blinded phase-one packets, a judgment template, and a
separate private mapping. Bind every judgment to the complete occurrence identity and exact text
SHA-256. Separate attempts remain separate occurrences; exact copies of one occurrence count once.
A changed claim cannot inherit an old judgment. Claims without locations, with several locations,
or near an existing label remain in the census.

Choose a new census output directory for each snapshot. Publication refuses existing destinations
and symlinked ancestry, and publishes the complete private generation in one directory rename.
An interrupted build may leave a private pending directory; it cannot expose a partial final census.
Sanitized reports also publish atomically: identical-byte retries are accepted, while conflicting
content requires a new output path. A shared private `.pending` directory may remain beside a report.

First judge the complete claim against the evaluated code without model, arm, waiver, repetition
count, other judgments or label candidates. Identify a concrete failing input or interleaving,
trace counterparties, and record supporting or contradicting evidence. Judge factual truth,
introduced-versus-pre-existing scope and correctness-charter scope separately. Missing context
supports UNSURE; a disproven load-bearing premise supports NOT. A partly supported compound claim
may remain UNSURE rather than receiving credit for one plausible clause.

Then compare against known labels by causal mechanism and assign semantic duplicate groups.
Location proximity is only a candidate annotation. Historical label text may itself be capped;
insufficient meaning remains NOT_COMPARED or UNSURE. DISTINCT means distinct from the explicitly
compared label set, not that every possible defect has been labelled. Label-comparison provenance
and relation-specific evidence references make the judgment auditable; schema validation cannot
prove its truth. SAME_DEFECT and PARTIAL_OVERLAP require comparison evidence covering their named
labels. Capped-context relations remain recorded but cannot earn confirmed parent attribution;
that requires full defect evidence for the compared labels.

Keep the adjudicator's actual model and AI tier explicit. Multiple model opinions, confident prose,
a developer waiver or a nearby label do not establish human ground truth. Preserve each occurrence
after grouping: removing repeats would erase the burden being measured.

Only human judgments or known cross-family AI judgments can qualify reported precision and parent
attribution. Same-family and unknown-family judgments remain recorded, with their eligibility
counts, but contribute unresolved outcomes. Unverified or merely patch-applied context likewise
remains unresolved. This offline evidence never changes a production gate verdict.

## Report and interpretation

Report factual claim precision and valid introduced correctness-finding precision separately.
For captured occurrences with V established valid, I invalid and U unresolved, show resolved
precision V/(V+I), resolution coverage, and unresolved-inclusive bounds V/N to (V+U)/N, where
N=V+I+U. Missing-artifact task counts sit alongside those captured-census bounds. Correlated claims
and repeated chunks do not justify an independent-observation confidence interval.

Show recorded truth, change scope, charter scope and context basis as separate counts, including
unadjudicated claims. These record what adjudicators said; the precision metrics additionally apply
capture, context and independence eligibility.

Report each invalid occurrence, distinct invalid-alarm groups and repeats beyond the first.
These are emitted-claim counts; they do not measure observed developer attention or time.
An extra is a claim not accounted for by the compared labels; it may be a valid new defect.

A simulated parent reviewer result requires its stable replay ID and complete expected task roster.
Use the runtime's worst-status semantics, and separate known-only, extra-only, both and unresolved
block attribution. Removing extras from a mixed known/extra block does not clear it. Missing,
error, unattributed or unfinished in-scope siblings prevent an assertion that removing extras
would produce a pass. Pending items outside the active lens mask do not create an obligation.
This is reviewer-level simulation; other commit gates can still block the ship.

Raw inputs, labels, source paths and claim text stay in private research storage. Commit only
sanitized counts, hashes, lens names and anonymized identifiers under the scale-track data ruling.
The study informs measurement; it does not automatically change the configured model or gate policy.

The [reporting-family audit](reporting-family-audit-2026-09-05.md) applies this distinction to
PR598's static bug/repair cases. It preserves all 12 occurrences, demonstrates a credited lens
diagnosis that does not identify the target defect, and leaves unsupported repair contracts
unresolved. It is exposed offline evidence, not qualified claim precision.

The [5 September 2026 complete-claim replay](experiments/2026-09-05-sol-claims/README.md)
preserves the original blinded assessment separately from post-label comparison and semantic
grouping, including protocol failures, unresolved attribution and reconstruction limits.
