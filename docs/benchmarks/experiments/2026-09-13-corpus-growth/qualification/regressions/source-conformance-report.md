# Feature Critique: Population candidates and four ESLint regression pairs

**Verdict**: PROCEED WITH CHANGES  
**Date**: 2026-09-13  
**Proposal**: Qualify nine standalone Mongoose population PASS changes and four original-source ESLint bug/repair pairs.  
**FRAME_META**: SOUND  
**UX / DX impact**: none from the qualified subset; unclean siblings would punish correct reviewer findings.

## Executive Summary

Six Mongoose PASS candidates and all four ESLint bug rows qualify. Only padded-blocks has a qualified clean sibling; the other three later repairs retain or introduce concrete adjacent defects. Three Mongoose published repairs introduce separate regressions and are excluded as PASS, but their independently verified source behavior supports separately prepared standalone FAIL proposals. This yields **eleven eligible existing proposal rows**, plus evidence for three potential separately prepared FAIL rows; no admission or relabeling was performed.

Portable copy: original per-case paths below are logical evidence identifiers. The manifests and `expected/` files provide their public counterparts; see README.md for replay commands.

This is independent-agent source/behavior verification, not independent human ground truth. All source was exposed. No reviewer outputs or paid models were used; all writes are inside this private directory, including copied source trees, with the parent's preparations untouched.

## Feasibility Assessment

- **Status**: Confirmed Feasible through existing native admission, with these exclusions.
- **Identity**: All 13 introducing/fix parents and four later-repair ancestry paths verified from the original Git clones. All **32 full JavaScript endpoints** have equal source/adaptation executable ASTs. Thirty match upstream bytes exactly. Mongoose 18's repair differs by one comment capitalization, and Mongoose 24's by one blank line; both complete upstream ASTs are equal and exact upstream files are retained privately.
- **Controls**: **738 independent observations, 369 source/adaptation comparisons, zero mismatches**: 48 population scenarios × four stages = 192; 91 ESLint scenarios × six stages = 546. One additional native constructor-effect comparison proves that the reported constructor is behaviorally significant. Prepared evidence adds 132 population and 240 ESLint observations, without claiming a new independent full-suite replay.
- **Blockers**: Six clean-label exclusions below. No new dataset, broad source search, repair synthesis or evaluation framework is needed.

## Alignment (Decision log)

The consumer config names `cli` and `gate-engine`, with no client/server split and W-3 consumer-relative execution. Governing Targets and current notes for `corpus-rows-admitted-by-coverage-cell` and `benchmarks-grow-from-telemetry` were read, and copied into `contract-sources/`. The deterministic alignment scope scan completed (`alignment-scan.txt`); it is a scope report, not semantic approval.

Exact applicable rules:

> a FAIL row's defect must be introduced BY the diff and reachable from files in the fixture

> A passing targeted control establishes that invariant, not absence of all other introduced defects.

> Shared contexts remain one transitive holdout family.

Standalone corrective PASS rows use the actual buggy fix parent. The current source-regression note permits actual upstream fix-parent → published changed endpoint evidence with an independently established new failure, without claiming BugsJS supplied that new defect label or inventing a later repair or pair.

Atomic claims: exact source anchoring **implements** the Target; complete framework ports and source/adaptation controls **implement** executable reachability; common-base pair targets **implement** pass/fail/pass for the stated invariant, not whole-parent correctness; six proposed clean labels **contradict** observed introduced behavior and must be excluded; retaining related methods within transitive families **implements** the partition rule. No recorded architectural direction is reversed.

## Critical Issues (six clean-label blockers)

