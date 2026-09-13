# Feature Critique: Runtime source-backed correctness candidates

**Verdict**: PROCEED WITH CHANGES  
**Date**: 2026-09-13  
**Proposal**: Admit 27 historical Karma, Redis and Mongoose corrective diffs as standalone clean correctness rows.  
**FRAME_META**: SOUND  
**UX / DX impact**: none from the qualified subset; false clean labels would penalize a correct reviewer.

## Executive Summary

Twenty candidates are eligible as standalone corrective PASS changes under the tested historical framework contracts. Seven published repairs introduce independently reproduced source defects and are excluded as PASS. Karma 17's initial adaptation omitted executable dependency-injection comments; corrected source-preserving endpoints pass the real injector controls and are eligible. Karma 12 has the same adaptation correction, but its source binary-corruption defect remains and excludes its PASS label.

This is source/behavior verification by an independent agent, not independent human ground truth. No corpus, raw proposal, reviewer, production code or model output was changed or used. This directory is the sole write scope; private source copies preserve initial evidence and corrected copies separately.

## Feasibility Assessment

- **Status**: Confirmed Feasible for the qualified subset through existing native admission.
- **Evidence**: 27 actual upstream first parents verified; 66 source endpoints checked against dataset and upstream. 65 endpoints match upstream bytes exactly. Mongoose 25's repair differs only by two blank-line trailing spaces; its executable AST is identical. All 64 JavaScript endpoints match their complete loader-factory bodies, with the two package JSON endpoints checked separately. Effective Karma 12/17 comment-preserving endpoints are independently rebound in the effective identity receipt.
- **Behavior**: 145 independent scenarios across four stages produce **580 observations and 290 source/adaptation comparisons, zero mismatches**. The parent supplied 1,336 additional prepared observations (Karma 1,052, Redis 144, Mongoose 140); these are not all passing assertions and are not claimed as a fresh independent suite replay.
- **Blockers**: Seven clean-label exclusions below. No architectural or tool-framework replacement is required.

## Alignment (Decision log)

The consumer config identifies `cli` and `gate-engine`, no client/server split, and consumer-relative W-3 execution. This evidence work is outside production scan roots. The governing `corpus-rows-admitted-by-coverage-cell` and `benchmarks-grow-from-telemetry` Targets were queried/read, including the current source-qualification notes. Their complete current text is copied into `governing-context/`. The deterministic alignment scope scan completed (`alignment-scan.txt`); a scope scan is not semantic approval.

Relevant exact rules:

> a FAIL row's defect must be introduced BY the diff and reachable from files in the fixture

> A passing targeted control establishes that invariant, not absence of all other introduced defects.

> Keep verdict-labeled telemetry and fix-anchored known-answer imports as the roots of corpus cases.

> Shared contexts remain one transitive holdout family.

The standalone corrective PASS note specifies:

> Their repo.base is the actual buggy fix parent, not a claimed passing pre-introduction version.

The new standalone FAIL note explicitly permits an actual upstream fix-parent and changed endpoint with independently established introduced failure, while forbidding a fabricated clean sibling, later repair or BugsJS-provided label claim.

Atomic alignment: original source/fix pins **implement** source anchoring; framework ports and private external controls **implement** executable reachability; standalone clean labels with no variantOf **implement** the corrective PASS note; the seven proposed clean labels **contradict** the demonstrated whole-change cleanliness rule and must be excluded; preserving active comments **implements** executable source fidelity; conservative shared-family union **implements** holdout separation. None reverses a recorded Target. No historical rows or labels are relitigated.

## Critical Issues (Blockers for seven PASS proposals)

