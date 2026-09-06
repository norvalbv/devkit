# V2 handoff: scored guardrails and separate unscored probes

This is preparation, not execution authorization. The user pause covers benchmarks, probes, controls, census, adjudication and optimization. Use the source revision and artifact hashes in [protocol.json](protocol.json), and record the v2 artifact revision. Its provisional budget is 48 scored row executions plus 56 unscored probe executions. Neither partition has run.

## Source-anchoring boundary

Only the eight existing source-backed rows may enter native corpus scoring. The seven authored entries in `draft-cases.json` have `probe` source maps, no expected verdict and explicit `scoring: forbidden-unanchored-probe`. A loader must reject them from `runRow`, `scoreRow`, corpus admission, benchmark reports, candidate ranking and optimizer objectives. Changing the filename or passing their illustrative checks does not make them admissible gold.

A scored direct-mechanism or context comparison remains blocked on independently anchored source cases. Follow [benchmarks-grow-from-telemetry](../../../decisions/benchmarks-grow-from-telemetry.md): recover observed source lineage or an eligible fix-anchored import, establish the actual caller/requirement, and derive/qualify repairs. Synthetic probes can suggest what to investigate, but cannot replace that work or resolve historical judgments.

## Checks after explicit permission

For the existing guardrails, execute their four named family-ID controls in `repair-controls.test.mts` and the additional `retry repair preserves` / `JSON repair preserves` tests. If assertions or labels fail, retain evidence and revise/re-hash the scored manifest before any model comparison; never silently exclude rows. Existing repair checks establish their named invariants, not global cleanliness.

For an exploratory probe, materialize `probe.repo.base` and, separately, base overlaid with staged source. Its family's control program emits a JSON observation. `anticipatedBase` and its `illustrationKey` describe the author's prediction, not scoring labels. The per-instance callback variant has its own base host. Retain actual observations, including disagreement. Agreement provides no gold provenance and cannot qualify the probe for scored execution.

Do not execute control strings while merely loading the JSON. The files declare ESM with `package.json`. Preserve native JS scheduling semantics and the explicit deferred-callback queue boundary; these probes do not model React, a full editor or production cancellation.

## Native adapter contract — not implemented

For scored guardrails, reuse `corpus/row.mts::runRow` with full `onTask` retention. For probes, reuse the underlying native fixture/assets, source selection, `planFixture`, task execution and `runCascade` capture seams **without calling `scoreRow` or creating dummy gold labels**. Keep scored and exploratory entrypoints and outputs separate, and fail closed on an input of the wrong kind. This interface distinction is required future implementation, not a ready adapter in this PR.

Materialize only source maps plus native gate assets. Do not place labels, control programs, anticipated outputs or probe identities into reviewer-visible files. Preserve staged bytes, native tools, four singleton lenses, model, issue cap, timeout and every attempt. `onTask` holds full captures before cleanup; final task metadata alone is insufficient. Retain native input/output, argv, model/capability identity, checklist snapshots, runtime, usage where available and errors. Missing usage is unavailable, not zero.

For C only, an `exec` delegate may append the exact packet to native `opts.input` before forwarding. Preserve original input separately. Refuse missing/non-string input, a non-probe roster entry, missing packet, changed-file packet, bad hash, missing source or truncation of required evidence. Do not fall back to B. Packet files are unchanged source available in all arms; ordinary source contract comments are allowed, probe/control annotations are not. Input and packet hashes belong in experimental identity because native hashes do not cover external injection.

Before execution, verify adapter parity: unmodified B forwards native calls; P/L alter only their independent assets; C alters only declared source delivery; both entrypoints retain all captures; any probe-to-scorer routing fails before model calls. No parity validation has run. Disable all native checkpoint salvage and external caches for fixed repeats, preserving native technical attempts rather than selecting successes.

## Proposed schedule and reporting

Scored phase: in each of the four pinned families, run both bug and repair under B/P/L in that order for round one, L/P/B for round two. That is eight source-backed rows per arm per round, 48 cells total. P and L are independent patches; L is a two-rule bundle and cannot identify individual rule effects.

Exploratory phase: separately, for each of the three probe families, run all variants under B/P/L/C in round one and C/L/P/B in round two. Keep the topology derivative with its family. That is seven probes per arm per round, 56 cells total. Preserve observations and source-read behavior qualitatively. **Do not calculate accuracy, precision/recall, target-hit rates, repair acceptance, candidate rankings or an optimization reward for these probes.** There is no scored C effect in this preparation.

Use the protocol's explicit environment values and verify resolved settings. `BENCH_CASCADE=off` is native; `CASCADE=0` is not. Source-pinned correctness ignores `BENCH_MODEL` as an override. Freeze chunk cap and singleton split before module initialization, clear unrelated ambient overrides and retain fixed effort/timeout/cap. Each arm/repetition uses fresh isolated state and an independent evidence namespace.

No manual quality/execution reruns are planned. Retain native technical attempts; interrupted runs remain incomplete and any recovery is separately declared. Do not use native `--against`/`--fail` (quality-selected discordant-row reruns), `--baseline` (shared result writes), or `--dev` (wrong selection for this exposed roster). The native CLI does not implement the mixed plan; these constraints are not executable instructions for a ready integration.

The scored report keeps all 48 planned cells and missing/capture failures visible. Judge target diagnosis independently of lens/regex proxy, retain valid extras and unresolved claims, and preserve all occurrences when grouping repeats. Per-lens unique valid findings, overlap and cost apply only to qualified scored evidence. Two repeats and correlated source families do not support independent-sample confidence claims. Probe observations never enter those denominators.

## Fifth lens and promotion

The [lens-hole ruling](../../../decisions/correctness-lens-hole-instrument.md) requires eligible, fully evidenced external misses, the recorded triage-agreement and cross-source majority/count criteria, and failure of a nearest-lens amendment before a fifth category. Neither this tiny guardrail set nor authored probes satisfy that test. Raw FAIL counts cannot establish lens value.

There is no untouched confirmation set or production promotion authority in this PR. To advance, obtain independently source-anchored direct cases, qualify their repairs, freeze family-separated confirmation and declare a cost/error tradeoff. A favorable guardrail result supports continued investigation only; an interesting probe response is not a benchmark win.
