This is a source-qualification review, not a measured reviewer output. Artifact paths below refer to privately retained capture evidence unless an accompanying public replay is linked.

# Feature Critique: ESLint source-backed corrective PASS batch 2

**Verdict**: PROCEED WITH CHANGES
**Date**: 2026-09-13
**Proposal**: Admit selected list positions 12–37 as standalone corrective PASS operations against their actual buggy fix parents.

## Executive Summary
Twenty candidates are eligible; the root normalization correction is complete and byte-bound to the independently tested effective fixtures; six contain concrete introduced errors and must remain excluded: 31, 38, 51, 70, 101, 153. The independent historical-framework run covers 162 scenarios and 648 observations; the corrected normalization replay repeats those observations with 324 source/adaptation comparisons agreeing. These are source-exposed AI source/behavior assessments, not independent human ground truth or proof that a complete historical library is bug-free.

## Feasibility Assessment
- **Status**: Confirmed Feasible for the eligible subset.
- **Evidence**: All 52 endpoints match their pinned BugsJS source blobs; 49 are byte-identical to actual upstream fix/parent blobs, while repairs 38/109/113 differ only in formatting and have identical whole ASTs. Every base is the actual upstream fix parent. All 26 original source target suites have at least one failing base test and zero repair failures. The copied 4,756 published test observations were identity/parity checked, not independently rerun in this critique.
- **Blockers**: Six proposed clean labels are contradicted by real-framework controls. The root correction for 113/131 is complete and byte-identical to the independently tested effective fixtures; see root-normalization-correction-binding.json.

## Alignment (Decision log)
- **Decision log present?** Yes. Read configured roots/trust boundary and queried benchmarks-grow-from-telemetry, corpus-rows-admitted-by-coverage-cell, reviewer-claim-measurement; relevant Targets and September 13 standalone note loaded.
- The coverage-cell note states: "Their repo.base is the actual buggy fix parent, not a claimed passing pre-introduction version." It permits these standalone PASS rows with no variantOf and outside pair-discrimination denominators.
- The telemetry note states: "A passing targeted control establishes that invariant, not absence of all other introduced defects." The six exclusions apply that constraint.
- The Target states: "Shared contexts remain one transitive holdout family." Successor/shared-helper grouping below implements it.
- Atomic claims: source-pinned standalone clean diffs **implement** the coverage-cell note; nonempty actual-parent changes and native core ports **implement** source qualification; admitting the six contradicted PASS labels would **contradict** qualification; splitting shared contexts across partitions would **contradict** the family Target; private evidence files are **neutral** to product architecture.
- `check-alignment scan` completed and is saved in alignment-scan.txt. It maps scoped changed files to Targets; it is not a semantic approval, and the paid --gate was not run.

## Critical Issues (Blockers for individual rows)
### 31: Destructuring bindings skipped
- **Problem and evidence**: The new Property-value exemption also skips a new ObjectPattern local. With properties:true and ^[a-z]+$, `var {good: BAD} = source;` reports BAD in the base and reports nothing after repair. Ordinary object-expression reference exemption is retained as a feature control.
- **Impact**: A PASS label would penalize a valid introduced-change finding.
- **Alternative**: Exclude this source endpoint from clean admission; preserve source and control evidence. Any later genuine regression-pair or derived repair is a separate qualification task.
- **Artifacts**: `31/repair.js`, `31/upstream-rule-contract.md`, `edge-observations-effective.json`; additional range/location/runtime proof in `supplemental-contract-observations.json`.

### 38: Permitted edge underscores rejected
- **Problem and evidence**: The new destructuring paths call isUnderscored on raw local names instead of stripping permitted leading/trailing underscores. `_value`, `value_`, default and renamed destructuring are newly reported; ordinary `_value` remains accepted. The upstream rule contract explicitly ignores leading/trailing underscores.
- **Impact**: A PASS label would penalize a valid introduced-change finding.
- **Alternative**: Exclude this source endpoint from clean admission; preserve source and control evidence. Any later genuine regression-pair or derived repair is a separate qualification task.
- **Artifacts**: `38/repair.js`, `38/upstream-rule-contract.md`, `edge-observations-effective.json`; additional range/location/runtime proof in `supplemental-contract-observations.json`.