1. **Karma 9: extended-glob watch roots stop reaching files.** Parent watches `/root` for `@(a|b)` and `?(a|b)` patterns. Changed code passes the literal pattern path to the actual pinned chokidar, whose `_handle` performs filesystem stat without glob expansion. Real minimatch accepts the file and the source ignore predicate does not ignore it. The change fixes literal parentheses but drops these other supported operators.
2. **Karma 12: binary assets are converted to UTF-8 text.** With no preprocessors, parent preserves PNG bytes `89504e470d0a1a0aff`; changed endpoint serves `efbfbd504e470d0a1a0aefbfbd`. The newly unconditional `buffer.toString()` stores `file.content`; the actual source-files middleware serves that field. ASCII, empty, text transformation and SHA context controls retain the intended feature. Corrected comments remove the separate adaptation fault, not this source defect.
3. **Karma 16: range parsing measures string units before bytes.** Actual first read of `éXYZ` for `bytes=3-4` yields `YZ`; the cached second read yields only `Y` after repair. Parent returns `YZ` both times. The source's cached string reaches `parseRange` before Buffer conversion; suffix ranges also shift. Valid Buffer and unsatisfiable-range target controls still pass.
4. **Karma 18: cache dedup bypasses inclusion specificity.** Actual `Pattern.compare` previously excludes `nested/two.js` under a more specific `included:false` pattern. When a broad included pattern appears first, the new matched-file skip removes the later bucket and includes the excluded file. Reversing order changes the result. This is the existing source policy, not an invented preference; intended duplicate preprocessing improves from four calls to three.
5. **Karma 21: path normalization removes glob meaning.** Actual historical Glob expands `**/../*.js` to three files. Parent List.refresh agrees; changed `path.normalize` collapses it to `*.js` and only one file is returned. Literal parent paths and normal recursive globs are retained controls.
6. **Karma 22: own IPv6 origin produces a malformed filename.** Native launcher constructs a valid URL from configured `[::1]`. The new unescaped hostname regex formats `http://[::1]:9876/base/file.js:1:2` as `http://[::1]:9876file.js:1:2`, where parent yields `file.js:1:2`. IPv4/domain controls and intended foreign-origin preservation are retained; the source does not restrict hostnames to regex-safe characters.
7. **Mongoose 16: save error escapes its public callback.** With `versionKey:false`, an unchanged hydrated document receives `increment(); save(callback)`. Parent returns a VersionError through callback; the new delta path throws uncaught TypeError before that callback. No collection update occurs. This does **not** establish successful disabled-version increment in base. The invariant is callback error delivery; normal/default/custom version increments and modified documents are separate controls.

Exclude these seven PASS proposals. The evidence supports separately prepared source-regression FAIL proposals under the policy below; no source repair or new scored row was authored here.

## Warnings (Non-blocking but significant)

1. **Historical runtime limits.** Karma 15 retains one identical HTTPS fixture failure (`ee key too small`) in Node 24/OpenSSL; no TLS weakening and no HTTPS pass claim. Karma 14/22 have pending published records. Karma 17's published base runs fail 19 tests because the later suite calls the new DI interface against old source; these are not 19 independent defects. Independent real-injector calls establish the reachable base behavior. The prepared 18/20/21 suites use actual Sinon Date-only 2016 with real timers, and installed range-parser 1.3.0 is declared by the repair's ^1.2.0 dependency. Private extra filesystem controls use real time.
2. **Comments can be executable metadata.** Complete AST equality was insufficient for Karma DI, which reflects `fn.toString()`. Initial Karma 17 repair failed `No provider for basePath`; corrected comments restore native invocation. Karma 12's corrected comments likewise pass DI. Preserve `karma/17`, `karma/12`, initial identity receipts and effective directories separately; bind only corrected hashes. This was an adaptation error, not upstream gold or autonomy friction.
3. **Families and exposure.** Asset-pipeline Karma 11/12/15/16/17/18/19/20/21 share one transitive family. All Redis rows share client/transaction context. Mongoose 3/12/25 join existing document context; 1/16/19/22 should conservatively join that model/document family due the full bridge; 15 joins the existing array-definition family. Distinct methods or historical fixes do not establish independence. All source was inspected; reserve reviewer-output exposure honestly rather than claim source-unseen confirmation.
4. **Bounded contracts, not global clean proof.** Mongoose 1's single shared Schema gains version metadata when compiled top-level and that same object affects subdocuments. No independent-schema-copy guarantee was established, so this observation is not a blocker or gold. Redis uses real parser/queue/commands with controlled transport, no live Redis server; Mongoose uses real model/schema/hydration with external collection ports, no database. MongoDB regex-flag server validation and full browser/network operation are not claimed. Initial private harness corrections are retained and superseded, not counted as source defects.

## Candidate decisions and evidence

Counts are independent scenarios / four-stage observations. Full upstream hashes, source/adapted hashes, proposal SHA-256, runtime lock paths and per-case receipts are in `qualification-results.json` and `source-identities-effective.json`.

