# Feature Critique: Mongoose operations and ESLint export-declaration pair

**Verdict**: PROCEED WITH CHANGES — eight Mongoose corrections and both ESLint rows qualify; two Mongoose repairs are excluded.
**Date**: 2026-09-13
**Proposal**: Source-backed standalone corrective PASS operations for Mongoose, plus one genuine ESLint introducing-bug / observed-repair pair.

## Executive Summary

**Eligible Mongoose cases: 5 (corrected ports), 6, 8, 10, 11, 21, 26, 28. Exclude 20 and 27. The ESLint export-declaration pair is eligible.** Mongoose20 changes a reused explicit JSON option object's meaning on the second call; Mongoose27 crashes under reentrant save/remove delivery. Mongoose5 initially omitted reached dependencies from the extracted operation; the parent corrected those ports and the corrected fixture now matches actual native callers.

Ran **116 independent Mongoose observations over 29 scenarios** and **96 independent ESLint observations over 16 scenarios**, all in owned copies using the real historical libraries. Three Mongoose scenarios deliberately investigated reserved schema ancestors and fail during construction in every version; they are rejected probes, not introduced defects or passing repair controls. Source/adaptation outcomes match across 58 Mongoose and 48 ESLint comparisons. The initial Mongoose run, including the omitted-port failure, remains separate. No paid model calls, reviewer outputs, database connections, raw proposals, native admission or production files were touched.

## Feasibility Assessment

- **Status:** Confirmed Feasible for the qualified subset.
- **Evidence:** [source-identities.json](source-identities.json), [independent-results.json](independent-results.json), [source/adaptation parity](source-adaptation-observation-parity.json), [ESLint observations](export-independent-results.json), and the full private source trees.
- **Blockers:** The two row-specific upstream repaired regressions below. Qualification remains possible within the existing approach by preserving those exclusions.

## Alignment (Decision log)

Read the current owned-worktree guard.config.json at the start. Source/backend trees are cli and gate-engine, frontend roots are empty, and the W-3 trust model is a portable consumer-relative CLI/gate engine. This private source qualification does not alter those roots or boundaries.

The decision log exists. Queried source qualification, corrective PASS and family grouping, loading benchmarks-grow-from-telemetry, corpus-rows-admitted-by-coverage-cell and reviewer-claim-measurement. The September13 note allows standalone corrective PASS rows whose base is the actual buggy fix parent, with no variantOf or invented gold and no matched-pair denominator membership. The existing Target also states: “A passing targeted control establishes that invariant, not absence of all other introduced defects.” The two exclusions enforce that constraint.

Atomic alignment: original upstream pinning **implements** the source-root requirement; explicitly ported complete methods **implement** executable source adaptation; eight standalone clean labels **implement** the corrective-PASS note; calling20/27 clean despite the reproduced failures would **contradict** whole-change qualification; the ESLint parent/introducing/repair trio **implements** the genuine invariant rule; conservative shared-context families **implement** partition integrity. No architectural reversal is proposed.

Ran native `check-alignment scan`, which mapped the parent's in-progress corpus/comparison paths to scoped Targets. This is deterministic scope discovery, not semantic approval. No paid alignment judge ran.

## Results by Candidate

| Case | Result | Concrete assessment |
|---|---|---|
| Mongoose5 document-array _cast | Eligible using 5-effective only | Corrected ObjectId/utils ports cover plain-object and identifier pushes; created subdocuments adopt their actual owner and retain identity. |
| Mongoose6 SchemaArray constructor | Eligible | Full constructor retains dependencies/prototype setup through native injection; reused definitions preserve type/options, numeric/default and mixed arrays retain behavior. |
| Mongoose8 Document.update | Eligible | Actual Query, receiver/filter/argument propagation, false/zero/null returns and exceptions retain the caller contract. |
| Mongoose10 document-array toObject | Eligible | Actual child transform receives options for every member; null/empty arrays and default conversion remain covered. |
| Mongoose11 Query._applyPaths | Eligible | Explicit slice, explicit exclusion, forced inclusion and repeated application retain field values. |
| Mongoose20 Document.toJSON | Exclude | Reused explicit options are mistaken for inherited recursive options and lose the caller's override. |
| Mongoose21 Document.$__buildDoc | Eligible | Native parent/child projection controls retain included defaults and suppress only excluded branches. Reserved-name probes are rejected by schema construction before this method, in every stage. |
| Mongoose26 SchemaString.enum | Eligible | Local errorMessage prevents ambient global writes while custom/default validators and disable behavior remain functional. Sloppy original semantics retained in the base. |
| Mongoose27 EmbeddedDocument.remove + helper | Exclude | Reentrant parent events call an already snapshotted listener after its captured owner has been nulled. |
| Mongoose28 document-array notify | Eligible | Direct and nested save listeners receive their actual child document; custom-event payloads remain unchanged. |
| ESLint exported-declaration traversal | Both rows eligible | Actual introducing change crashes on nullable export declarations; parent and later repaired rule correctly report ordering violations and repair retains exported-variable support. |