### 51: Labeled continue escaping finally missed
- **Problem and evidence**: `outer: while (ready) { try { work(); } finally { while (other) { continue outer; } } }` reports once in base, zero after repair. New loop sentinels stop at the inner loop despite the outer label. A separate finite runtime control proves that this route overrides a pending return. Local unlabeled continue/break and labeled local break remain valid new exemptions.
- **Impact**: A PASS label would penalize a valid introduced-change finding.
- **Alternative**: Exclude this source endpoint from clean admission; preserve source and control evidence. Any later genuine regression-pair or derived repair is a separate qualification task.
- **Artifacts**: `51/repair.js`, `51/upstream-rule-contract.md`, `edge-observations-effective.json`; additional range/location/runtime proof in `supplemental-contract-observations.json`.

### 70: Reversed autofix ranges
- **Problem and evidence**: Inline comments next to an opening/closing brace yield new fixes [14,0] and [41,26], replacing the base's ordered ranges. Historical RuleFixer documents the first item as range start and second as range end. SourceCodeFixer calls splice(start,end-start,text), so negative delete lengths silently insert a newline instead of replacing the requested interval. Actual fixed outputs still parse; no parser-corruption claim is made. The base also needed a further pass to remove some inline-comment padding, so that pre-existing incompleteness is not the finding.
- **Impact**: A PASS label would penalize a valid introduced-change finding.
- **Alternative**: Exclude this source endpoint from clean admission; preserve source and control evidence. Any later genuine regression-pair or derived repair is a separate qualification task.
- **Artifacts**: `70/repair.js`, `70/upstream-rule-contract.md`, `edge-observations-effective.json`; additional range/location/runtime proof in `supplemental-contract-observations.json`.

### 101: Removable identity escapes exempted
- **Problem and evidence**: The new blanket digit set ignores `/\8/` without captures and `/[\9]/`. Base reports each; repair reports neither. Upstream contract flags escapes safely removable without changing behavior. Actual regex controls preserve matches when these escapes are removed, while null and backreference controls change semantics and remain correctly exempted by the repair.
- **Impact**: A PASS label would penalize a valid introduced-change finding.
- **Alternative**: Exclude this source endpoint from clean admission; preserve source and control evidence. Any later genuine regression-pair or derived repair is a separate qualification task.
- **Artifacts**: `101/repair.js`, `101/upstream-rule-contract.md`, `edge-observations-effective.json`; additional range/location/runtime proof in `supplemental-contract-observations.json`.

### 153: New diagnostic location uses the wrong API key
- **Problem and evidence**: The new location object supplies `col: 1`, while the actual historical core reads location.column. On twenty spaces + `var a;\nvar longName;` with max 10, repair emits line 2 column 20 for a 13-character line; base locations remain on existing line 1 column 20. Native compact formatter exposes the invalid location. The finding is the newly introduced writer/reader mismatch and out-of-line diagnostic, not merely the pre-existing wrong attribution of all violations to line 1.
- **Impact**: A PASS label would penalize a valid introduced-change finding.
- **Alternative**: Exclude this source endpoint from clean admission; preserve source and control evidence. Any later genuine regression-pair or derived repair is a separate qualification task.
- **Artifacts**: `153/repair.js`, `153/upstream-rule-contract.md`, `edge-observations-effective.json`; additional range/location/runtime proof in `supplemental-contract-observations.json`.

## Warnings (Non-blocking after specified correction)
1. **Normalization added a directive.** Initial normalized bases 113/131/153 add module-level `"use strict"` that the original lacked. Their factories were already strict, and no behavioral difference was observed, but this removes a real part of the corrective diff. Retain the initial adaptation-identity.json and use alwaysStrict:false. Private effective outputs have exact whole ASTs and a fresh 648-observation parity run. Root has now regenerated unadmitted source fixtures and rerun published controls. root-normalization-correction-binding.json binds its corrected 113/131/153 bytes to our independently tested effective files; initial receipts remain retained.
2. **Conservative family grouping.** Group 86/156: the 3.12.2 `source/lib/rules/no-spaced-func.js` explicitly says replacedBy:["func-call-spacing"], and both selected modules contain the same call-parenthesis token traversal. Group 66/142: both carry shared isParenthesised/isParenthesisedTwice token-boundary helpers and distinguish grammar-required vs extra parentheses. This yields at most 18 families for the 20 eligible rows before wider-corpus transitive checks. Common historical ESLint runtime alone is not a claim of per-rule statistical independence.
3. **Exposure and policy scope.** Many cases are configurable style-policy classifiers, not application data/concurrency bugs. Count that coverage honestly. Published tests and independent controls are AI-inspected source evidence. Preserve contracts, refs, historical runtime locks and full modules. Do not claim an unseen set merely because reviewer outputs have not been inspected.