| Candidate | Decision | Mechanism | Actual parent → upstream change | Controls |
|---|---|---|---|---|
| karma 6 | Eligible | Repeated CLI flag precedence | 85328f3e → 31eb2c2c | 4 / 16 |
| karma 7 | Eligible | Runner exit trailer trimming | 3f1d934b → 3481500e | 7 / 28 |
| karma 9 | Exclude PASS | Literal parentheses versus extended-glob watch roots | 4858f39e → 438eb8dd | 6 / 24 |
| karma 11 | Eligible | Digest of processed content | 449b0f56 → 6cf79557 | 4 / 16 |
| karma 12 | Exclude PASS | Asset SHA cache identity | c786ee2e → 6e31cb24 | 5 / 20 |
| karma 14 | Eligible | Server load-error exit status | 7d2c1ae9 → 86e2ef22 | 4 / 16 |
| karma 15 | Eligible | Pending file-list promise and error handling | 184f12e4 → 892fa894 | 2 / 8 |
| karma 16 | Exclude PASS | HTTP byte ranges | 322f3b34 → 8b1b4b10 | 15 / 60 |
| karma 17 | Eligible | Dynamic context configuration and reflected DI | b765c33c → 8ef475f7 | 4 / 16 |
| karma 18 | Exclude PASS | File preprocessing cache and overlapping-pattern policy | bcfac8a4 → b1de55fe | 4 / 16 |
| karma 19 | Eligible | Preprocessor temporary-file extension | 9dbadb44 → c9a64d2f | 4 / 16 |
| karma 20 | Eligible | File-list modification throttling | 81976322 → cb2aafb3 | 2 / 8 |
| karma 21 | Exclude PASS | File-list path normalization | 09d64ed1 → fb841a79 | 3 / 12 |
| karma 22 | Exclude PASS | Error formatter own-origin handling | 3a618b3c → fbbeccf9 | 7 / 28 |
| redis 2 | Eligible | Multi/batch transport writes and buffering | 19ce6680 → 241e1564 | 5 / 20 |
| redis 3 | Eligible | Client construction without options | ce4a67bb → 304abe43 | 4 / 16 |
| redis 4 | Eligible | Pubsub restoration and readiness | b35a685c → 97db227a | 3 / 12 |
| redis 5 | Eligible | Parser reset across stream replacement | dffa8a6a → db0e8c53 | 3 / 12 |
| redis 6 | Eligible | Multi command callbacks and reply dispatch | ed57f440 → de0a9628 | 7 / 28 |
| mongoose 1 | Eligible | Top-level version-key schema registration | 564e0dc2 → fd0c9463 | 5 / 20 |
| mongoose 3 | Eligible | Document-array atomic updates | e85e4b72 → 6753ed14 | 6 / 24 |
| mongoose 12 | Eligible | Setter/getter and dirty tracking | 56a7e623 → c06383ce | 7 / 28 |
| mongoose 15 | Eligible | Regex options query casting | 4f087a96 → fb5d6027 | 6 / 24 |
| mongoose 16 | Exclude PASS | Explicit version increment without other dirty paths | 1e2f5bc6 → f5097a3d | 8 / 32 |
| mongoose 19 | Eligible | Schema lookup through positional/ref paths | 63b2ca09 → 3c7ab80a | 7 / 28 |
| mongoose 22 | Eligible | Remove-query condition casting and caller delivery | 5ab02388 → 2128c7a7 | 6 / 24 |
| mongoose 25 | Eligible | Empty-object minimization | b0b69d7c → 12c4ee33 | 7 / 28 |

### Karma 6 — eligible standalone PASS

Actual optimist repeated port/auto-watch/browser flags and scalar controls; last value wins. Mutation of the one-use argv array is source behavior, with no established immutability contract.

Evidence: [karma/6/independent-base.json](karma/6/independent-base.json), [changed endpoint](karma/6/independent-repair.json); corresponding `*-adapted.json` records agree. Source files: lib/cli.js. Family: corr-source-cli-option-precedence.

### Karma 7 — eligible standalone PASS

Actual trailer parser: empty/short/missing/wrong-tail and empty-test override boundaries; repaired output retains payload bytes. Split-trailer behavior is pre-existing, not a new finding.

Evidence: [karma/7/independent-base.json](karma/7/independent-base.json), [changed endpoint](karma/7/independent-repair.json); corresponding `*-adapted.json` records agree. Source files: lib/runner.js. Family: corr-source-runner-exit-trailer.

