This is a source-qualification review, not a measured reviewer output. Artifact paths below refer to privately retained capture evidence unless an accompanying public replay is linked.

# Feature Critique: Remaining ESLint corrective PASS candidates

**Verdict**: PROCEED WITH CHANGES  
**Date**: 2026-09-13  
**Proposal**: Admit the qualified subset of 27 complete historical ESLint rule corrective changes as standalone clean controls.

## Executive Summary
21 candidates are eligible on the bounded source and behavioral evidence. Exclude 226, 260, 261 and 272 because their repaired changes introduce concrete incorrect behavior; keep 195 and 284 unqualified because published execution does not establish a passing repair. This is source-exposed agent verification on pinned historical runtimes, not independent human ground truth or a proof that every possible input is clean.

## Feasibility Assessment
- **Status**: Confirmed Feasible for the 21-case subset.
- **Evidence**: 608 independent four-stage observations over 152 scenarios; 304 source/adaptation comparisons agree. 54 complete original/normalized rule AST identities preserve executable structure, directives, declarations and free bindings. Original full rule modules run with their actual historical context/parser/scope/fixer, not hand-built ASTs.
- **Published evidence**: 4,252 four-stage target-test observations were verified from copied root receipts, test-source hashes and pinned cores. These target suites were not rerun independently here. 25 repairs pass their published suite; 195 and 284 do not.
- **Blockers**: Four concrete introduced defects invalidate their individual clean labels. Two cases lack qualifying execution evidence.

## Alignment (Decision log)
The current repository guard configuration was read at the start: implementation/backend roots are `cli` and `gate-engine`, with consumer-relative layout and no frontend/backend application split imposed. Decision log exists; `benchmarks-grow-from-telemetry` and `corpus-rows-admitted-by-coverage-cell` Targets were loaded. The latter explicitly states: “A passing targeted control establishes that invariant, not absence of all other introduced defects.” It also states “Their repo.base is the actual buggy fix parent, not a claimed passing pre-introduction version.” and “Shared contexts remain one transitive holdout family.”

| Atomic claim | Alignment | Verification |
|---|---|---|
| Corrective PASS uses actual buggy fix parent | Implements | All 27 base source blobs match the actual upstream fix parent. No passing pre-introduction assertion, synthetic gold or variant link is proposed. |
| Whole selected repaired change is clean | Implements for qualified subset; contradicted by four excluded candidates as written | Target regression success does not excuse adjacent newly introduced defects. |
| Whole rule adaptation preserves source and context API | Implements | 54 AST identities and 304 independent behavioral comparisons; actual framework is an explicit port. |
| Separate family for every distinct rule name | Contradicts if asserted without shared-context grouping | 210/257 share recursive-function context; 314 merits conservative joining to earlier parenthesis-context rows. |
| Source exposure is compatible with final reviewer-output holdout | Neutral | This critique exposes source and labels; it makes no source-unseen or human-truth claim. |

`alignment-scan.txt` retains the deterministic scope mapping. It is a scope mapper, not semantic approval of a clean label; no paid gate or reviewer was run. No target reversal is required for the qualified subset.

## Critical Issues (Blockers for individual labels)
1. **261: empty super arguments newly crash the rule.** `repair.js:59` dereferences `lastSuperArg.type`. For `class A extends B { constructor(value){ super(); } }`, base completes with one “Useless constructor.” diagnostic; repair throws `TypeError: Cannot read properties of undefined (reading 'type')`. A zero-length prefix passes `every`, so the new less-than-or-equal-length path reaches an absent last argument. The old diagnostic was itself overbroad; the claim is the new crash, not that the base was fully correct. The target case with more super arguments than constructor parameters is repaired, while rest passing and default-parameter side effects remain covered. Exclude this clean candidate.
2. **260: export-list AST newly crashes ordering checks.** `repair.js:60` reads `statements[i].declaration.type` for an `ExportNamedDeclaration` whose declaration is null. `var foo; export {foo}; var bar;` in module mode reports the ordering violation at base and throws at repair. Exported variable declarations work, and ordinary declarations retain their ordering checks. This is the already identified introducing endpoint in the separate export-declaration family; do not admit it again as a clean fix.
3. **226: Literal-key method identity becomes undefined.** `repair.js:46` reads `node.parent.key.name` for any Property, although Literal keys use `.value`. With threshold 1, `var o={ "a-b"(x){ return x ? 1:0; } };` changes a meaningful `Function 'anonymous'` fallback into `Function 'undefined'`. The same occurs for string-key function-valued and computed-string-key method properties. Actual runtime method name is `a-b`; identifier shorthand naming and explicit function names still work. The upstream change specifically promises shorthand method names, so this is a concrete introduced diagnostic-identity defect, although complexity count/location remain correct and impact is lower than a crash. Exclude the clean label.
4. **272: expanded token equality loses existing literal-value comparisons.** `repair.js:33` introduces `hasSameTokens`, replacing the earlier Literal `.value` equality. `'same' === "same"`, `0x10 === 16`, and `1e2 === 100` each produce one base diagnostic and none at repair. Historical parser values are equal and VM comparisons are true. The upstream update broadens checks to non-literals; neither the commit nor rule contract specifies removing equivalent literal detection. Newly detected chained/call expressions are retained in controls and are accepted as the intended lint policy. Exclude for the lost literal checks, not because a repeated call might return different values.

