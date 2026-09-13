# Source qualification: a repair that accidentally prevents retry

[sc3144](https://app.shortcut.com/benordlabs/story/3144) produces one source-qualified Vue bug/repair proposal pair, backed by actual upstream execution and twelve small adaptation controls. Neither row has been appended to the live corpus. No candidate benchmark ran and no agent improvement is claimed. The preceding native runner shipped in PR608/sc3124; this investigation supplies better candidate data for that runner.

## The bug in frontend terms

An async component definition caches its loading promise. Every mount gets a new component instance, but those instances reuse the definition and its cache.

1. Mount a component and start loading it.
2. Unmount it before loading finishes.
3. Loading rejects. A proposed fix returns early to avoid notifying the unmounted instance.
4. Mount the same component again. That early return also skipped clearing the shared failed promise, so the new instance cannot start a fresh request.

The final repair clears the shared cache before returning. This is the actual intermediate regression in [Vue PR14911](https://github.com/vuejs/core/pull/14911), not an invented bug made by reversing the final patch. The original code could retry, although it had a separate pre-existing after-unmount error notification.

## What was executed

The final upstream test file was held constant against each Vue source revision and its original configuration. A separate recovery test checks retry and rendered output without replacing or weakening the upstream notification tests.

| Evidence | Original source | Intermediate bug | Final repair |
| --- | --- | --- | --- |
| Vue upstream tests (25) | 22 pass, 3 fail | 24 pass, 1 fail | 25 pass |
| Separate Vue retry/render invariant | Pass | Fails: one request, no component | Pass |
| Adapted retry/render invariant | Pass | Reproduces the same failure | Pass |
| Adapted active-error, shared-success and shared-failure controls | All pass | All pass | All pass |

The actual PR parent is `86ad0764fd9f7b01cef75b4fc941b03419306bf8`; the buggy first revision is `767d3920905ef15cffe654ed0e9fe352394d5a0e`; the merged repair is `5300ead57b3c14942d4c155ef5e485d5409e7f02`. An earlier run used merge parent `7f76378b0d178a29113ee07d67faa48b637944e8`, whose `apiAsyncComponent.ts` blob is identical to the actual PR parent's. The final original-parent run executed all 26 tests: 23 passed, 3 failed. Those failures remain in the evidence; this is not a claim that the original code passed the whole final suite.

Separately, [TanStack/query PR11172](https://github.com/TanStack/query/pull/11172) supplies real resubscription controls. Its fixed upstream suite passes 16/16. Replacing only `mutationObserver.ts` with exact parent production bytes, while retaining the fixed tests/configuration, gives 14 passes and 2 failures: resubscription during a mutation and after completion both retain stale state. This is a source-overlay experiment, not execution of the complete historical parent checkout. React `useMutation` caller source was inspected; React Activity integration was not executed. No formerly passing pre-introduction base or adapted repair pair is established there yet.

These are narrow invariants, not full-PR cleanliness or independent precision estimates. Vue's intermediate commit is Cursor co-authored; TanStack's [issue](https://github.com/TanStack/query/issues/11171) credits Fable 5 discovery and reporter verification. Public acceptance, agent agreement and test success are evidence with limits, not automatic truth.

## How source becomes the small pair

[vue-proposals.json](vue-proposals.json) contains two native-shaped proposals with the same `repo.base`, unchanged caller and family ID. Both staged diffs are nonempty against the actual common baseline. Their postimages differ only in resetting the rejected shared request before the per-instance early return.

| Actual source responsibility | Adapted fixture |
| --- | --- |
| Definition-wide `pendingRequest` and resolved component | Definition-wide cache in `defineAsyncView` |
| New Vue instance for each mount of a reused definition | Explicit `mountView` lifetime driver |
| Per-instance reactive loaded flag and rendering | Per-instance flag and `read()` output |
| `onError` clears the cache before reporting an error | Same reset/report ordering |
| Early return for an unmounted instance | Same guard in both staged proposals; repaired catch also resets cache |

The host is an **adaptation**, not recovered application source. Original Vue runtime tests establish the actual ownership contract. The small fixture omits Suspense/SSR, timeout/delay UI, custom loader retry, full reactivity/rendering and invalid component values. Its proposed PASS concerns introduced defects in this scoped diff, not every possible Vue behavior. Active and shared-instance controls check that the repair preserves useful behavior; the source-conformance review found no blocking mismatch, but used the same model family and is not independent confirmation.

Only `repo.base` and `repo.staged` belong in reviewer-visible fixtures. Controls, qualification metadata, verdicts and these explanations stay outside. [controls.mjs](controls.mjs) uses the existing native materializer and launches ordinary Node code, with no reviewer or scorer calls. The source is MIT licensed; attribution is retained in [VUE-LICENSE.txt](VUE-LICENSE.txt).

## Checks, exposure and admission

Both proposals pass native structural/fixture/privacy/near-twin checks. Batch checks confirm their family linkage and find no unrelated twins. The native census reports four lens tasks per row and `chunkCount: 0`: these tiny diffs use the unsplit lens path, not a chunked large-PR path. They do not measure 2,000-line review performance.

| Stage | Result |
| --- | --- |
| Telemetry candidates mined | 2,078 total; 1,422 correctness |
| Mechanism text filter | 28 correctness matches across 14 branches; a queue, not verified bugs |
| Public source families executed | 2 |
| Adapted families qualified | 1 |
| Proposal rows validated | 2 |
| Live corpus rows admitted | 0 |
| Conditional-write families qualified | 0 |
| Confirmation families ready | 0 |
| Model benchmark calls | 0 |

Vue was selected for development and TanStack reserved for later confirmation before candidate outputs. Both sources were inspected for qualification: neither is unseen source. The initial selection's “no passing base established” limitation is superseded **only for the newly discovered Vue intermediate regression**, in a separate discovery receipt. The original selection remains preserved.

Admission is separate from qualification. Native `assignHoldout` would mark both members of this first new gold family `true`, despite the proposals' `false` values. That storage flag cannot erase development exposure. Also, the current PR605 comparison loader intentionally pins the full old corpus. We have not appended rows, changed its pin, or silently changed its protocol. A new reviewed registration must handle the new family explicitly and preserve the historical experiment.

The historical composer family still lacks verified full original caller/editor/dispatch context. Two additional archived checkpoint and question leads supplied failed/next diff evidence, but not enough caller/storage/observation evidence for labels. They remain deferred. No intentionally ignored conditional-write result family qualified; recover its missing contracts or find another incident. Passing authored probes cannot fill that hole.

## Reproduce and inspect

From the devkit repository root, with Node 24 and installed devkit dependencies:

```sh
node docs/benchmarks/experiments/2026-09-13-source-qualification/controls.mjs
```

This executes twelve observations across base, bug and repair, verifies the sole postimage difference and prints actual results. It does not invoke a model or append corpus rows. To check admission, extract each JSON array member into its own temporary proposal file and use `node gate-engine/review/eval/reviewers/finalize.mts --check <file>`. Batch twin/family checks and the exact census are recorded in [qualification.json](qualification.json).

To reproduce upstream Vue execution in disposable source checkouts, use the three commits above. Install each checkout's frozen dependencies with `pnpm install --frozen-lockfile --ignore-scripts`. Copy the unchanged final `packages/runtime-core/__tests__/apiAsyncComponent.spec.ts` into each checkout and copy [vue-recovery.spec.ts.txt](vue-recovery.spec.ts.txt) to `packages/runtime-core/__tests__/sc3144-recovery.spec.ts`. Run the repository command:

```sh
pnpm test packages/runtime-core/__tests__/apiAsyncComponent.spec.ts packages/runtime-core/__tests__/sc3144-recovery.spec.ts --run
```

The original and intermediate suites should fail for the reasons above. The control excerpt is intended to run inside Vue, not as a standalone devkit test. For TanStack, checkout the repair, install with `pnpm --filter '@tanstack/query-core...' install --frozen-lockfile --ignore-scripts`, then run `pnpm --filter @tanstack/query-core test:lib src/__tests__/mutationObserver.test.tsx --run`. Repeat with only the parent `mutationObserver.ts` production overlay, retaining the fixed tests/config.

Actual runtime: Node 24.19.0; pnpm 11.19.0 (different from the repositories' declared 11.3.0 / 11.9.0); Vue Vitest 4.1.7 and TanStack Vitest 4.1.2. Lockfiles and source configs were retained. Initial shared dependency symlinks caused two setup refusals; their logs remain separate from the successful configured regression runs.

The sanitized [qualification receipt](qualification.json) contains source identities, results, exclusions, exposure, native census and private log hashes. Full source/config manifests, original outputs and selection receipts are retained under `~/.devkit/research/sc3144-source-qualification-20260913`. If that store is unavailable, reproduce from the public revisions; a hash alone does not recover evidence. [artifacts.json](artifacts.json) pins the public inputs and receipts.

## Next decision and research

[comparison-plan.json](comparison-plan.json) prepares a separate, blocked development comparison: does explicit caller delivery or reachability/lens guidance help diagnose this lost retry while accepting its repair? Its finite ceiling is 16 row executions / 64 planned lens tasks. It is not accepted by the current runner and must not be executed as the old PR605 protocol. Before development execution, finish and freeze the separate confirmation pair, audit repair claims, and review the new native registration/admission path. No production promotion follows from one development family.

[SWE-Review v1](https://arxiv.org/abs/2607.06065v1) motivates checking whether reproducer tests actually establish the disputed claim. [CR-Bench v1](https://arxiv.org/abs/2603.11078v1) motivates retaining useful detections and noise separately. [Multi-SWE-bench](https://arxiv.org/abs/2504.02605v1) and [SWE-bench Multimodal](https://arxiv.org/abs/2410.03859) informed source/environment fidelity and the limits of reducing UI behavior. These methodological references do not certify these labels or predict gains over CodeRabbit/Macroscope. The broader prior-art review remains `INSUFFICIENT_EVIDENCE / followed / unverified`; the concrete source executions are the new evidence.