## Per-case qualification
| ID | Rule | Decision | Published base fail / tests | Independent scenarios | Mechanism / boundary coverage |
|---|---|---|---:|---:|---|
| 30 | no-multiple-empty-lines | eligible | 1 / 40 | 6 | Null regex-match handling for files without line terminators |
| 31 | id-match | excluded | 1 / 42 | 7 | Property reference vs destructuring declaration classification |
| 36 | no-magic-numbers | eligible | 1 / 29 | 8 | Numeric assignment and configurable object/index exemptions |
| 38 | camelcase | excluded | 1 / 63 | 8 | Destructuring/default identifier normalization |
| 50 | operator-assignment | eligible | 1 / 79 | 6 | Autofix token-range closure around parenthesized right operands |
| 51 | no-unsafe-finally | excluded | 4 / 31 | 7 | Abrupt-control ancestry through finally and labeled loops |
| 52 | func-style | eligible | 1 / 15 | 6 | Lexical this through function/arrow scope stacks |
| 59 | consistent-this | eligible | 2 / 23 | 6 | Alias declaration classification for destructuring from this |
| 66 | no-sequences | eligible | 1 / 22 | 6 | Mandatory syntax parentheses vs explicit sequence-expression intent |
| 68 | spaced-comment | eligible | 2 / 44 | 6 | JSDoc and ordinary comment prefix classification |
| 70 | padded-blocks | excluded | 4 / 70 | 6 | Indent-preserving padding autofix boundaries |
| 77 | prefer-destructuring | eligible | 2 / 24 | 6 | Simple vs compound assignment destructuring policy |
| 81 | quotes | eligible | 4 / 42 | 6 | Template-quote policy constrained by property/module grammar |
| 86 | func-call-spacing | eligible | 4 / 106 | 6 | Unsafe newline/comment deletion in call-spacing autofix |
| 94 | space-infix-ops | eligible | 2 / 47 | 6 | Keyword vs punctuator infix-operator token classification |
| 101 | no-useless-escape | excluded | 5 / 125 | 7 | Regex identity/numeric escape classification |
| 109 | object-curly-spacing | eligible | 6 / 77 | 6 | Array-ending object-spacing exception and options schema |
| 113 | no-unused-vars | eligible | 1 / 24 | 6 | Bound function-expression name usage under historical scope API |
| 116 | no-loop-func | eligible | 1 / 47 | 6 | Loop ancestry initialization for block-scoped captured bindings |
| 120 | valid-typeof | eligible | 1 / 45 | 6 | Typeof-to-typeof comparison under requireStringLiterals |
| 122 | id-length | eligible | 2 / 64 | 6 | Member-property length policy option |
| 131 | no-empty | eligible | 2 / 13 | 6 | Empty catch/try/finally block policy |
| 142 | no-cond-assign | eligible | 1 / 35 | 6 | For-condition vs if-condition parentheses accounting |
| 150 | no-unused-expressions | eligible | 4 / 47 | 6 | Await effects within expression/short-circuit/ternary policy |
| 153 | max-len | excluded | 1 / 7 | 5 | Report-location writer/reader contract |
| 156 | no-spaced-func | eligible | 1 / 28 | 6 | Bounded call-parenthesis traversal for argument-free new expressions |

Every case has its own pinned full source, rule contract, manifest and source test outcomes in its numbered folder. `suites.json` lists every input/configuration; `edge-observations-effective.json` records exact messages, exceptions, fixer output and parser results. `qualification-results.json` carries source fixes/parents and admission status.

