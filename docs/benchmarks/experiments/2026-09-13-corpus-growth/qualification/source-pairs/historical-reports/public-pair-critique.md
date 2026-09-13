# Source-conformance critique: public library adaptations

**Verdict:** PROCEED for the two Express pairs and three standalone PASS repairs; retain the Hessian2 pair's exclusion.
**Date:** 2026-09-13.
**Proposal:** Qualify three public-source pairs, then three explicitly unpaired repair controls.
**Result:** Five eligible source mechanisms, yielding seven proposed rows. One additional two-row mechanism is unqualified and has been quarantined by the parent. No admission, production edit, raw-proposal edit or model call was performed here.

## Executive summary

The middleware-path and combined parameter-cache pairs preserve actual original-base/introducing-change/repaired behavior under complete-library HTTP controls. The three standalone corrective diffs also conform to their actual source, without claiming a passing pre-introduction base. The Hessian2 property/native-map pair does **not** have a clean repair: its new readonly `$map` metadata causes a valid encoded `$map` key to throw in both bug and repair, where base succeeds.

The parameter-cache fixture's per-dispatch factory is correct, but the first HTTP conformance harness reused it per request. A repeated-router-mount control demonstrated that discrepancy. The parent corrected the harness to use the original source's per-dispatch `called` object; source behavior and the correctly scoped adaptation agree.

## Feasibility and alignment

The worktree's `guard.config.json` declares `cli` and `gate-engine` source roots and W-3 consumer-relative toolkit execution, with no application client/server boundary map. These private source controls do not add consumer paths or application trust boundaries. Express and Hessian paths identify the inspected upstream implementations, not a presumed devkit layout.

The decision log is present. The loaded Targets include `benchmarks-grow-from-telemetry`, `corpus-rows-admitted-by-coverage-cell` and `reviewer-claim-measurement`. The qualification rule that targeted success does not establish absence of other introduced defects directly supports excluding Hessian2 after the `$map` control. The deterministic alignment scope scan ran during this critique chain; it is not semantic approval, and no model-based alignment gate was invoked.

### Standalone PASS controls do not reverse the paired-control rule

The September 5 Target says:

> Keep verdict-labeled telemetry and fix-anchored known-answer imports as the roots of corpus cases.

It then describes a particular derived-pair path:

> Agents may derive repaired PASS siblings from an existing source-anchored gold, explicitly marked adapted with variantOf, shared caseId and preserved original source references

and requires:

> The same invariant must pass in the base and repair and reproduce in the buggy postimage, with assertions outside judge-visible files.

The three standalone proposals do not use that derived-sibling claim. Each is a real source repair with `expected: PASS`, no `variantOf`, and explicit base/repair commit identities; its base intentionally contains the repaired defect. No new FAIL row or pre-introduction passing state is asserted. The native workflow also supports standalone clean rows: `docs/benchmarks/corpus-growth.md:36` describes standalone PASS decoys, and `corpus/twins.mts:66` treats an unlinked row as its own group. Existing native checks for the two Express standalone proposals report no problems. This is not an instruction to bypass remaining native checks for any row.

No exact rule prohibits the current standalone framing. Applying the paired invariant to these rows would invent a stronger rule than the quoted text and turn a known buggy repair-parent into a fictional passing base. Conversely, the absence of a gold sibling does not relax repaired-side cleanliness, source lineage, holdout grouping or exposure requirements. These rows must stay out of matched-pair discrimination denominators.

### Atomic alignment checks

| Claim | Classification | Outcome |
|---|---|---|
| Express8 preserves the original middleware operation while adding nested array support | Implements source qualification | Qualified |
| Express27/13/18 represent one cache mechanism with a later complete repair | Implements family accounting and source qualification | Qualified as one pair |
| Hessian2's observed repair is a whole-clean selected change | Contradicted by executed source behavior | Excluded; no Target reversal proposed |
| Three real standalone repairs can measure clean-diff acceptance without invented golds | Implements source anchoring; neutral to paired discrimination | Qualified under unpaired framing |
| Scope/exposure remains separate from independent truth | Implements measurement contract | Source exposure and agent verification disclosed |

**Feasibility:** Confirmed for the five eligible mechanisms; not established for a clean Hessian2 pair.
**UX/DX impact:** None from private artifacts. Excluding the Hessian2 repair prevents a valid reviewer finding from being scored as a false alarm.
**FRAME_META:** SOUND.

**Frame second opinion:** The strongest contrary case is that an observed fix should automatically be a clean control and that requiring an introducing-base witness for every repair would be more rigorous. Both claims fail here. The `$map` witness shows an observed fix can retain another introduced defect. The standalone repair proposals make a different, narrower claim—acceptance of an actual corrective diff—and explicitly leave the buggy parent buggy; no gold diagnosis or pair denominator is manufactured. The evidence therefore supports selecting the five qualified mechanisms while retaining the exclusion.

## Source identity and dependencies

