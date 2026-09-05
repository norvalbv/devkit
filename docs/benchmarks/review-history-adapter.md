# Deterministic review-history inputs (sc-2851)

[History-experiment decision](../decisions/reviewer-history-experiments.md) records the rationale, alternatives and limits of this preparation.

This is the input-preparation step of sc-2832, not an executed model comparison. It builds benchmark
packets for current-only review and review with the same arm's earlier findings. Synthetic tests
validate isolation and native evidence parity. They are not new gold cases, and no production
reviewer, cache, prompt or accepted score changes.

[sc-2843 rejected the first large repair as clean](source-family-qualification-2026-09-05.md).
Qualified timelines and a measured execution adapter remain prerequisites for sc-2832.

## API and inputs

Implementation lives in `gate-engine/review/eval/reviewers/scale/history/`:

- `parseTimeline(value)` validates a strict manifest with one to eight families, each containing
  exactly five rounds: initial, unchanged resubmission, partial repair, valid repair and reopening.
  These names are evaluator metadata; parsing does not establish that the code has those properties.
- `prepareRound({ manifest, familyId, arm, round, snapshots, records })` returns one packet per
  native task in the requested round. `arm` is `current` or `history`; `round` is zero-based.
  Supply snapshots only for rounds zero through the requested round, and records only for earlier
  rounds of that arm/family. Future snapshots and future/foreign records are refused.

A manifest declares `runId`, `executionSha256`, `nativeArm: "cap400"`, `historyCapBytes`,
`historyPolicy: "newest-contiguous-whole-rounds"`, and `families`. Each family declares its ID,
branch hash, incident hashes, case IDs, exposure and five rounds. Declared incident/case aliases
cannot occur in multiple families, even with different exposure. Undeclared links to other corpora
still need the existing family/admission audit; this adapter cannot discover them.

Each round pins the original base, post-image Git tree, full diff and author-text hashes. It also
pins its native task roster: key, lenses, files, scoped diff hash and scoped inventory hash.
All rounds share the base. The unchanged round must have the initial round's diff and tree.
A reopened round may reuse the original source bytes, while retaining a different round identity.

Freeze rosters with the existing `planFixture`/`planReviewWork`, and record each task's actual
selected-file `git diff --stat` inventory from the same frozen Git view. A snapshot supplies
`baseSha`, `postTreeSha`, `diffText`, `authorText` and `inventories` keyed by native task key.
The adapter checks these against the manifest and derives each scoped diff with native
`chunkDiffText`; a local task never receives the entire current PR merely because history is on.
It passes that scoped diff and pinned inventory to native `buildCappedDiffEvidence`.

```ts
const packets = prepareRound({
  manifest,
  familyId: 'family-001',
  arm: 'history',
  round: 2,
  snapshots: frozenSnapshots.slice(0, 3),
  records: ownCompletedRoundsZeroAndOne,
});
// No reviewer is launched here. Each packet has its own key, identity and exact input.
```

Each record wraps native checkpoint fields:

```ts
{
  runId, familyId, branchSha256, arm, round,
  row: { key, identity, diff, base, arm: 'cap400', status, scope, capture }
}
```

The wrapper identifies the experimental arm; the inner arm preserves the existing native cap arm.
Use the packet's scoped `key` and `identity`, not the original native key or a previous round's key.
Other native row metadata may be present, but is not copied into reviewer history. The normalized
history contains exact checklist issue strings and reported statuses, rather than the capped
checkpoint `reason`, evaluator judgments, waiver rationale or complete raw conversation.

## Capture and chronology checks

All expected tasks of every preceding round must have exactly one terminal record with matching
source, scope and input identity. Exact checklist capture is required, including one completed item
per expected lens. Missing artifacts, capped fallbacks, skipped/pending items, unknown lenses,
missing findings on a failed item, and unexplained aggregate verdicts refuse preparation. A valid
zero-finding PASS has actual passing lens items with empty issue arrays. A waiver may explain a
passing aggregate with a reported failing item; the historical finding is still retained as opinion.

Preparation walks earlier rounds in order, reconstructs their task packets from their own preceding
captures, and compares each record's identity. Changing an earlier output therefore invalidates a
later captured input that depended on it. Records may arrive in arbitrary array order; rendering
uses frozen task order and captured item indices. Nothing is selected by whether the result is good.

Both arms require completed prior rounds. Only the history arm receives the earlier findings. Each
arm/family/run/branch/round has distinct keys, including unchanged resubmissions and reopened code.
Identities bind the manifest, execution condition, exact task input and preceding normalized output
chain. Even an omitted prior output is retained in that chain, preserving the omission audit across
resume. This is conservative trajectory identity, not permission to reuse production cache entries.