## Critical Issues (Blockers for Those Rows)

1. **Mongoose20: repeated direct calls discard explicit JSON options.**

   The repair's complete `toJSON(options)` operation uses `options.json` to identify options inherited from a parent, but the same method sets `options.json = true` on the caller's object. With schema toJSON getters enabled and an explicit shared `{ getters: false }`, the first direct call omits the getter in both versions. The second direct call still omits it in the original base; the repaired source replaces the explicit options with schema defaults and includes `greeting: 'Hello Ada'`. The extracted operation reproduces this exactly.

   This is an introduced public caller-state regression, not a speculative options shape: the method itself creates the marker. Child-schema JSON options are the genuine repaired target and are still covered separately. Evidence:20/base-independent.json,20/repair-independent.json and their adapted counterparts, scenario `reused explicit options keep override each call`. Exclude the original repaired operation as PASS; retain its source and failed control rather than imposing single-use options.

2. **Mongoose27: event reentrancy invokes the cleared removal closure.**

   The added `registerRemoveListener` registers one callback on both owner `save` and `remove`. Its first invocation removes both registrations, emits the child removal, then nulls owner/sub/emitRemove. EventEmitter emission snapshots listeners. If an earlier parent save listener synchronously emits remove, the new callback runs during that nested event and clears its captures; the outer save emission then reaches the callback already present in its snapshot and throws `TypeError: Cannot read properties of null (reading 'removeListener')`.

   This runs on actual Mongoose documents through their event API: register the earlier save listener, call the actual child.remove(), then emit save. Original base does not throw, while original repair and adaptation both throw. The original base emits no child remove because the target feature does not yet exist; no passing-base gold is claimed here. Ordinary save/remove delivery, repeated child.remove calls and callback chaining were also checked. Evidence:27/*-independent.json, scenario `earlier parent listener reenters alternate event safely`. The controls simulate lifecycle events and claim no database persistence. Exclude the repaired operation as currently proposed.

## Resolved Adaptation Defect: Mongoose5

The original factory declared receiver-only ports but the complete `_cast` body references ObjectId and utils in its fallback. The target create→push control only traversed the existing-instance branch. Native push of a plain object or ObjectId passed original source and threw `ReferenceError: ObjectId is not defined` in the adaptation.

The parent added actual ObjectId and utils ports and injected those original module bindings. Corrected source/factories are independently copied under [5-effective](5-effective); native plain-object push, ObjectId push and create→push now reproduce source/adaptation behavior in both stages, with repaired behavior passing. The unchanged source operation AST remains exact. Original defective snapshots remain under5 and [initial-independent-results.json](initial-independent-results.json). Qualification applies only to5-effective; do not cite the original factory as qualified.

## Warnings

1. **Shared original contexts constrain family partitioning.** At minimum group5/10/28 together (lib/types/documentarray.js) and8/20/21 together (lib/document.js), including excluded members if they later receive related source-backed variants. Distinct method names do not establish independence; document-array conversion and child-event behavior also share actual document callers. For the admitted subset this yields at most five conservative Mongoose source groups: documentarray{5,10,28}, document{8,21}, schemaarray{6}, query{11}, schemastring{26}. The ESLint gold/repair is one family, joined with any future candidate rooted in the same vars-on-top introducing/fix context. Native near-twin and prior-family checks still apply. Shared Mongoose/ESLint infrastructure remains broader domain correlation even across those groups.

2. **Preserve the exact port, test and measurement disclosure.** A complete method/factory with explicit real-library and receiver ports is an honest selected operation; it is not the entire original module, installed Mongoose program or database operation. Keep the retained original callers and private source identities linked, preserve neutral API contracts, and do not describe qualification as universal cleanliness or independent human ground truth. Node24 executes historical source against locked installed runtimes, not the original historical Node release. These sources are exposed; partitioning reviewer-output inspection cannot make them source-unseen. Standalone Mongoose rows stay outside pair-discrimination denominators.

## Source and Adaptation Evidence

All20 Mongoose base/repair source snapshots match their pinned BugsJS rule blobs. Nineteen also match the original upstream file byte-for-byte. Mongoose20 repaired dataset source differs from upstream only by one blank line inside toJSON; the complete operation AST is identical. All20 complete operation ASTs match actual original upstream parent/fix operations, and their normalized fixtures preserve the whole operation plus reached local helpers. Mongoose5 identity records use the corrected ports. The explicit SchemaArray utils port resolves the source-added binding honestly without implying it existed in the original base module. CommonJS factories preserve the original sloppy enum baseline; no generated strict directive changes its global-write behavior.

For ESLint, the actual parent e54598abcf97573bddb40238c535cd8f0e3ffdd5 is the immediate parent of introducing ce2accda65f45aaa2f532a3a4e931a35d42d3e42. Later repair d4f55268edb762d77bcde4ce7b3c71868ed08a1a is a verified descendant. All three full module files are byte-identical to those upstream refs and match their adapted ASTs. Both selected diffs are nonempty. The entire later module, including intervening metadata/API form, is retained and exercised on the actual historical ESLint core.

The independent ESLint controls cover empty export lists, aliases and re-exports (parent returns an ordering diagnostic; introduced source throws; repair returns the diagnostic), function/class/default exports, exported var/let, imports/directives, function bodies, lexical blocks and for-loop declarations. Exported-variable support remains active; it is not removed to repair the crash. All16 repaired scenarios pass and48 source/adaptation comparisons agree. Parent-provided later regression evidence separately retains50 tests per stage (repair50pass, bug2fail, parent3fail from absent new behavior); this critic did not independently rerun that entire published suite and does not relabel those parent target failures as failure of the preserved crash invariant.

## Data Flow and Configuration Matrix

| Surface | Data flow / result |
|---|---|
| Mongoose plain objects, ids and existing children | Actual model/array caller → native _cast or corrected operation → original caster/owner state; no invented object substitute. |
| Schema/caster creation | Actual SchemaArray constructor factory receives original library bindings; original prototype setup remains in its native module. |
| Query and document operations | Actual receiver fields and constructor methods supply the selected operation; no database execution or stored result is claimed. |
| Document conversion | Real child schemas, toObject/toJSON and explicit options exercise recursive caller behavior;20 is excluded for caller-option reuse. |
| Lifecycle events | Actual document EventEmitter delivery exercises ordinary and synchronous reentrant events;27 is excluded for the latter. |
| ESLint script/module scopes | Actual parser and traversal supply ancestors/tokens/context; complete original/adapted visitor modules report through the real API. |
| Consumer cwd / monorepo / absent guard config | No production path resolution or consumer configuration is changed; this private qualification does not invent a layout matrix for unrelated software. |
| Asynchronous database callbacks | Not claimed or tested; selected update-return and event-propagation controls operate without persistence. |

## Rejected Probes and Limits

Mongoose21 probes with nested hasOwnProperty/toString/valueOf ancestors are rejected by the actual schema constructor in both base and repair. They never exercise the selected default builder and cannot support a repair finding. Mongoose6 initially expected array-element uppercase setters to execute on initial construction; a separate fresh-schema control proves both original versions retain the same lowercase input despite having the uppercase option/setter installed. This pre-existing dispatch behavior is recorded in [preexisting-probe-controls.json](preexisting-probe-controls.json). The revised ownership test directly checks definition preservation, installed caster option and primitive casting rather than asserting an unrelated change.

The bounded controls and complete-method inspection do not prove every library feature is bug-free. Pre-existing unrelated behavior does not by itself invalidate an introduced-change PASS label. Source equivalence assertions do not imply hypothetical framework ports are arbitrary: only the actual retained API contracts and native caller executions are claimed.

## Frame Second Opinion

The strongest objection is that extracting methods makes false cleanliness easy: hidden module dependencies or parent state could be erased, so perhaps these rows should require complete library fixtures. Mongoose5 demonstrates the real risk, but it supports dependency/caller closure, not mandatory inclusion of every unrelated module. Its omitted dependencies were repaired with actual ports and verified through native callers; all selected operations now preserve full ASTs and source dependency identities. Conversely, the two upstream failures survive complete native source execution, so their target fixes cannot justify clean labels. The goal and layer remain sound; neither manufactured input restrictions nor a new benchmark framework is needed. **FRAME_META: SOUND.**

**UX / DX impact:** none for the qualified subset. Keeping20/27 as PASS would penalize real correctness findings; the corrected5 fixture removes such an artificial failure before admission.

## Recommended Path Forward

1. Natively admit only Mongoose5-effective/6/8/10/11/21/26/28 and both ESLint export rows after existing source/privacy/twin/family checks.
2. Keep20/27 exclusions and5's initial adaptation correction chain unchanged. Any future derived repair or introducing-gold proposal needs its own source-backed qualification.
3. Freeze whole related contexts together, retain the standalone-vs-pair distinction and source exposure, and carry framework correlation into analysis.

## References and Replay

Primary source references and upstream identities are in [source-identities.json](source-identities.json). [qualification-results.json](qualification-results.json) is the compact result; [edge-cases.json](edge-cases.json) contains11 risks/45 scenarios, including the three explicitly rejected schema-setup probes. Replay the owned `run-independent.py`, `export-controls.cjs`, and `verify-identities.mjs` using the pinned Node24/runtime paths. These use private copied source trees only; the shared runtime symlinks are read-only. No web research was necessary for these locally reproduced claims.