`source-identities.json` independently checks **18 complete selected source file endpoints** against Git objects, records the Git blobs/content hashes, and captures the nine installed runtime lock identities for the paired libraries. All three introducing commits have the declared base as their actual Git parent; the declared bases are ancestors of both bug and repair revisions. The repaired Hessian2 decoder and Express8 application/flatten modules equal their recorded original-fix counterparts byte for byte. The three standalone base/repair source files likewise match their recorded BugsJS Git refs.

The dependency installations are pinned in the prepared `*-runtime/package-lock.json` files, and actual `node_modules` links are recorded. Controls run on local Node24, not on an independently reconstructed historical Node runtime. The inspected libraries identify their source as MIT licensed. Public source identity does not make the labels independent human ground truth.

## Per-candidate disposition

| Candidate | Disposition | Concrete evidence |
|---|---|---|
| `qualified-map-projection` / Hessian2 | **Not qualified: unclean repair** | A typed `java.util.HashMap` containing string key `$map` returns the ordinary property in base but throws a readonly-property TypeError in actual bug and repair. The adaptation reproduces the same result. |
| `qualified-middleware-path` / Express8 | **Eligible pair** | Empty path registration remains successful in base and repair and fails after the actual array-support introduction. Full method and recursive flatten closure match original-library registration and HTTP behavior; nested array feature remains. |
| `qualified-parameter-cache` / Express27/13/18 | **Eligible pair, one family** | Cache introduction loses route-skip outcomes and normalized parameter values; later observed repair preserves them and retains successful deduplication. The complete callback processor matches actual router HTTP behavior when its factory lifetime is per dispatch. |
| `corr-ip-address-subdomains-clean` / Express4 | **Eligible standalone PASS** | Actual accessor repair treats an IP as one host component rather than dotted subdomain labels, while retaining configurable offset behavior and domain handling. No pre-introduction base PASS is claimed. |
| `corr-bracketed-host-port-clean` / Express22 | **Eligible standalone PASS** | Actual Host getter finds a port separator after a closing bracket, preserving bracketed literals, ordinary hosts and trusted-proxy fallback. No gold sibling is claimed. |
| `corr-null-map-key-clean` / Hessian9 | **Eligible standalone PASS** | Actual source removes direct `key.toString()` and lets property-key coercion handle null. Its real buggy parent rejects null and repair accepts it. The older selected decoder has no introduced native `$map` metadata and passes the collision control that excludes Hessian2. |

The independent scripts record **400 source/adaptation comparisons**: 48 Hessian2 boundary cases, 27 Express middleware cases, 21 Express parameter cases, and 304 standalone repair cases. Additional historical harness-lifetime results remain alongside the parameter comparisons. Parent controls additionally establish each paired target and retained feature; this report does not replace those receipts.

## Confirmed exclusion: Hessian2 `$map` collision

In `public-datasets/hessian-2/repair/lib/v1/decoder.js:410`, recognized map types receive a hidden `$map` property through `Object.defineProperty`, without `writable: true`. The same strict-mode decoder later executes `result.$[key] = value` for string keys other than the narrow `this$<digits>` pattern.

`map-boundary-controls.mjs` supplies a real typed binary map envelope whose key is the valid string `$map` and whose value is `value`:

- Base: succeeds, exposing the ordinary `$map` property.
- Bug: throws `TypeError: Cannot assign to read only property '$map' of object '#<Object>'`.
- Repair: throws the same error.

This is not merely an adaptation discrepancy: all 48 extra binary-source/adaptation boundary controls match, and both actual repaired source and fixture retain the defect. The typed-map branch does not declare an encoded-key exclusion. The initial null/boolean target passing after repair is insufficient for a clean control. The parent has quarantined the two raw proposals unchanged. Do not narrow the input contract to exclude `$map`, silently replace the source repair, or promote only the target-passing observation as proof of whole-cleanliness.

## Corrected parameter harness lifetime

The actual `router.handle` allocates `paramcalled = {}` for each dispatch. The fixture says “Create one runner per router dispatch” and gives its closure the same lifetime. The original HTTP adaptation wrapper instead used a `WeakMap` keyed by `req`.

The independent scenario mounts the same router twice on `/mount` in one request. The parameter callback transforms the value to `normalized-<call-count>`. Actual repaired source invokes it twice, yielding `normalized-1` then `normalized-2`. The historical request-keyed wrapper invokes it once and reuses `normalized-1` on the second dispatch.

The correctly scoped wrapper keys modern runs by the original source's `called` object. Base has no cached state and can instantiate for each processor call. This matches the full library in all 21 parameter scenarios, including repeated dispatch. The parent has now updated both `build-parameter-cache-pair.mjs` and `adaptation-http-controls.mjs` to that scheme. No fixture source change or invented request-lifetime restriction was required.

## Whole-selected-change and caller analysis