Exact inputs, messages, exceptions and four-stage matches are in `edge-observations.json`; parser-value and VM evidence for 226/272 is in `supplemental-contract-observations.json`.

## Warnings (Non-blocking for qualified subset)
1. **Historical API and parser exclusions.** 195's 48 published repaired tests all fail with `getRuleOptionsSchema` missing in the old tester/core API. These are not 48 observed rule defects. 284 has one published-valid snippet rejected by the pinned parser before meaningful rule analysis. Both remain unqualified without inventing a permissive parser or narrowing the API contract.
2. **Family and coverage accounting.** Conservatively group 210/257 because their recursive-name exemption shares helper and scope-reference context. Join or check 314 against the existing 66/142 explicit-parenthesis family before partitioning. Shared runtime is disclosed; distinct rule names alone do not establish independent mechanisms. Many rows exercise configurable lint policy and AST classification, not application state, concurrency or durable storage.
3. **Limits and faithful contracts.** Qualification is bounded, agent-derived, source exposed, and executed on Node 24 with historical ESLint dependency locks. It does not certify all old supported Node versions, all configurations, or all parser extensions. Preserve authoritative policy context in the row contract: init-declarations treats loop assignment as initialization; no-shadow explicitly exempts class names. Do not relabel these observed policies as defects solely from a broader rule name.
4. **Harness mutation and lineage detail.** lines-around-comment options can be mutated by rule328; final observations clone options for every stage. `edge-observations-initial.json` preserves the initial harness run and is superseded. Dataset repairs 251/261 differ from original upstream only by comment spelling; exact original files, comment diffs and whole AST equivalence receipts are retained. Do not claim those two original upstream files are byte-identical to the dataset copies.

## Data Flow Analysis
Pinned actual upstream fix parent and fix → complete source module → comment-only normalization preserving executable AST → historical ESLint core/context/parser/scope/fixer → diagnostics/fix output → reparse fixed output. The fixture's framework port is the actual module API; no local rule helper is dropped, and free-binding requirements are the same as source. No new packages are fabricated to make the behavior pass.

All 54 dataset endpoints match manifest hashes and Git source blobs. All 27 base endpoints match actual upstream fix parents. 52 endpoints match original upstream bytes; the two comment-only differences have matching whole ASTs. Published rule tests match their Bug-N-test source tags and manifest hashes; core source identities and runtime lock hashes are recorded in `source-identities.json`.

Private copies isolate this execution from root's stage substitutions. No qualification source, raw proposal, corpus row, reviewer setting or production file was modified. Parent's explicit private ownership overrides the skill's default `.cursor` output location.

## Configuration Matrix
| Configuration | Expected behavior | Observed result | Correct? |
|---|---|---|---|
| Historical legacy core API and ES5/ES6 input | Rule receives real AST and scope API | Actual source lib/eslint.js used where lib/linter.js is absent | Yes within covered cases; 195 remains unqualified |
| ESLint 2/3/4 core, script/module and selected ECMAScript versions | Parser and rule share supported syntax contract | Actual core and parser options; no-await-in-loop uses 2018 | Yes within covered cases; 284 remains unqualified |
| Configured modes and repeated source/adapt stages | No cross-stage mutable-option leakage | Final stages use cloned option objects | Yes |
| Fixable rules | Emitted repaired output parses through actual historical core | No repaired fixed-output parse failures | Yes within covered cases |
| Whole source vs normalized fixture | Same executable bindings, AST and observed output | 54 AST identities; 304 output comparisons match | Yes |
| Repository layout / trust boundary | Corpus evidence does not invent consumer topology | Private evidence only; no topology or gate changes | Not changed |