1. **Mongoose 18 compounds limits across repeated calls.** Reusing `{path:'ref', options:{limit:2}}` for two identical two-document operations produces query limits `[4,8]` after the change; base produces `[2,2]`. Three documents produce `[6,18]`, and a repeated Query reproduces `[4,8]`. The introduction mutates `options.options.limit *= len`, so the second call scales an already scaled value. This is a new repeat-stability defect, not a claim that base already implemented the feature's per-document scaling.
2. **Mongoose 23 creates an unrelated projection field.** `select:'-_identity'` becomes an actual outgoing inclusion projection `{entity:1}`; with `title -_identity`, it adds `entity:1` alongside title. The replacement regex removes the `_id` prefix without a token boundary. Parent's missing projection is a pre-existing issue, but parent does not invent the unrelated inclusion. The verified invariant is the native outgoing query contract; no server result/filter simulator supplies the claim.
3. **Mongoose 24 destroys populated-array state on lookup error.** Re-populating a modified array converts its live Document entries to IDs before the asynchronous query completes. On collection callback error, the changed source leaves IDs in place; parent retains the existing documents. Scalar references and successful repopulation show the affected branch. No broad atomicity guarantee is invented: the exact user-visible state survives base and is newly lost on the same error operation.
4. **ESLint camelcase clean sibling misses local default bindings.** Under `properties:'never'`, `const {camelCase: snake_case = 1} = obj;` is reported by parent but missed by both introduced and later repaired rules. Original docs exempt property names, not locally declared variables. The introduction routes AssignmentPattern through an unconditional property-policy early return; default alias, nested, array, computed and parameter forms reproduce the loss. The edge-underscore gold remains valid, but its later source endpoint is not clean.
5. **ESLint max-len clean sibling disregards numeric zero.** The later repair adds `||` defaults, treating configured max length 0 as 80 and tab width 0 as 4. Original docs define these numeric character limits, and the repair schema explicitly permits zero. Base enforces `var a;` with maximum 0; later repair emits no diagnostic. Tab width 0 adds a complementary false-positive example. This defect is additional to the repaired invalid-column target.
6. **ESLint no-useless-constructor clean sibling erases a rest-pattern default effect.** `constructor(...[a=effect()]) {super(...arguments);}` is not reported by parent, but introduction and later repair classify it as useless. A RestElement is treated as simple without inspecting its ArrayPattern default. Native JavaScript execution confirms that retaining the constructor calls the effect once and deleting it calls it zero times. The empty-super crash gold remains genuine; its later endpoint is target-specific evidence only.

Exclude those clean labels. All four intended ESLint introducing diffs remain eligible standalone bug rows; only padded-blocks retains a paired clean row. Do not represent the rejected later endpoints as paired success evidence.

## Warnings (non-blocking)

1. **Historical frameworks and external ports.** Mongoose uses real schema/model/document/query behavior with deterministic collection responses and no DB. Captured projections, limits and options are outgoing-contract evidence; no full MongoDB projection/sort/limit or upsert return-shape coverage is claimed. ESLint uses the pinned real historical parser/context/fixer consistently across the three source endpoints. Runtime lock and symlink identities are recorded. This is not current-version compatibility testing.
2. **Parent validity is invariant-specific.** The empty-super parent can overreport constructors, and the max-len parent can report a wrong line while supplying a valid position. The gold target claims only absence of the new crash or invalid position. Mongoose 23's original `_id`-prefix detection and discarded selection are pre-existing; its new malformed inclusion remains independently observable. Mongoose 4's initial same-query rerun hit an unchanged MissingSchemaError in both endpoints; initial logs are retained and not used as gold. Fresh queries reusing options correctly retain hydration.
3. **Correlated families and source exposure.** Mongoose 4/7/17 join `corr-source-query-projection-slice`; 2/13/14/18/23/24 join `corr-source-mongoose-document-context`. The complete model/document bridge in 13 requires union with the prior model/document contexts; method names do not establish independence. Each ESLint pair/gold stays in its existing rule family. All source is inspected, and the historical 13.9% noise bound remains applicable. No unseen-source or human-adjudicated-ground-truth claim is warranted.
4. **Native pair-statistics compatibility.** The parent identified that current family validation assumes every member of a multirow family participates in repair edges. Admission must preserve standalone family members in label totals/family clustering while excluding them from pair-discrimination denominators. Count explicit repair endpoints and valid legacy pairs; do not infer a new pair merely from same-family standalone PASS/FAIL labels. The parent owns the narrowly scoped native correction. This critique did not modify or review that implementation, and does not endorse an untested compatibility change.

## Candidate decisions

Counts are independent scenarios / observations. Full refs, proposal hashes, source hashes and per-stage outcomes are machine-readable in `qualification-evidence.json`.

