This is a source-qualification review, not a measured reviewer output. Artifact paths below refer to privately retained capture evidence unless an accompanying public replay is linked.

# Feature Critique: Hexo corrective changes and two regression pairs

**Verdict**: PROCEED WITH CHANGES
**Date**: 2026-09-13
**Proposal**: Qualify seven Hexo standalone corrective PASS operations and two source-pinned genuine bug/repair pairs.

## Executive Summary
Six Hexo standalone changes (3,5,6,7,8,9) and both regression pairs qualify: ten potential rows. Hexo4 must remain excluded because the repaired asset-path operation produces file/directory collisions for real `.html` post permalinks. Independent source/adaptation controls produced 324 observations and 162 matching comparisons, alongside 20 byte-exact upstream endpoints and 22 full-module/complete-operation AST identities.

These findings are source-exposed AI source/behavior qualification. They are not independent human ground truth, a model benchmark, or proof that whole historical library checkouts are clean.

## Feasibility Assessment
- **Status**: Confirmed Feasible for the qualified subset.
- **Source evidence**: Every Hexo base equals the actual upstream fix parent; each base/repair source file is byte-identical to its pinned upstream blob. Both pairs have actual parent→introducing-commit ancestry and later descendant repairs. `source-identities.json` and independently replayable `verify-provenance.py` / `provenance-verification.json` retain the evidence.
- **Adaptation evidence**: Whole Hexo modules plus the unchanged Moment relative dependency preserve ASTs. Both complete semicolon rules and all three extracted validation functions preserve ASTs. Proposal source bytes agree with the inspected normalized fixtures; see `verify-adaptation.mjs` / `adaptation-identities.json`.
- **Blocker**: One contradicted standalone clean label, Hexo4.

## Alignment (Decision log)
Freshly read guard.config.json: this repo declares CLI/gate-engine roots, no frontend split, and consumer-relative W-3 trust. The proposal writes private evidence and later source corpus fixtures; it does not change consumer path resolution or the reviewer.

Queried and loaded `benchmarks-grow-from-telemetry` and `corpus-rows-admitted-by-coverage-cell`. The source Target requires: “Shared contexts remain one transitive holdout family.” The September 13 standalone note states: “Their repo.base is the actual buggy fix parent, not a claimed passing pre-introduction version.” The qualification note cautions: “A passing targeted control establishes that invariant, not absence of all other introduced defects.”

Atomic claims: the six qualified standalone corrective changes **implement** the current standalone admission direction; real introducing-source pairs with retained feature controls **implement** the source-rooted pair invariant; admitting Hexo4 as clean would **contradict** that invariant’s whole-change inspection requirement; shared Hexo3/5 caseId **implements** conservative family grouping. Private control harnesses are **neutral** to consumer architecture. `check-alignment scan` completed in `alignment-scan.txt`; this is scoped Target mapping, not semantic approval, and no paid gate ran.

## Critical Issues (Blocker for Hexo4)
### Joining a post filename as an asset directory
**Problem**: `pathFn.join(post.path, this.slug)` assumes the post permalink denotes a directory. The actual original post-permalink filter supports file-ending routes. A post at `entry.html` cannot also be the directory containing `entry.html/plain.png`.

**Evidence**: `hexo-edge-controls.cjs` creates actual Hexo, Warehouse Post and PostAsset instances, registers the original `lib/plugins/filter/post_permalink.js`, and sets the real config permalink to `:title.html` or `:title/index.html`. No replacement permalink function or invented Post receiver supplies the path. The actual post and asset getters yield:

| Configuration | Base asset | Repair asset | Filesystem result |
|---|---|---|---|
| `:title.html` | `plain.png` | `entry-1.html/plain.png` | Base materializes both; repair EEXIST |
| `:title/index.html` | `entry-2/plain.png` | `entry-2/index.html/plain.png` | Base materializes both; repair EEXIST |

The filesystem demonstration creates only private files in this critique directory. Source `lib/plugins/generator/asset.js` directly passes `asset.path` as the route path, and asset tags consume that path; the failure is not a fabricated consumer reinterpretation. This does not claim a full deployed site or full generation run. Directory-style permalinks, space-containing slugs, child assets and missing post references remain controls. All four source/adapted stages agree.

**Impact**: A clean label would penalize a valid introduced-change finding on supported configuration.

**Alternative**: Exclude this repair endpoint from standalone clean admission. Any later agent-derived repair or genuine regression pair needs its own qualification; do not change the source here.

