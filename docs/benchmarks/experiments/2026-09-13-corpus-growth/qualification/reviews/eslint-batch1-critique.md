This is a source-qualification review, not a measured reviewer output. Artifact paths below refer to privately retained capture evidence unless an accompanying public replay is linked.

# Feature Critique: First twelve ESLint corrective PASS candidates

**Verdict**: PROCEED WITH CHANGES — qualify eight; exclude four unchanged repairs.
**Date**: 2026-09-13
**Proposal**: Admit full dependency-free historical ESLint rule corrections as standalone PASS rows, with the actual buggy fix parent as repo.base, no invented gold and no variantOf.

## Executive Summary

Eligible at the source-conformance boundary: **3, 6, 7, 14, 20, 25, 26, 27**. Exclude **1, 13, 21, 28** as currently proposed: each upstream repair introduces a concrete rule failure that its published regression suite does not exercise. All twelve full source endpoint pairs are genuine, and all twenty-four adapted modules preserve their source ASTs; the exclusions are defects in upstream repaired behavior, not adaptation errors.

Independent controls produced **400 observations across 100 scenarios**, using privately extracted historical ESLint cores and their actual parser/context/fixer APIs. Source/adaptation diagnostics, thrown errors, fix text and fix parse outcomes agree in all **200 paired comparisons**. Separately inspected and snapshotted parent-authored published-test evidence covers **675 target tests / 2,700 four-stage observations**; every original repair passes those tests, including #13's TypeScript fixture after the harness correction. That published replay was not independently rerun by this critic and is not represented as independent human truth.

## Feasibility Assessment

- **Status**: Confirmed Feasible for the eight qualified source diffs.
- **Evidence**: [source identities](source-identities.json), [actual upstream parent/fix lineage](upstream-lineage.json), [whole-module AST parity](adaptation-identity.json), [independent controls](edge-controls.mjs), [observations](edge-observations.json), and [published evidence snapshot](published-evidence-snapshot.json).
- **Blockers**: Four row-specific repaired regressions below. Removing those candidates preserves the proposed source-backed corrective-PASS mechanism; no new framework or rewritten production repair is needed.

## Alignment (Decision log)

Read the owned worktree guard.config.json and relevant Targets before endorsing admission. The declared source trees are cli and gate-engine; both are backend roots, frontend roots are empty, and the W-3 trust model is a consumer-relative portable CLI/gate engine. These research controls do not change that architecture or create a client/server boundary.

The decision log is present. Queried/read benchmarks-grow-from-telemetry, corpus-rows-admitted-by-coverage-cell and reviewer-claim-measurement. The 2026-09-13 standalone-correction note explicitly states: “Their repo.base is the actual buggy fix parent, not a claimed passing pre-introduction version.” It also requires no variantOf and exclusion from pair-discrimination denominators. This proposal implements that ruling.

The source-qualification Target states: “A passing targeted control establishes that invariant, not absence of all other introduced defects.” The four exclusions apply that constraint. Calling them wholly clean merely because the published tests pass would contradict it. No existing Target requires manufacturing a pre-introduction passing base or a paired gold for the eight standalone repairs.

Atomic alignment: actual source pinning **implements** the source-root requirement; full rule adaptation and actual ESLint context controls **implement** source conformance; the eight standalone PASS labels **implement** the September correction note; the four excluded clean labels **contradict** whole-change qualification if retained; family-level exposure disclosure **implements** the family/measurement Targets. No production layout or storage-axis change is proposed.

Ran the native `check-alignment scan`: it listed scope-matched Targets for the parent's in-progress corpus/comparison files. This is deterministic scope mapping, not a semantic alignment verdict. No paid alignment judge or reviewer was invoked, and no parent files were changed.

## Candidate Results

Published column is total tests / base failures / repair failures. Independent scenarios each run against source base, source repair, adapted base and adapted repair.

| Bug | Rule | Result | Published | Independent scenarios | Assessment |
|---|---|---|---|---|---|
| 1 | no-obj-calls | Exclude | 4 / 1 / 0 | 4 | Introduced false diagnostics for callable shadowed Reflect. |
| 3 | prefer-template | Eligible | 14 / 3 / 0 | 8 | Unary constants and template literals preserve the source-stated literal policy; dynamic non-template operands still report. |
| 6 | arrow-spacing | Eligible | 42 / 2 / 0 | 8 | Outer arrow is located from its body despite arrows inside default parameters. |
| 7 | comma-dangle | Eligible | 66 / 7 / 0 | 8 | Closing-line comma policy is implemented consistently with the upstream fix and published additions. |
| 13 | new-parens | Exclude | 16 / 1 / 0 | 10 | Inner constructor parentheses are incorrectly attributed to outer new. |
| 14 | max-statements-per-line | Eligible | 97 / 3 / 0 | 9 | Export wrappers no longer double-count their declarations; function-body and following statements still count. |
| 20 | sort-vars | Eligible | 49 / 2 / 0 | 9 | Filtered Identifier list seeds reduction; destructuring and ignoreCase no longer crash. |
| 21 | semi | Exclude | 132 / 1 / 0 | 10 | Required semicolon before regular expression is removed, producing invalid syntax. |
| 25 | brace-style | Eligible | 103 / 5 / 0 | 9 | Single-line allowance and independent opening/body/closing reports follow configured brace style. |
| 26 | arrow-parens | Eligible | 49 / 8 / 0 | 10 | Actual parameter token is selected after async; returned autofixes remain valid syntax. |
| 27 | no-useless-rename | Eligible | 84 / 1 / 0 | 10 | Skipped shorthand/computed properties no longer suppress later redundant rename reports. |
| 28 | no-duplicate-case | Exclude | 19 / 1 / 0 | 5 | Raw literal spelling remains in hashes, hiding duplicate values with alternate syntax. |