| Mongoose | Decision | Mechanism | Actual parent → published change | Controls |
|---|---|---|---|---|
| 2 | PASS eligible | Population model fallback | d5d34382 → c671672a | 6 / 24 |
| 4 | PASS eligible | Lean propagation through query population | 129bc78d → c5527ba0 | 4 / 16 |
| 7 | PASS eligible | Atomic query population | 2f111f9f → b7688c2e | 7 / 28 |
| 13 | PASS eligible | Depopulation of references during save | 57e8bf6d → a48c4054 | 4 / 16 |
| 14 | PASS eligible | Missing population result positions | d305cd70 → 0ab96d16 | 4 / 16 |
| 17 | PASS eligible | Empty original document returned by upsert | a5e6a1f6 → 3b863e15 | 7 / 28 |
| 18 | Exclude PASS; FAIL evidence | Repeated population limit scaling | e6ed84b6 → 21e12866 | 5 / 20 |
| 23 | Exclude PASS; FAIL evidence | Population projection token preservation | 72eb91f5 → a830651e | 6 / 24 |
| 24 | Exclude PASS; FAIL evidence | Repopulation identifier cache and error state | e12edaa5 → 5fdf8155 | 5 / 20 |

| ESLint rule | Eligible rows | Parent → introduction → later source endpoint | Controls |
|---|---|---|---|
| camelcase | Gold only | d067ae1f → 256481b0 → d80aa7c8 | 20 / 120 |
| padded-blocks | Gold + clean | a9d4cb21 → 3c9ce093 → d02bd114 | 49 / 294 |
| max-len | Gold only | eb4e0fde → 8061f352 → 21538bb9 | 11 / 66 |
| no-useless-constructor | Gold only | bdf64007 → cf14c719 → aefc90c1 | 11 / 66 |

### Mongoose 2

Eligible: actual missing/ad-hoc/explicit reference model paths, empty inputs, explicit unknown-model error and retained declared reference controls. No new query issued for missing/null paths. Evidence: `mongoose/2/independent-{base,repair,base-adapted,repair-adapted}.json`. Source identity and exact proposal hash are in `qualification-evidence.json`.

### Mongoose 4

Eligible: actual find/findOne lean inheritance plus fresh queries reusing population options preserve later hydrated behavior. The initial repeated same-query probe exposed an unchanged model-registration error in both source endpoints and is not an introduced finding. Explicit parent lean propagation is the proposed feature, not a contract contradiction. Evidence: `mongoose/4/independent-{base,repair,base-adapted,repair-adapted}.json`. Source identity and exact proposal hash are in `qualification-evidence.json`.

### Mongoose 7

Eligible: both atomic methods retain null and driver errors, propagate population lookup errors through callback, and preserve non-populated hydration. Prepared success/lean controls cover new behavior. Evidence: `mongoose/7/independent-{base,repair,base-adapted,repair-adapted}.json`. Source identity and exact proposal hash are in `qualification-evidence.json`.

### Mongoose 13

Eligible: new saves depopulate scalar/array references while preserving top-level objects; independent modified-document delta, repeated ordinary toObject options and embedded-document save controls retain behavior. Complete model/document modules require shared family union. Evidence: `mongoose/13/independent-{base,repair,base-adapted,repair-adapted}.json`. Source identity and exact proposal hash are in `qualification-evidence.json`.

### Mongoose 14

Eligible: missing, null, empty input and plain-object result positions retain index alignment; no query narrowing or receiver assumptions were invented. Evidence: `mongoose/14/independent-{base,repair,base-adapted,repair-adapted}.json`. Source identity and exact proposal hash are in `qualification-evidence.json`.

### Mongoose 17

Eligible within historical driver return contract: null/empty result and ordinary falsey document fields, lean result and driver callback error controls. No live MongoDB proof of all projection/upsert return shapes is claimed. Evidence: `mongoose/17/independent-{base,repair,base-adapted,repair-adapted}.json`. Source identity and exact proposal hash are in `qualification-evidence.json`.

### Mongoose 18

Exclude PASS: reused {limit:2} options for identical two-document calls send limits [4,8], rather than stable scaling. Parent sends [2,2]; three documents send [6,18] after repair. A reused Query reproduces [4,8] too. This is new compounding mutation, separate from the parent feature omission of per-document scaling. Evidence: `mongoose/18/independent-{base,repair,base-adapted,repair-adapted}.json`. Source identity and exact proposal hash are in `qualification-evidence.json`.

### Mongoose 23

Exclude PASS: select "-_identity" is rewritten to outgoing fields {entity:1}; "title -_identity" adds entity:1. Parent supplied no projection here, a pre-existing omission, but did not invent an unrelated inclusion field. New substring replacement treats a field-name prefix as the exact _id token. Evidence is the native outgoing projection contract, not a simulated server result. Evidence: `mongoose/23/independent-{base,repair,base-adapted,repair-adapted}.json`. Source identity and exact proposal hash are in `qualification-evidence.json`.