**Evidence files**: `4/independent-base.json`, `4/independent-repair.json`, `4/independent-base-adapted.json`, `4/independent-repair-adapted.json`, `4/source/lib/plugins/filter/post_permalink.js`, `4/source/lib/plugins/generator/asset.js`.

## Per-candidate Decisions
| Candidate | Decision | Evidence and retained behavior |
|---|---|---|
| Hexo3 | Eligible | 36 observations: index route, paginated boundaries, punctuation, repeated regex-cache configurations, other exports. Root has 28 target/neighbor observations. |
| Hexo4 | Excluded | 24 observations: real file-ending permalinks cause new collisions; directory and missing-reference controls retained. |
| Hexo5 | Eligible | 40 observations using actual Router.format before helper calls, strict/non-strict root and nested paths, other exports. |
| Hexo6 | Eligible | 28 observations through actual models: filter/coercion, duplicates, category hierarchy, replacement, clearing, repeated and concurrent different-post calls. |
| Hexo7 | Eligible | 24 observations: entities, nested links, code markup, depth changes and repeated option state. |
| Hexo8 | Eligible | 28 observations: relative/query/fragment/protocol-relative URLs, explicit resolution base, unchanged input arrays. |
| Hexo9 | Eligible | 24 observations: page current/total, option overrides, transforms, zero edge sizes, nonpaginated page. |
| Sparse validation | Eligible pair | 48 observations: native document.validate null arrays pass/ReferenceError/pass; async mixed children, error collection, repeated recovery and separate concurrent calls. |
| Statement separator | Eligible pair | 72 observations: actual parser/fixer plus execution distinguishes syntax errors and valid division parse changing value 12→6; prefix ++/-- improvement retained. |

`qualification-results.json` binds IDs, refs, family IDs and exact artifact paths. These per-case decisions are pre-admission outcomes, not a claim that native admission has occurred.

## Data Flow Analysis
### Hexo modules and receivers
The complete original modules execute after substitution into private copies of historical Hexo sources, with immutable runtime node_modules reused. The dependency closure is present and real installed package versions are retained in source receipts. The full Post module’s relative Moment implementation has identical source/fixture ASTs; its unchanged native dependency was retained during control execution. Helper registries are the original Hexo registrations. Models are actual in-memory Warehouse instances, not mocks or a database service.

Hexo5’s actual producer runs `var path = route.format(item.path)` before constructing `Locals`; Router.format maps an empty route or slash suffix to `index.html`. Therefore a direct helper call with `this.path === ''` is not a valid renderer-produced counterexample. The private controls use the actual Router. Rejecting this candidate on that assumption would invent a source contract.

Hexo3 accepts `page/2/indexXhtml` in the repaired regex, but the original broad prefix matcher already accepted it. That input does not establish a newly introduced regression. Similarly, Hexo7 intentionally switches from HTML heading contents to escaped plain text; stripped markup is the recorded new behavior, not evidence of an accidental unsupported policy change. No contract was narrowed to hide a new failure.

### Sparse validation pair
Actual source pins are f3fe51cfe5e31ed58de57fc4fedf057bef504f36 → 66f1ceda22e50071783e8dcd816d467146d043ba → 9408e1d8b1a670f6cdf43a5226828ea3faf2978c. The complete doValidate function has one external framework binding, SchemaType, explicitly passed from the actual library. The function replaces only the method on the real DocumentArray schema type. Model construction, casting, nested document validation, child validator timing and document error aggregation remain native.

`new Model({items:[null]}).validate(...)` and `[null,null]` follow pass/fail/pass; the bug throws from a process.nextTick callback with `errors is not defined`. The initial independent run reproduced that unhandled process failure. The final harness uses an external Node domain only to capture asynchronous exceptions as observations; it does not modify source behavior or supply the missing binding. Valid/invalid asynchronous child mixtures finish once; the repair retains both child error keys where the parent reported only the first. Repeated changed-child validation recovers, and separate concurrent documents retain isolated results. Native BSON reports an unavailable x86 binary and uses its own documented JS fallback; the log is retained.

### Statement-separator pair
Pins are 2ffe51636a64e9ae0cd7621a7c61936346025ca0 → 14183848a1551710dd4a4dc602c5ba10adba502e → 6e61070a682538af5bbaa7c9bd5e284f05720350. Entire rule modules remain intact. Actual historical ESLint 3.7.1 core, parser and source-code fixer run all three snapshots; this is a fixed historical framework port, not execution of three entire distinct checkouts. API behavior is exercised directly and the later 134-test source suite has source/adaptation parity in the retained root receipts.