## Data Flow Analysis
- **Source → sink**: BugsJS selected tag → verified actual upstream fix parent / fix rule blobs → whole comment-stripped module → real historical core defineRule/context/traversal → real historical parser and SourceCodeFixer → diagnostics/fixed output → private assertions/observations. No fabricated receiver API or toy AST drives these controls.
- ESLint 0.2 uses a module API whose third verify argument means saveState. The independent harness calls verify with two arguments to reset state correctly; the initial local harness mistake was corrected before valid evidence was retained. ESLint 4 uses a real Linter instance. Parser configuration is version-specific, with ES5 sources for the 0.2 cases and actual historical ES6/module/async parsing where relevant.
- Source and adaptation messages, errors and fixed outputs agree in all 324 comparisons per run. Actual fixed output is parsed again without rules. The six findings reproduce in both source and adaptation, so they are source clean-label exclusions, not adapter artifacts.
- Initial count expectations for case 113 unused-local controls were disproven. The base reports only the bound function name, never the local; after the intended function-name exemption neither is reported. The missing local diagnostic predates the patch. Original hypotheses/results remain visible and are not used as introduced-regression exclusions.
- The entire selected rule modules and added behavior were read. Unrelated pre-existing gaps (for example nested-arrow lexical-this propagation, unhandled line terminators, or other rule/core shortcomings) were not invented into new-change blockers.
- **Layout alignment**: devkit config declares CLI/gate-engine roots with a consumer-relative W-3 boundary; these private source experiments do not alter any runtime roots or consumer path resolution.

## Configuration Matrix
| Configuration | Expected behavior | Verification |
|---|---|---|
| ESLint 0.2 old module API | Reset state on each verification; strictness preserved | Cases 113/131/153, actual core; normalization correction separately verified |
| ESLint 0.21–1.x legacy contexts | Actual ES6 features where supported, no modern context assumptions | Cases 52/59/68/81/109/122/142/156 |
| ESLint 2.x–3.x | Real parser options, source-code API and fixer contract | All assigned matching runtime cases, option/default/edge controls |
| ESLint 4.12.1 | Real Linter class and destructuring/default semantics | Case 38 source and adapted controls |
| Monorepo/nondefault devkit layout | No hardcoded consumer source roots introduced | No product code/path effect in this bounded proposal |
| Decision-log absent consumer | No fabricated Targets required by these fixtures | This repo has a log; consumer config not executed by imported rules |

## Frame Second Opinion
The strongest contrary argument is that style-policy bug-fix datasets do not supply enough independent truth to justify benchmark negatives, and that the known failing parents disqualify the task before its controls matter. The current Target explicitly allows standalone corrective PASS operations on actual buggy fix parents; the label concerns the introduced change, not a global correctness assertion about the parent or library. Historical core execution plus full-source/contract review gives reviewable evidence and exposes six failures that published tests missed. The frame holds for the qualified subset, with conservative source families and explicit exposure limits. **FRAME_META: SOUND.**

**UX / DX impact**: No product workflow change. Admitting contradicted PASS labels would reward incorrect reviewer behavior and penalize valid findings; excluding them avoids that harm.

## Missing Considerations
- Native full-row assembly, near-twin checks, final family partition closure and admission are root-owned follow-up; this report does not claim they occurred.
- Finite edge controls cannot prove absence of all other introduced defects. Race/timing controls are not applicable to these synchronous rule callbacks; scope-stack reset and actual historical context behavior were tested where relevant.

## What's Good
- Actual upstream parent/fix identities and full rule modules make findings reproducible. Source docs preserve intended style policy rather than creating a new requirement.
- Original failing cases and new feature controls remain alongside adversarial inputs. No source fixes were invented to force eligibility.

## Recommended Path Forward
1. Admit only the 20 eligible rows with the corrected 113/131 hashes; retain six exclusions and original receipts.
2. Use the two conservative pair groupings and native transitive checks before freezing any partition.
3. Keep standalone labels outside pair denominators and disclose the style-policy concentration and source-exposed AI assessment.

## Research References
No web or paid reviewer calls were needed for these locally reproduced source claims. `source-identities.json` records exact public upstream commit IDs and subjects; each numbered folder retains the original rule contract. Relevant local decision records are in the owned worktree docs/decisions/benchmarks-grow-from-telemetry.md, corpus-rows-admitted-by-coverage-cell.md and reviewer-claim-measurement.md.