## Critical Issues (Row-specific blockers)

1. **#1 no-obj-calls newly rejects callable local Reflect.**
   - [repair.js:31](1/repair.js) adds the name Reflect without resolving its binding. `function invoke(Reflect) { return Reflect(); } invoke(function () {});` emits zero diagnostics at the original parent and one at the repair. A locally declared callable `function Reflect() { return 1; } Reflect();` reproduces the same regression.
   - The source metadata describes global object properties; a local parameter/function is not the global noncallable Reflect object. Existing Math/JSON shadowing weaknesses do not make this newly added Reflect false positive pre-existing.
   - Global `Reflect()` still demonstrates the intended feature (base 0, repair 1), and `Reflect.ownKeys({})` is preserved (0/0). Exclude this original repair as PASS; retain its source and controls unchanged.

2. **#13 new-parens confuses inner and outer constructor argument lists.**
   - [repair.js:60](13/repair.js) checks only the final two tokens. `var a = new new Foo();` has a parenthesized inner construction and an outer construction without its own `()`. Base reports one missing-parentheses diagnostic and offers `new new Foo()()`; repair reports none.
   - Both explicit argument lists, neither argument list, parenthesized call callees, comments, arguments, class expressions and computed properties were exercised. This is an introduced omission, not a TypeScript parser harness failure. The separate published TypeScript target is repaired but does not establish whole-change cleanliness.
   - Exclude the original repair as PASS; do not silently narrow the admitted input domain to a single constructor expression.

3. **#21 semi deletes a necessary separator and emits invalid JavaScript.**
   - [repair.js:56](21/repair.js) anchors the opt-out token pattern; [repair.js:130](21/repair.js) applies it to the whole token value. A regular-expression token such as `/abc/` is therefore no longer protected.
   - With `never`, `var x = 1;\n/abc/.test('abc')` produces no base diagnostic. Repair reports “Extra semicolon.” The actual historical SourceCodeFixer yields `var x = 1\n/abc/.test('abc')`, which the actual historical parser rejects at the dot. Source and adaptation reproduce identically.
   - The intended prefix increment/decrement change is retained in controls; array, parenthesized-call, unary plus/minus, EOF, always and omitLastInOneLineBlock branches are also covered. Exclude the repaired row; a future agent-derived clean control would require a separate source-backed qualification, not a retroactive PASS assertion here.

4. **#28 no-duplicate-case loses equivalence across literal spellings.**
   - [repair.js:40](28/repair.js) serializes the AST after stripping position fields; `Literal.raw` remains. The original parent hashes literal type/value instead.
   - Switch cases `"a"` and `'a'`, or `10` and `0xA`, have the same value. Base reports each duplicate; repair reports neither. Identically spelled literals and repeated nested expressions still report, while distinct `a.b` and `a[b]` are correctly distinguished by the new behavior.
   - Exclude the original repair as wholly clean. Do not invent a raw-spelling-only rule contract to rescue the label.

## Warnings (Non-blocking, significant)

1. **Keep policy context and framework identity visible.** These are ESLint implementation-correctness examples, including correct implementation of configurable stylistic policies. They are not invitations to enforce those styles on unrelated product code. The complete rule API/options/messages remain in each fixture, and the actual historical framework is the honest external port. Preserve neutral source-stated policy context when materializing rows, particularly for older modules without meta.docs. Do not call the dependency-free rule module a dependency-free end-to-end program; execution still uses historical ESLint, its parser, and lock-pinned runtime packages under Node24.

   Two tempting exclusions were explicitly rejected: #7 intentionally forbids a comma immediately before a closing delimiter on the same line; the original fix title and published test additions establish this, so a comma on its own closing line is not a contrary rule oracle. #3 explicitly reclassifies TemplateLiteral as a literal node. The control ``var result = `a${value}` + "b";`` changes from one diagnostic to zero; this behavior is disclosed, not asserted to violate an independently established static-only policy. Dynamic ordinary operands still report. Do not describe this fix more narrowly than its actual behavior.

2. **Source verification does not create independent measurement samples.** Eight rule-specific mechanisms and commits justify distinct candidate families at this boundary, but they share ESLint/parser infrastructure and source-domain bias. Native duplicate/family admission remains required; merge any related rule/event variants and retain exposure metadata. These rows are standalone negatives, outside pair-discrimination denominators. Investigator knowledge of source and anticipated labels is disclosed; neither held-out reviewer-output inspection nor passing controls establishes source-unseen, human-ground-truth or production precision claims.