## Per-Candidate Decisions
Published column is base failures → repair failures / tests per stage. Independent column counts scenarios; each ran four stages.

| ID | Rule | Decision | Published | Independent | Concrete control/evidence |
|---|---|---|---|---|---|
| 166 | no-useless-computed-key | Eligible PASS | 1 → 0 / 14 | 6 | Computed __proto__ data key exemption; ordinary string/number and method fixes retained and parse. |
| 190 | init-declarations | Eligible PASS | 3 → 0 / 36 | 6 | For-in/of initialization under always and never; body declarations, const, and predeclaration retained. Loop-local declaration under never is an intentional policy result. |
| 191 | generator-star-spacing | Eligible PASS | 18 → 0 / 169 | 6 | Computed/static generator key star positions; before/after/both configurations and actual fixes parse. |
| 195 | yoda | Unqualified | 48 → 48 / 48 | 0 | Historical eslint-tester/core API mismatch: all 48 repair target tests fail before meaningful rule verification. |
| 210 | prefer-arrow-callback | Eligible PASS | 1 → 0 / 18 | 6 | Recursive named callback exemption; nonrecursive, shadowed parameter, and nested-reference controls. |
| 214 | no-shadow | Eligible PASS | 2 → 0 / 15 | 6 | Class-name scope exemptions; ordinary variable shadowing retained. Broad class exemption is explicit in changed source comment, including nested class names. |
| 217 | line-comment-position | Eligible PASS | 1 → 0 / 34 | 6 | above/beside string options, object configuration, directives and custom ignore behavior. |
| 226 | complexity | Exclude: new defect | 1 → 0 / 43 | 6 | Identifier shorthand name improves; three Literal-key forms newly report undefined instead of meaningful anonymous fallback. |
| 227 | no-fallthrough | Eligible PASS | 1 → 0 / 21 | 6 | Case-final fallthrough comments, nested switch, empty cases and terminating break. |
| 243 | unicode-bom | Eligible PASS | 1 → 0 / 7 | 6 | BOM insertion at byte zero with leading whitespace; existing BOM, never removal and comment-only source. Empty-source skip exists in both endpoints. |
| 244 | no-implied-eval | Eligible PASS | 1 → 0 / 29 | 6 | Timer API name anchors; string/template/computed/window forms, prefix/suffix helpers and nested calls. |
| 251 | newline-per-chained-call | Eligible PASS | 2 → 0 / 18 | 6 | Computed chain segment boundary; multiple lines and ignore-depth configurations. |
| 257 | func-names | Eligible PASS | 1 → 0 / 27 | 7 | Recursive names exempt under never; always naming and nonrecursive function behavior retained. |
| 260 | vars-on-top | Exclude: new defect | 3 → 0 / 47 | 5 | Actual export-list ordering control newly throws; exported-variable feature succeeds; ordinary ordering remains. |
| 261 | no-useless-constructor | Exclude: new defect | 5 → 0 / 23 | 7 | Target more-arguments-than-parameters crash repaired, but zero super arguments with constructor parameters newly crashes; rest and default-effect controls retained. |
| 263 | no-lone-blocks | Eligible PASS | 2 → 0 / 28 | 6 | Switch-case block handling; lexical declarations preserve needed block, nested and only-case-block behavior. |
| 264 | no-extra-semi | Eligible PASS | 8 → 0 / 38 | 6 | Semicolons needed for empty if/labeled/with bodies retained; program/class extra-semicolon fixes parse. |
| 272 | no-self-compare | Exclude: new defect | 1 → 0 / 18 | 7 | Nonliteral comparison feature retained but previous equal-value Literal comparisons lost; raw token spelling differs. |
| 284 | no-param-reassign | Unqualified | 1 → 1 / 36 | 0 | Pinned parser rejects one published valid destructuring-assignment input; repair has one published failure. |
| 305 | no-constant-condition | Eligible PASS | 47 → 0 / 87 | 6 | Reported test-node locations, if/while/conditional/for/no-test, checkLoops false and generator yield. |
| 308 | newline-before-return | Eligible PASS | 5 → 0 / 73 | 6 | First return statement exempt; later return, comments, branches and nested functions. |
| 309 | object-shorthand | Eligible PASS | 1 → 0 / 84 | 6 | Computed reference property exempt while computed method policies retained. ignoreConstructors computed-call-key crash predates diff. |
| 314 | no-return-assign | Eligible PASS | 1 → 0 / 19 | 6 | EOF assignment token null guards; return/arrow assignment, parentheses, always mode and call argument controls. |
| 315 | no-await-in-loop | Eligible PASS | 11 → 0 / 27 | 6 | Actual await-node reporting for nested awaits, loop conditions/initialization, nested async functions, for-await boundary; real parser ecmaVersion 2018. |
| 318 | use-isnan | Eligible PASS | 8 → 0 / 30 | 6 | Arithmetic/bitwise false positives removed and comparisons retained. Shift-operator regexp issue predates diff. |
| 321 | nonblock-statement-body-position | Eligible PASS | 1 → 0 / 48 | 6 | Multiline body beginning beside keyword; comment-preserving fixer, else overrides, below and block behavior. |
| 328 | lines-around-comment | Eligible PASS | 2 → 0 / 26 | 6 | Default beforeBlock true, afterBlock false; overrides, inline/line comments and fresh context option objects. |