### Karma 9 — excluded as PASS

Valid @(a|b) and ?(a|b) patterns match the real minimatch input, but the new watcher root is a literal glob path. Actual pinned chokidar uses fs.stat on that path and performs no glob expansion.

Evidence: [karma/9/independent-base.json](karma/9/independent-base.json), [changed endpoint](karma/9/independent-repair.json); corresponding `*-adapted.json` records agree. Source files: lib/watcher.js. Family: corr-source-watch-glob-parentheses.

### Karma 11 — eligible standalone PASS

Real fs/crypto checks for binary, empty, unchanged and transformed content; digest follows processed bytes and retained controls.

Evidence: [karma/11/independent-base.json](karma/11/independent-base.json), [changed endpoint](karma/11/independent-repair.json); corresponding `*-adapted.json` records agree. Source files: lib/preprocessor.js. Family: corr-source-karma-asset-pipeline-context.

### Karma 12 — excluded as PASS

No configured preprocessors: PNG bytes 89504e470d0a1a0aff become efbfbd504e470d0a1a0aefbfbd. New unconditional UTF-8 conversion sets file.content, which the source-files consumer serves. Corrected comments now preserve actual DI invocation and SHA context output.

Evidence: [karma/12-effective/independent-base.json](karma/12-effective/independent-base.json), [changed endpoint](karma/12-effective/independent-repair.json); corresponding `*-adapted.json` records agree. Source files: lib/middleware/karma.js, lib/preprocessor.js. Family: corr-source-karma-asset-pipeline-context.

### Karma 14 — eligible standalone PASS

Actual Server and BrowserCollection, with transport/launcher ports: SIGINT/SIGTERM default success, existing exit status and load-error status. No OS process was killed.

Evidence: [karma/14/independent-base.json](karma/14/independent-base.json), [changed endpoint](karma/14/independent-repair.json); corresponding `*-adapted.json` records agree. Source files: lib/server.js. Family: corr-source-server-load-error-exit.

### Karma 15 — eligible standalone PASS

Empty unrefreshed list and PromiseContainer callback-error handling verified. The unchanged historical HTTPS key fails OpenSSL on both endpoints; HTTPS compatibility is not claimed.

Evidence: [karma/15/independent-base.json](karma/15/independent-base.json), [changed endpoint](karma/15/independent-repair.json); corresponding `*-adapted.json` records agree. Source files: lib/file-list.js, lib/middleware/common.js, lib/web-server.js. Family: corr-source-karma-asset-pipeline-context.

### Karma 16 — excluded as PASS

Actual createServeFile and range-parser: first Buffer response for bytes=3-4 of éXYZ is YZ; the second cached string response becomes Y after repair. Range length is calculated before UTF-8 Buffer conversion.

Evidence: [karma/16/independent-base.json](karma/16/independent-base.json), [changed endpoint](karma/16/independent-repair.json); corresponding `*-adapted.json` records agree. Source files: lib/middleware/common.js, package.json. Family: corr-source-karma-asset-pipeline-context.

### Karma 17 — eligible standalone PASS

Eligible only for corrected comment-preserving endpoints. Real di.Injector initializes both endpoints; repaired handler observes replaced client/custom context/debug configuration. Initial stripped repair failed No provider for basePath.

Evidence: [karma/17-effective/independent-base.json](karma/17-effective/independent-base.json), [changed endpoint](karma/17-effective/independent-repair.json); corresponding `*-adapted.json` records agree. Source files: lib/middleware/karma.js, lib/web-server.js. Family: corr-source-karma-asset-pipeline-context.

### Karma 18 — excluded as PASS

Actual Pattern.compare and List.refresh: broad included=true pattern before specific included=false pattern newly includes nested/two.js. New preprocessing dedup bypasses the existing specificity policy; reversing order changes output.

Evidence: [karma/18/independent-base.json](karma/18/independent-base.json), [changed endpoint](karma/18/independent-repair.json); corresponding `*-adapted.json` records agree. Source files: lib/file-list.js. Family: corr-source-karma-asset-pipeline-context.

### Karma 19 — eligible standalone PASS

Actual preprocessing and private temp directory preserve renamed extension; no-plugin binary files retain source disk behavior.