- **Middleware:** the complete `app.use` method and its reached recursive flatten function are retained. The fixture is installed on the actual framework application receiver, preserving `lazyrouter`, router registration, mounted-child dispatch, prototype restoration and mount events. Extra controls cover multiple handlers, RegExp/array paths, nested error middleware, empty-path nested arrays, invalid elements, absent arguments, falsy path input, and a mounted app yielding to its parent. No introduced repaired finding was established.
- **Parameter cache:** the complete `process_params` closure is retained, with source layer keys and request parameters supplied by the actual router. Extra controls cover multiple asynchronous callbacks, repeated dispatch, changed values after route skip, missing optional parameters, duplicate parameter keys, same-value skips, and ordinary callback errors. The explicit factory supplies the dispatch lifetime. These related published bug reports remain one mechanism, not three independent pairs.
- **Subdomains:** the complete source accessor is retained with native `net.isIP`. Independent controls compose it with the same revision's actual source Host getter, rather than supplying only idealized host values. Offset 0/1/2/3/-1, normal domains, IPv4, bracketed IPv6, trusted/untrusted forwarded hosts, trailing-dot hosts and missing Host inputs are compared. Missing-Host exceptions are recorded as preexisting behavior, not an introduced repaired defect.
- **Host:** the complete getter is retained with the original request/app receiver ports. Controls cover ordinary hosts, empty/missing values, bracketed IPv6/zone/IPvFuture-shaped literals, explicit/empty ports, and trusted proxy fallback. This proves the selected source repair and neighboring behavior; it is not a claim that the historical framework validates every possible malformed HTTP header.
- **Hessian9:** the selected property-write loop is adapted from decoded key/value reads to an iterable. Binary controls cover null, boolean, numeric, empty and reserved-looking string keys for both default and named map types. `$map`, `constructor`, `toString`, `hasOwnProperty`, `__proto__` and `this$0` preserve the original older decoder behavior. Exception-class wrapping, stream framing and unrelated protocol versions are outside this selected projection, as disclosed by the source-loop adaptation. No additional introduced repaired finding was established.

## Configuration matrix

| Configuration | Expected source behavior | Verification |
|---|---|---|
| Ordinary/nested/invalid middleware arguments | Correct source disambiguation and error behavior | Original complete library versus extracted method, 27 comparisons |
| Mounted subapp yields to parent | Restore the parent request/response receiver context | Actual local HTTP request |
| Repeated mount of the same router | Independent parameter cache for each dispatch | Correct wrapper matches; old request cache discrepancy retained |
| Async/same/changed/optional/duplicate parameter values | Preserve callback outcomes, transformed values and deduplication | Actual local HTTP requests, 21 comparisons |
| Domain/IP plus offset and proxy policy | Match actual Host producer plus source subdomain accessor | 160 comparisons |
| Bracketed/nonbracketed/missing Host and forwarded headers | Preserve complete source Host getter behavior | 96 comparisons |
| Older decoded map properties | Correct null coercion without native-map metadata collision | 48 binary-source comparisons |
| New native map with encoded `$map` key | Existing accepted map should not throw due new metadata | **Fails repaired source; excluded**, 48 boundary comparisons total |

No monorepo/default-root variation is introduced by these isolated library methods. Filesystem and layout assumptions belong to private source recovery, not fixture product flows.

## Warnings and measurement limits

1. Keep standalone clean acceptance separate from pair-level discrimination. The Express accessor repairs and Hessian9 row do not establish an introducing regression witness. Their source notes and absent `variantOf` correctly preserve that limitation.
2. Preserve source receiver/dispatch boundaries in the fixture/provenance. Do not later describe exported methods as free functions, the parameter cache as per request, or the decoded-property projection as a complete protocol decoder. Native privacy/family/admission checks remain necessary and were not replaced by these local comparisons.

All comparisons are source-exposed agent verification. No reviewer output, paid benchmark, independent human adjudication or production-cleanliness claim is implied.

## Recommended path

1. Carry the two Express pairs and three standalone repairs forward using existing native admission. Preserve separate clean-only and pair denominators.
2. Retain the Hessian2 pair's quarantine and its concrete `$map` evidence. Any later explicitly agent-derived repair would need a new auditable qualification, not a claim that the observed upstream repair was clean.
3. Keep the corrected per-dispatch parameter harness and the historical discrepancy receipt. Keep related Express27/13/18 reports in one family and Hessian9 conservatively linked to the dictionary lineage if other rows from it are later admitted.

## Evidence artifacts

All paths are relative to this private directory:

- `source-identities.json`: Git/source endpoint identities, base ancestry, original-fix equality and runtime locks.
- `map-boundary-controls.mjs` / `map-boundary-observations.json`: 48 real-binary decoder comparisons and the source repair exclusion.
- `express-boundary-controls.mjs` / `express-boundary-observations.json`: 27 middleware and 21 parameter HTTP comparisons, with historical request-cache evidence.
- `standalone-repair-controls.mjs` / `standalone-repair-observations.json`: 304 accessor-chain and binary-source comparisons.
- `edge-cases.json`: six source-mechanism risks and thirteen atomic controls.

Run controls with `LOCAL_PATH`. External assertions, ports and temporary HTTP servers remain outside fixture source. The original versions and exact source refs remain under `public-datasets/` and `qualified-repair-only/`; no upstream or raw file was changed by this critique.