Independent controls cover comments, CRLF, Unicode line separators, prefix updates, templates, export declarations, normal strings and the existing one-line block option. The target regex with no flags becomes syntax-invalid only in the buggy fix. A second complete program declares real `a`, `z`, and `i.test` bindings: before fixing its value is 12; the buggy automatic removal changes it to 6 by a syntactically valid division parse. Parent/repair preserve 12. The repaired common-base diff remains nonempty and retains prefix ++/-- handling. The full later repair differs from parent only in the opt-out pattern and prefix-token guard after comment/format normalization; no unrelated fabricated fix was introduced.

## Warnings and Limits
1. **Family closure and exposure**: Hexo3/5 share is.js and already share caseId; keep the family intact. Sparse validation is from lib/schema/documentarray.js, distinct from the previously grouped lib/types/documentarray.js operations, so the similarly named modules alone do not prove shared selected context. Apply native wider-corpus transitive checks. Both source investigators have seen the source, so future reviewer-result reservation does not make it source-unseen.
2. **Runtime scope**: Modern Node24 runs locked historical packages. Historical package installation is reproducible via the recorded locks; Hexo-util’s reviewed deterministic highlight-alias postinstall artifacts and the native BSON JS fallback are disclosed. No claim is made about every historical Node/platform combination, a production database, complete site deployment, or whole-library correctness.
3. **Evidence distinction**: The independent controls add 324 observations; root Hexo180, sparse42 and separator96 controls are retained separate prior evidence. The semicolon published suite’s 804 observations are root-produced and identity/receipt checked here, not independently rerun. Source agreement does not by itself prove semantic correctness; the introduced-change counterfactuals and source contracts govern the decisions.

## Configuration Matrix
| Configuration | Expected behavior | Evidence |
|---|---|---|
| Directory-style permalink | Asset shares post directory without URL-escaped filesystem name | Actual Hexo/Warehouse controls |
| File-ending permalink | Post and asset can both exist | Base passes; Hexo4 repair conflicts |
| Root or nested renderer route | Router formatting precedes location-helper comparison | Actual Router.format plus original Locals producer inspection |
| Async child failure / null sibling | Exactly one aggregate validation result, preserving child errors | Native model validation and explicit failure capture |
| Repeated/concurrent separate validations | Per-call counters/errors remain isolated | Native models, timed validators |
| ES6 syntax and semicolon mode/options | Fix preserves parse and behavior, retains prefix-update feature | Actual historical linter/parser/fixer plus VM control |
| Nondefault devkit consumer layout | No hardcoded consumer roots introduced | No product path/code change in this proposal |

## Frame Second Opinion
The strongest opposite case is that these small public repairs and shared framework ports might merely pad a corpus with examples whose labels follow their source tests. That would be insufficient. Here the existing Target expressly authorizes source-backed standalone corrections, complete module/function identities preserve reviewable context, real callers reproduce both genuine regression pairs, and an independent configuration test rejected a published Hexo repair. The framework ports are disclosed and source consumer contracts prevent false objections such as the empty-root-path claim. The frame is sound for the qualified subset, with finite-evidence and family limitations rather than a claim of independent production truth. **FRAME_META: SOUND.**

**UX / DX impact**: No product workflow change. Excluding Hexo4 avoids teaching a clean-control benchmark to penalize a real filesystem-path finding.

## Missing Considerations
Native fixture assembly/checks, privacy, near-twin scans, family partition closure and admission remain root-owned work. No corpus or reviewer settings were edited. Local source paths in this report are evidence locations only, not new consumer architecture assumptions.

## What’s Good
Real introducing commits and later observed repairs support honest pass/fail/pass pairs while retaining new behavior. Standalone changes avoid manufacturing gold labels. Full modules, actual callers, source policies, dependency locks and original receipts make the qualifications reviewable.

## Recommended Path Forward
1. Admit Hexo3/5/6/7/8/9 and both pairs through the native checks; retain Hexo4’s exclusion and exact evidence.
2. Preserve shared Hexo3/5 family identity and source-exposure disclosure; run native wider-corpus family closure.
3. Keep standalone PASS cases outside pair-discrimination denominators and report source/runtime scope honestly.

## References
All claims are locally source-backed; no web or model calls were needed. Public commit hashes and paths are in provenance-verification.json and source-identities.json; source test changes and runtime postinstall receipts are retained. Decision records: owned-worktree docs/decisions/benchmarks-grow-from-telemetry.md and corpus-rows-admitted-by-coverage-cell.md.