Evidence: [karma/19/independent-base.json](karma/19/independent-base.json), [changed endpoint](karma/19/independent-repair.json); corresponding `*-adapted.json` records agree. Source files: lib/preprocessor.js. Family: corr-source-karma-asset-pipeline-context.

### Karma 20 — eligible standalone PASS

First notification, burst coalescing and synchronous listener removal verified with real timers. Reentrant removal yields two notifications and no retained file in both endpoints.

Evidence: [karma/20/independent-base.json](karma/20/independent-base.json), [changed endpoint](karma/20/independent-repair.json); corresponding `*-adapted.json` records agree. Source files: lib/file-list.js. Family: corr-source-karma-asset-pipeline-context.

### Karma 21 — excluded as PASS

Actual historical Glob returns three files for **/../*.js; new path.normalize collapses the glob to *.js and List.refresh returns one. Recursive glob and literal parent traversal controls retained.

Evidence: [karma/21/independent-base.json](karma/21/independent-base.json), [changed endpoint](karma/21/independent-repair.json); corresponding `*-adapted.json` records agree. Source files: lib/file-list.js. Family: corr-source-karma-asset-pipeline-context.

### Karma 22 — excluded as PASS

Actual launcher accepts bracketed IPv6 hostname in a valid URL. Unescaped hostname regex newly formats own http://[::1]:9876/base/file.js:1:2 as http://[::1]:9876file.js:1:2 instead of file.js:1:2.

Evidence: [karma/22/independent-base.json](karma/22/independent-base.json), [changed endpoint](karma/22/independent-repair.json); corresponding `*-adapted.json` records agree. Source files: lib/reporter.js. Family: corr-source-error-url-host-identity.

### Redis 2 — eligible standalone PASS

Actual public Multi with legacy buffer queue and native cork, real binary RESP parser, callbacks, empty batch then next command and prepared pressure controls.

Evidence: [redis/2/independent-base.json](redis/2/independent-base.json), [changed endpoint](redis/2/independent-repair.json); corresponding `*-adapted.json` records agree. Source files: index.js. Family: shared Redis client/transaction context.

### Redis 3 — eligible standalone PASS

Omitted/null options and actual parser GET reply; configured returnBuffers retained.

Evidence: [redis/3/independent-base.json](redis/3/independent-base.json), [changed endpoint](redis/3/independent-repair.json); corresponding `*-adapted.json` records agree. Source files: index.js. Family: shared Redis client/transaction context.

### Redis 4 — eligible standalone PASS

Real RESP acknowledgments restore channels with spaces, empty names and Unicode; queue drains and ready fires once. Prepared patterns/pubsub restoration retained.

Evidence: [redis/4/independent-base.json](redis/4/independent-base.json), [changed endpoint](redis/4/independent-repair.json); corresponding `*-adapted.json` records agree. Source files: index.js. Family: shared Redis client/transaction context.

### Redis 5 — eligible standalone PASS

Partial bulk/array/integer parser input followed by stream recreation: parser resets, old listeners are removed and replacement-stream reply reaches callback.

Evidence: [redis/5/independent-base.json](redis/5/independent-base.json), [changed endpoint](redis/5/independent-repair.json); corresponding `*-adapted.json` records agree. Source files: index.js. Family: shared Redis client/transaction context.

### Redis 6 — eligible standalone PASS

Real Multi replies: success/null/error, present/absent per-command callbacks and callback enqueuing a next command. Prepared queue/pressure controls retained.

Evidence: [redis/6/independent-base.json](redis/6/independent-base.json), [changed endpoint](redis/6/independent-repair.json); corresponding `*-adapted.json` records agree. Source files: lib/multi.js. Family: shared Redis client/transaction context.

### Mongoose 1 — eligible standalone PASS

Default/custom/disabled top-level version key and explicit version type controls pass. Reusing the same Schema as both model and subdocument exposes shared schema mutation; no independent-copy isolation contract was established, so this is not an exclusion.

Evidence: [mongoose/1/independent-base.json](mongoose/1/independent-base.json), [changed endpoint](mongoose/1/independent-repair.json); corresponding `*-adapted.json` records agree. Source files: lib/model.js, lib/schema.js. Family: existing Mongoose model/document context (union required).

### Mongoose 3 — eligible standalone PASS

Hydrated document-array edits and falsey pull values; ordinary parent unset and nested edit retained.

Evidence: [mongoose/3/independent-base.json](mongoose/3/independent-base.json), [changed endpoint](mongoose/3/independent-repair.json); corresponding `*-adapted.json` records agree. Source files: lib/document.js. Family: existing Mongoose model/document context (union required).

### Mongoose 12 — eligible standalone PASS

Optional/Mixed same-value dirty tracking, undefined parent path and getter suppression during construction; actual schema/model receivers.

Evidence: [mongoose/12/independent-base.json](mongoose/12/independent-base.json), [changed endpoint](mongoose/12/independent-repair.json); corresponding `*-adapted.json` records agree. Source files: lib/document.js. Family: existing Mongoose model/document context (union required).

### Mongoose 15 — eligible standalone PASS

Actual query casts empty and configured regex options, nested $not and ordinary $in. MongoDB server acceptance of every flag is outside this no-DB casting test.

Evidence: [mongoose/15/independent-base.json](mongoose/15/independent-base.json), [changed endpoint](mongoose/15/independent-repair.json); corresponding `*-adapted.json` records agree. Source files: lib/schema/array.js. Family: existing Mongoose array-definition context.

### Mongoose 16 — excluded as PASS

With versionKey:false, hydrated unchanged doc.increment(); doc.save(callback) changes from callback VersionError to uncaught TypeError before callback. Base did not successfully increment: the verified invariant is callback error delivery, not successful versioning.

Evidence: [mongoose/16/independent-base.json](mongoose/16/independent-base.json), [changed endpoint](mongoose/16/independent-repair.json); corresponding `*-adapted.json` records agree. Source files: lib/model.js. Family: existing Mongoose model/document context (union required).

### Mongoose 19 — eligible standalone PASS

Positional array, referenced String and nested numeric paths; Mixed deep paths and unknown schema guard retain behavior.

Evidence: [mongoose/19/independent-base.json](mongoose/19/independent-base.json), [changed endpoint](mongoose/19/independent-repair.json); corresponding `*-adapted.json` records agree. Source files: lib/model.js. Family: existing Mongoose model/document context (union required).

### Mongoose 22 — eligible standalone PASS

Actual Query reaches external collection.remove with cast filters; $or/chained conditions work and CastError prevents driver invocation. Null/undefined empty conditions retain historical all-document semantics.

Evidence: [mongoose/22/independent-base.json](mongoose/22/independent-base.json), [changed endpoint](mongoose/22/independent-repair.json); corresponding `*-adapted.json` records agree. Source files: lib/model.js. Family: existing Mongoose model/document context (union required).

### Mongoose 25 — eligible standalone PASS

Actual toObject minimization preserves Date/RegExp/Buffer/ObjectId and handles empty/nested/array Mixed values. Dataset repair differs from original upstream only by two blank-line trailing spaces; AST identity verified.

Evidence: [mongoose/25/independent-base.json](mongoose/25/independent-base.json), [changed endpoint](mongoose/25/independent-repair.json); corresponding `*-adapted.json` records agree. Source files: lib/document.js. Family: existing Mongoose model/document context (union required).

## Data Flow Analysis

Original Git first parent and published changed commit → immutable extracted complete source modules → normalized complete CommonJS factory → invocation with actual module/exports/require/filename/directory → historical framework caller → external observations and assertions. Karma private-variable tests use exactly the normalized factory body inside the original VM-style harness, with prefix/suffix checked; they do not pretend private functions were public APIs. Redis replies are real binary RESP parsed by the real client. Mongoose methods are reached through real model/document/query objects. Supplied package and receiver ports are explicit; no fake parser or schema implementation supplies the label.

`source-identities.json` preserves initial bytes, `source-identities-effective.json` binds the corrections. Complete AST identity removes only location/raw-spelling metadata, retaining directives and executable bodies. The reflected-comment counterexample is why semantic controls accompany AST checks. Assertions are in private harnesses and `finalize-critique.py`, outside fixture source. No new consumer path, synced asset or backend/client trust boundary is introduced.

## Configuration Matrix

| Configuration | Expected behavior | Observed scope | Correct? |
|---|---|---|---|
| Historical Karma full CommonJS invocation | Native dependencies and DI contracts retained | Complete source or exact factory body; actual installed packages | Qualified subset yes; six source exclusions |
| Historical reflected Karma parameters | Annotation comments survive normalization | Corrected 12/17 real injector controls match source | Yes for effective endpoints |
| Karma cached UTF-8 / overlapping globs / IPv6 | Source byte/path/policy contracts retained | Concrete introduced failures | No; excluded PASS |
| Redis stream reset, pubsub, transaction callbacks | Real queue/parser agree across source and adaptation | EventEmitter transport, real RESP, no external server | Yes within scope |
| Mongoose casting, hydration and no-DB saves | Real framework caller preserves callback and mutation behavior | Native models with collection observation ports | Seven eligible; 16 excluded |
| devkit consumer monorepo, no config, other source layout | No production behavior changed by critique | No installer/runtime files changed | Not applicable to private evidence artifacts |

## Standalone FAIL admission-policy assessment

The seven excluded clean candidates have actual original fix-parent → published endpoint lineage and independently reproduced introduced behavior. They may support **separate standalone FAIL proposals**, without claiming any clean sibling or later repaired endpoint. The new defect label is **agent-verified source regression evidence**; BugsJS supplies the historical source/fix lineage, not this new failure's human label. Existing Targets do not impose a universal third endpoint or upstream acknowledgment on every standalone FAIL; their pass/fail/pass requirement concerns matched repair controls. The 2026-09-13 decision note now states this application explicitly.

This is not permission to relabel by row count: use the exact source contract and witness, source/adaptation equivalence, real fixture reachability, native coverage/privacy/twin/family checks and explicit provenance. Preserve the intended published correction as a feature control. Do not duplicate already represented later-repair families such as 260/261/sparse. Karma 12 requires its effective comment-preserving endpoints (now verified); Mongoose 16 must describe callback error escape rather than falsely claim base success. Karma 17's initial comment removal and Mongoose 1's unestablished isolation expectation are not production gold candidates. No proposals or admissions were made here.

## Frame second opinion

The strongest opposing frame is that selecting published fixes and checking their target tests merely rewards source archaeology while introducing false clean labels; ported old frameworks might further manufacture behavior. That would invalidate admission by supply. The objection is rebutted for the qualified subset by pinned original first parents, complete module identities, actual-framework callers and independent boundary controls that rejected seven published fixes and caught a real normalization mistake. The corpus objective remains sound only with those exclusions and conservative source-family disclosure. No new preparation framework is needed; the existing admission gates are the right layer.

## Missing Considerations

No finite boundary suite proves absence of all defects. The evidence should travel with any proposal and retain runtime limitations, source exposure and the existing label-noise bound. Later full frozen reviewer evaluation is the parent's separate task; nothing here establishes reviewer quality or independent confirmation performance.

## What's Good

- Actual fix parents anchor every clean candidate; no fabricated pre-introduction success or pair is claimed.
- Historical runtimes and full source modules retain real callers and package behavior.
- Corrected comment semantics are verified with the actual injector and initial failure evidence is preserved.
- Seven target-passing published repairs were rejected using concrete adjacent failures rather than narrowing contracts.

## Recommended Path Forward

1. Natively consider the twenty eligible PASS candidates using effective Karma 17 hashes and the recommended family unions; retain all exclusions and unchanged runtime failures.
2. If useful for coverage, prepare the seven source-anchored standalone FAIL candidates separately with precise invariant/source-label disclosure and native checks; do not invent repair pairs or duplicate existing families.
3. Preserve the exact evidence identities, source exposure and 13.9% historical label-noise bound before corpus freeze and later measurement.

## Research References

All critical claims were verified from local pinned primary source and execution. External web research is unnecessary for these source-specific reproductions.

- `governing-context/corpus-rows-admitted-by-coverage-cell.md` and `governing-context/benchmarks-grow-from-telemetry.md`: native admission and source-label rules.
- `source-identities-effective.json`: full original upstream refs, module hashes, runtime identities and corrected proposal binding.
- `contract-sources/`: actual watcher filesystem behavior, pattern ranking, middleware consumers, launcher URL generation, DI reflection and Mongoose source documentation.
- `independent-observations.json`, three `*-edge-controls.cjs` files and `run-edges.py`: executable source/adaptation controls and exact outcomes.
- `karma12-effective-identity.json`, `karma17-effective-identity.json`: corrected source comments, AST/proposal bindings.
- `qualification-results.json`: machine-readable decisions, mechanisms, counts and standalone-FAIL policy.
- `edge-cases.json`: eleven atomic covered normal/failure/timing cases for downstream reuse.