Hashes establish consistency of supplied data, **not authenticity of an execution, truth of a
finding, completeness of a caller-declared roster, or validity of a clean label**. The later runner
must read its own native checkpoints and frozen Git evidence. Constructing matching hashes around
invented findings does not qualify them as measured history.

## Budgets and visible evidence

The adapter preserves each task's native capped current evidence byte-for-byte as the input prefix.
The native untrusted author-message renderer supplies the same author block to both arms. History
is appended only after that common current input. Its JSON strings escape structural angle brackets
and newlines; the surrounding instruction identifies old reviews as untrusted opinions. This
framing is not a guarantee against semantic prompt injection.

The manifest freezes a history cap between 512 and 65,536 **UTF-8 bytes**. The selection rule starts
with the newest completed round, adds whole rounds while the complete rendered block fits, and
stops at the first that does not fit. Kept rounds are emitted chronologically. It never splits a
finding or skips an oversized newer round to cherry-pick older ones. The cap includes framing and
the omitted-round count; detailed omitted task IDs and output hashes remain in packet metadata.

An oversized newest round yields **zero retained historical rounds**, with an explicit omission
marker. Do not describe such a task as having received prior findings. Round zero has no history
block. The current-only arm's history block is always empty.

Packets retain current/history/input byte counts and hashes, included/omitted round and task IDs,
output hashes and `currentDisplacedBytes: 0`. Existing native current-diff truncation remains visible
in its original renderer markers; zero displacement means this adapter removed none of that input.
It does not mean the entire PR was supplied. History uses additional bytes, not a matched total
budget or token-cost saving. Actual calls, tokens and elapsed time remain unmeasured.

## Validation and continuation

The deterministic suite includes five rounds in both arms, unchanged/reopened source identities,
missing/duplicate/foreign/future captures, source and author mismatches, exact zero-finding passes,
changed prior outputs, Unicode caps, whole-round omission and structural text escaping. Its real
Git integration fixture drives the native planner: three chunks and ten tasks per round, five
rounds, no judges. Local scoped diffs and inventories are compared against actual Git output and
native rendering; the contracts task retains the whole selected diff. This synthetic fixture has
no benchmark label or admission.

```sh
bun run test:run gate-engine/review/eval/reviewers/scale/history
node node_modules/@typescript/native/bin/tsc \
  -p gate-engine/review/eval/reviewers/scale/history/tsconfig.json --noEmit
bun run benchmarks:typecheck
bun run benchmarks:check
```

To continue sc-2832:

1. Acquire source-qualified five-round families, freeze their labels/hidden controls and transitive
   exposure before inspecting treatment outputs. This adapter's role names do not validate them.
2. Build the smallest native execution integration. Use existing `runCascade`/`runLensWave` capture
   machinery; do not launch a second judge. Verify per-task staged evidence against the packet,
   pass its exact input at the native execution boundary, and persist packet/capture identities.
   Keep the common author context once; do not duplicate it in both prompt extras and stdin.
3. Bind `executionSha256` to the actual model, effort, assets, native planner/renderer/adapter closure,
   configuration and registered retry/budget policy. Isolate arm/family contexts, checklist paths
   and caches. Do not accept legacy identity-less checkpoints through native permissive reuse.
4. Freeze the history cap, task census, repeats, arm order, elapsed/token limits and complete smoke
   cohort before any model call. Report zero-history tasks and added cost separately. A new matched
   total-budget comparison would be a different registered condition.
5. Execute rounds sequentially within each arm/family and retain every planned outcome. Only then
   adjudicate repeated-invalid burden, surviving/reopened detection and valid-repair acceptance.
   Publish through the existing tracker under a separate experiment identity. No result from this
   preparatory delivery licenses production history or automatic waivers.

[MCR-Bench v1](https://arxiv.org/html/2608.27442v1) motivates temporal states and partial-repair
checks, but uses accumulated real discussion rather than this same-arm generated-history
intervention. Its [official README](https://github.com/DeepSoftwareAnalytics/MCR-bench/blob/main/README.md)
describes a 400-line filter, so it does not validate devkit's large-diff regime.
[SWE-Review v1, Appendix B.2](https://arxiv.org/html/2607.06065v1#A2.SS2) cautions that reproducers
can encode incorrect assumptions. Neither paper establishes that history improves Sol. Broader
prior art remains unverified because no reference checkouts or deep-research service were available.