### Mongoose 24

Exclude PASS: repopulation of a modified reference array converts the live Document entries to ObjectIds before the query finishes. When the real collection callback returns an error, the repaired source leaves the array depopulated; parent retains its Document entries. Scalar and successful repopulation/fresh duplicate-list controls distinguish the affected branch. Evidence: `mongoose/24/independent-{base,repair,base-adapted,repair-adapted}.json`. Source identity and exact proposal hash are in `qualification-evidence.json`.

### ESLint camelcase

Gold eligible; clean sibling excluded. Edge-underscore destructuring invariant is pass/fail/pass. However, properties:never now skips invalid local bindings with defaults, e.g. const {camelCase: snake_case=1}=obj. Parent reports; bug and later repair do not. The setting excludes property names, not local variable declarations, per original rule docs. Nested, array and parameter defaults reproduce it. Evidence: `eslint/destructured-edge-underscores/independent-controls.json`; target stage outcomes are bound under `eslint[].targetInvariant` in `qualification-evidence.json`.

### ESLint padded-blocks

Both gold and clean sibling eligible. Inline-comment target passes parent, produces reversed fix range in introduction, and is repaired. All 49 independent function/class/switch, always/never, LF/CRLF and line/block/multiple-comment configurations preserve tokens/comments, parse after real fix application and converge with no diagnostics. Evidence: `eslint/comment-adjacent-fix-ranges/independent-controls.json`; target stage outcomes are bound under `eslint[].targetInvariant` in `qualification-evidence.json`.

### ESLint max-len

Gold eligible; clean sibling excluded. Position validity is pass/fail/pass; parent may report the wrong line but has a valid position, explicitly not claimed otherwise. The later repair adds || defaults that disregard configured zero maximum length/tab width. Original docs define these numeric limits and repair schema permits zero. Parent enforces maxLength=0; repaired source silently uses 80. Evidence: `eslint/diagnostic-column-contract/independent-controls.json`; target stage outcomes are bound under `eslint[].targetInvariant` in `qualification-evidence.json`.

### ESLint no-useless-constructor

Gold eligible; clean sibling excluded. Empty-super traversal does not crash in parent, crashes in introduction and no longer crashes in later repair. Parent overreporting is pre-existing. However, a RestElement wrapping an ArrayPattern default is wrongly called simple: constructor(...[a=effect()]) {super(...arguments)} is newly reported useless. Native execution proves deleting it loses the effect (1→0). Evidence: `eslint/empty-super-argument-traversal/independent-controls.json`; target stage outcomes are bound under `eslint[].targetInvariant` in `qualification-evidence.json`.

## Data Flow Analysis

Original upstream source and first parent → immutable source snapshots → complete normalized CommonJS module/factory → actual historical framework and real dependencies → native collection callback or parser/fixer → external observations. CommonJS factories preserve module, exports, require, filename and directory bindings; full-body AST comparison retains strictness. Assertions remain outside judge-visible fixtures. The two non-executable dataset differences are disclosed and original upstream files are saved.

All pair diffs are nonempty against the same actual parent. Independent target observations are parent/bug/repair = pass/fail/pass for all four. That does not rescue three unclean later endpoints: only the padded-blocks pair is jointly eligible, while all golds remain source-backed standalone bug rows.

## Configuration Matrix

| Configuration | Expected contract | Observation | Correct? |
|---|---|---|---|
| Missing/ad-hoc reference, lean and atomic queries | Real lookup/hydration/callback contracts retained | Mongoose 2/4/7 retained controls | Yes in scope |
| New and modified saves, embedded documents | IDs for references; root/embedded objects intact | Mongoose 13 source/adapt agreement | Yes in scope |
| Missing positions and empty upsert result | Preserve index and historical absent-result handling | Mongoose 14/17 actual model/query controls | Yes in scope |
| Repeated limit options or Query | Stable scaling on identical operations | Mongoose 18 compounds scaling | No; exclude PASS |
| Longer `_id`-prefixed excluded field | Preserve field token | Mongoose 23 invents inclusion name | No; exclude PASS |
| Async population error with populated array | Retain original contents after error | Mongoose 24 leaves IDs | No; exclude PASS |
| Padded blocks: function/class/switch, LF/CRLF, comments, both policies | Ordered range, valid syntax, preserved tokens and convergence | All 49 repaired configurations pass | Yes |
| Default binding with property policy; numeric zero; rest-pattern effect | Preserve rule's actual policy/behavior contract | Three later repair endpoints fail | No; clean siblings excluded |
| devkit monorepo/no-config/other source layout | No production layout behavior changes | Only private evidence files written | Not applicable |