## Missing Considerations and Rejected Objections
- 243 empty-source BOM omission is observed at both endpoints; it is not an introduced repair defect. The exploratory expectation remains recorded rather than rewritten into a passing claim.
- 309 computed-call property key with ignoreConstructors crashes at both endpoints (`.charAt` on missing key name); unchanged, so not grounds for excluding this corrective diff.
- 318 shift-operator matching is pre-existing; the actual arithmetic/bitwise false-positive repair and retained comparison behavior are covered.
- 214's changed source comment explicitly exempts function and class names. A nested same-name class being exempt is policy breadth to disclose, not a fabricated new stricter contract.
- Race/timing scenarios do not apply to these synchronous AST rule changes. Repeated evaluation and mutable-options isolation are covered where relevant.

## Frame Second Opinion and UX / DX Impact
Opposite frame: a set of style-rule patches could inflate row count without measuring the correctness capability the corpus seeks, and a published fix is not automatically a clean change. This objection defeats a blanket admission of all 27 or a claim of broad application-mechanism coverage. It does not defeat the narrower goal of source-backed false-alarm controls: real configurable AST algorithms and corrective changes provide useful clean cases when shared contexts are grouped and new defects excluded. The decisions explicitly allow standalone corrective PASS controls. The frame therefore remains **SOUND** with the stated subset and coverage disclosure.

**UX / DX impact: none** from admitting the qualified subset. Mislabeling the excluded repairs clean would instead reward missed defects and penalize correct findings; those rows must stay outside this batch.

## What's Good
The approach preserves complete dependency-free rules and actual framework behavior, uses real buggy fix parents honestly, retains all source and runtime receipts, and makes exclusions based on concrete introduced behavior. It does not convert published test success into blanket correctness, nor invent gold pairs from repair-only history.

## Recommended Path Forward
1. Admit only the 21 eligible IDs after binding to `qualification-results.json` corrected normalized hashes and conservative family grouping. No variant links or pair-discrimination counts for these standalone PASS changes.
2. Preserve four introduced-defect exclusions and two unqualified cases. Any future source-derived bug/repair pair needs separate lineage and whole-clean qualification; this critique does not authorize creating one.
3. Keep source-exposure, limited historical runtime, intentional lint policy and comment-only upstream differences in admission evidence. Use final `edge-observations.json`, not the superseded initial option-sharing run.

## Research References / Evidence
This bounded review uses primary local source and actual runtime behavior; no web or model calls were needed for these reproduced claims.
- `selection.json`: dataset selection and full changed hunks.
- `source-identities.json`: original upstream hashes/subjects/parents, dataset blobs, published test identities, core identities and runtime locks.
- Numbered directories: copied exact endpoints, normalized modules, actual source tree and published execution receipts.
- `adaptation-identity.json`: whole AST identities, including directive semantics.
- `upstream-formatting-conformance.json` and `251,261/dataset-upstream-repair.diff`: comment-only original/dataset differences.
- `edge-controls.mjs`, `suites.json`, `edge-observations.json`: independently executable four-stage real-core controls.
- `supplemental-contract-controls.mjs`, `supplemental-contract-observations.json`: actual parsed literal values, evaluated comparisons/method names and unqualified test failures.
- `qualification-results.json`: machine-readable eligibility, source provenance and corrected fixture hashes.
- `edge-cases.json`: atomic edge cases with evidence and outcomes.
- `alignment-scan.txt`: deterministic target-scope mapping.