## Data Flow Analysis

Pinned upstream parent/fix rule blobs → immutable local base/repair snapshots → comment/format normalization → complete CommonJS rule module → actual historical ESLint `defineRule`/`verify` → real AST, scopes, SourceCode and report/fix APIs → diagnostics and actual SourceCodeFixer output → actual parser validation. Assertions and observations remain outside reviewer-visible rule files.

All base blobs equal their actual original upstream fix-parent rule, and all repair blobs equal their original upstream fix rule. The BugsJS fork refs are separately retained, so reconstructed dataset tags are not misrepresented as the original upstream commit identities. The adaptation comparison removes only AST location/comment/token metadata, preserving literal raw forms and executable structure; all 24 whole ASTs match. Source/adaptation hashes also still match the parent's current endpoint files at final inspection.

The private execution cores came from per-case Git archives; no test was executed in the parent's mutable source trees. Runtime node_modules were reused read-only. Published test identities are pinned to Bug-N-test; #13's fixture-parser dependency is a source-test dependency, not permission to simulate TypeScript support with a made-up AST. Its corrected parent replay is retained as parent-generated evidence.

## Configuration Matrix

| Configuration | Expected | Observed | Correct? |
|---|---|---|---|
| ESLint 0.23/1.x legacy rule functions and ecmaFeatures | Original context/parser behavior | Source/adaptation parity; #28 regression exposed | Eligible subset only |
| ESLint 2.x/3.x rule objects and parserOptions | Same real visitor/report/fixer contracts | Source/adaptation parity; #1/#13/#21 regressions exposed | Eligible subset only |
| ES6 modules/export wrappers | Accurate counts and valid import/export fixes | #14/#27 controls retained | Yes in tested controls |
| ES2017 async arrows | Operate on parameter token after async | #26 fixes parse; zero/multiple/default/destructured params remain valid | Yes |
| Nondefault rule options | Respect each rule's published option contract | always/never/multiline, allman/stroustrup/1tbs, ignoreCase, as-needed/block-body and ignore flags exercised | Yes for eligible repairs |
| Full published TypeScript fixture parser for #13 | Published regression should run in genuine fixture harness | Corrected parent replay 16 tests, base1 failure, repair0; independent nested-new failure remains | Target passes, row excluded |
| Consumer monorepo/no guard config | No production layout change | Private qualification only; no new consumer path assumption | Not applicable |
| Timing/races | Synchronous per-lint traversal | Each verify resets traversal state; no concurrent source substitution in private controls | No asynchronous path to test |

## Frame Second Opinion

The strongest contrary frame is that a known upstream fix with every published target test passing should be accepted as the source oracle, making extra exclusions an agent's stylistic preference. That objection fails for the four exclusions: scope-resolved callable local functions are not the global Reflect object, an outer constructor still lacks its own argument list, a real semicolon autofix creates a parser error, and equivalent switch values remain duplicates. These are executable implementation failures under the rules' retained source contracts, not preferences about writing application code. Conversely, that challenge prevents overclaiming #3/#7: explicit upstream policy choices are retained rather than reinterpreted into invented blockers. **FRAME_META: SOUND.**

**UX / DX impact:** none for the eight-row qualified proposal; retaining the four disproven PASS labels would penalize a reviewer for correctly finding real defects and distort false-alarm measurement.

## Missing Considerations

No proof of universal repair correctness is claimed. Remaining runtime/version, option and parser surfaces are bounded by the preserved sources and tests. Final row materialization and native admission, including family/twin/privacy checks, are the parent's next boundary and were not performed here. This report does not authorize new golds or derived repairs for the exclusions.

## What's Good

Whole rule modules avoid hand-slicing away dangerous branches. Pinning original upstream parents as well as dataset fix tags keeps standalone corrective labels honest. Actual historical contexts and fixers expose both false positives and lost diagnostics; published-test parity is retained without equating it to full cleanliness.

## Recommended Path Forward

1. Materialize and natively admit only 3, 6, 7, 14, 20, 25, 26, 27 from this batch, with source, API, policy and exposure disclosure intact.
2. Retain 1, 13, 21, 28 as unchanged exclusions linked to these controls. Any future gold/derived-clean proposal requires its own real introducing-parent proof and retained feature controls.
3. Keep these standalone PASS rows outside matched-pair denominators; preserve source-framework correlation and run the existing native family/near-twin checks before freezing the wider batch.

## Research References and Replay

This is local primary-source/behavior verification; no web-derived claim, paid model call or benchmark output was used. Exact upstream commit messages/refs are in [upstream-lineage.json](upstream-lineage.json); sources, docs, original tests and privately extracted core trees are under each numbered directory. The governing Targets live in the owned worktree's docs/decisions and are identified above.

Replay with Node24: `node edge-controls.mjs` and `node adaptation-identity.mjs` from this private directory. See [qualification-results.json](qualification-results.json) for compact eligibility and [edge-cases.json](edge-cases.json) for 12 risks / 100 atomic controls. Findings represent a separate agent's source critique, not independent human ground truth.