## Standalone population FAIL eligibility

Mongoose 18, 23 and 24 have sufficient independently verified source-regression evidence for **separate standalone FAIL proposals** on their actual original fix-parent → published endpoint. No later repair, clean sibling or variantOf is required or claimed under the recorded note. The new defect labels are agent-verified source regression assessments, not imported BugsJS labels for those failures. Base need only satisfy the precise asserted invariant: repeat stability, absence of a synthesized unrelated projection, or preservation of populated array content on lookup error. The original feature omissions remain disclosed.

No proposals or admissions were created here. Native coverage-cell, fixture reachability, privacy, near-twin and transitive family checks remain required, and represented mechanisms/families must not be duplicated to reach a count. The three rejected ESLint clean siblings should likewise remain excluded; their original golds can stand alone, with later endpoint evidence explicitly target-specific.

## Frame second opinion

The strongest contrary frame is that a pipeline focused on expanding row count will treat any published fix as clean and any executable assertion as truth, with ported frameworks supplying invented contracts. That objection would invalidate supply-driven admission. It is rebutted here by verified original lineage, whole-module identities, actual-framework calls and six concrete clean-label exclusions, while pre-existing failures and unsupported server semantics remain outside the verdict. The objective of broader source-backed bug and clean coverage is sound; the native workflow is the right layer and no additional dataset or framework is needed.

## Missing Considerations

Finite controls do not prove all repaired behavior clean. The evidence is conditional on the pinned historical dependency/runtime, and source exposure/family correlation limit inference. Reviewer quality, independent human label accuracy and frozen confirmation performance are not measured here.

## What's Good

- Complete rule/module contexts and original first parents preserve real source lineage.
- The scope separates valid golds from unclean later endpoints instead of fabricating pairs.
- Tests use actual historical parser/fixer and real Mongoose objects, with explicit collection ports.
- Error and repeated-call probes reject target-passing repairs without changing source or narrowing contracts.

## Recommended Path Forward

1. Consider the eleven eligible existing rows through native admission; keep only padded-blocks as a new complete pair and conservatively union source families.
2. If they fill coverage cells, prepare the three population standalone FAIL proposals with exact invariant/provenance disclosure and no clean-pair claims.
3. Preserve identities, controls, native family-statistics compatibility and runtime/exposure limitations before freezing the corpus. Do not fetch replacement endpoints or add candidates for row count.

## Replay entry points

- `node mongoose-population-edge-controls.cjs <BugsJS-number> <case-directory> <stage> <output-json>` operates on an already prepared source/adapted source tree using its real `node_modules`; it writes only the output and uses no database. The existing public `replay-runtime.py` is the four-stage orchestrator; integrate `population-edge-manifest.json` as documented in README.md.
- `node eslint-regression-edge-controls.cjs <pair-name> <prepared-pair-directory>` reads the six endpoint modules and historical core under that private directory and writes `independent-controls.json` there. It does not alter source. The same entry point can be packaged with private frozen source.
- `node constructor-effect-control.cjs` proves the rest-pattern default's runtime effect independently of the linter.
- `python3 replay-eslint-regressions.py --help` describes the portable dynamic replay and corpus binding. Its saved result verifies exact expected targets and independent observations, not just hashes.

## Research References

Local pinned primary-source verification suffices for these source-specific claims; no web or paid research was needed.

- `source-identities.json`, `eslint-source-identities.json`, `ast-conformance.json`: exact upstream refs, endpoint hashes and whole-module equivalence.
- `contract-sources/camelcase.md`, `contract-sources/max-len.md`: original upstream policy text; numeric zero additionally supported by the source schema.
- `contract-sources/mongoose-{18,23,24}-utils.js` and complete private module snapshots: option aliasing, query casting and identifier-conversion consumers.
- `independent-observations.json` and per-case records: 738 observations / 369 matching comparisons.
- `qualification-evidence.json`: exact eligibility, target stage results and standalone source-regression policy.
- `edge-cases.json`: nine atomic covered normal/error/repeated-operation cases.
