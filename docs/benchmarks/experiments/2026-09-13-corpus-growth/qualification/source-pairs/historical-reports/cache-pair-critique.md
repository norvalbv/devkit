# Source-conformance critique: cache resource identity

**Verdict:** PROCEED with the explicitly agent-derived repaired postimage.
**Date:** 2026-09-13.
**Proposal:** Qualify one Shields request-cache bug/repair pair with the complete request handler and actual LRU implementation.

## Executive summary

The proposed gold is anchored to a real introducing change: the original handler keeps different resource paths and output formats separate, while the new cache-key template accidentally includes the literal text `match[0]`. The observed upstream repair restores interpolation but still loses a declared `__proto__` query. The proposed clean postimage honestly combines that observed interpolation fix with an agent-derived null-prototype query dictionary.

The pair is source-qualified under the recorded controls. Seventy-two independent full-source/actual-LRU versus adaptation comparisons agree across base, bug, observed repair and derived repair. No additional introduced repaired-side correctness finding was established. No corpus admission, raw edit, production edit, ticket, or model call was made by this critique.

## Feasibility and alignment

**Feasibility:** Confirmed for the selected operation and disclosed ports.

The owned worktree's `guard.config.json` declares `cli` and `gate-engine` roots, no application frontend/backend split, and W-3 consumer-relative toolkit execution. These private controls introduce no consumer-layout assumption or product trust-boundary change.

The decision log is present. A topic query retrieved the already loaded `benchmarks-grow-from-telemetry`, `corpus-rows-admitted-by-coverage-cell` and `reviewer-claim-measurement` Targets. The source qualification rule expressly allows adapted repaired siblings while requiring source anchoring, an invariant that distinguishes base/bug/repair, preserved references and honest exposure. It also states: “A passing targeted control establishes that invariant, not absence of all other introduced defects.” This pair applies that distinction by withholding the observed upstream repair as clean and identifying the additional repair as agent-derived.

| Atomic claim | Target relationship | Evidence |
|---|---|---|
| Resource identity regresses in the actual new cache-key expression | Implements source-grounded gold qualification | Introducing Git parent and complete original source verified; different resources/formats pass/fail/pass |
| The repaired postimage is observed interpolation repair plus a disclosed agent extension | Implements adapted-repair allowance | Exact derived source differs only by `Object.create(null)` |
| The whole selected repaired change retains declared-query filtering and caching | Implements whole-clean/feature controls | Filtering, prototype keys, network, timeout, expiry, clearing and capacity controls |
| One pair represents one cache-resource mechanism | Implements family accounting | Shared common base and caseId, explicit variantOf, no extra variants |
| Source exposure and local ports do not establish independent truth | Implements measurement honesty | No reviewer outcome inspected; boundaries recorded below |

No Target contradiction or silent reversal was found. `check-alignment scan` was run and mapped the current staged corpus/review scopes. That deterministic scan is not semantic approval; the model-based gate was not invoked under the no-model assignment.

**Frame second opinion:** The strongest objection is that changing a normal object to a null-prototype dictionary could conceal an API break, or that an upstream fix should have been sufficient. The latter is refuted by the declared `__proto__` source control. For the former, the source explicitly defines the handler input as declared/global query fields; its inspected badge-data consumer reads those fields without requiring inherited object methods. A source search found no direct `queryParams`/`query` prototype-method consumer in the inspected implementation. The derived dictionary retains declared `constructor` and `hasOwnProperty` field values and preserves source behavior on all additional controls. There is no concrete evidence of an introduced consumer break, and inventing a ban on declared prototype-sensitive names would be the wrong response.

**FRAME_META:** SOUND.
**UX/DX impact:** None from private artifacts. The derived repair preserves the documented declared-query contract without changing the authoritative operation or exposing assertions to the reviewer.

## Source identity and natural diff

`source-identities.json` verifies six complete source endpoints against Git blobs:

- Base: `7153490ef95e68560987f401f645cd1e3089c33b`.
- Introduction: `446d4ce21e1f115b47ab7213e00fd3ea3b400689`.
- Observed repair: `73472d0be8f570955140c7399d785322aad5b1d7`.

The base is the actual introducing commit's parent. Both `lib/request-handler.js` and `lib/lru-cache.js` match their recorded Git contents. The LRU source is byte-identical across all three original stages. The prepared fixture maps match their proposals exactly, share one base, and have nonempty gold and repair diffs.

The agent-derived source is exactly the observed repair with the single substitution:

```js
const filteredQueryParams = Object.create(null);
```

The original interpolation fix remains intact. The complete handler control flow and the actual LRU are retained in the fixture; the fixture does not silently substitute a corrected LRU. The module's test-only `_requestCache` exposure is omitted from the returned fixture API, while `handleRequest` and `clearRequestCache` remain. This does not change the tested production operation.

The genuine installed query serializer is `query-string` 5.x; its exact version is recorded in `cache-observations.json` and the runtime lock hash in `source-identities.json`. Source comments and package context identify the upstream as CC0; no private source is being presented as public upstream material.

## Preserved invariant and new feature

With two requests for `/first.svg` and `/second.svg` using identical query parameters, the base invokes the vendor handler twice. The bug invokes it once and returns the first cached payload for the second resource. Both the observed and derived repairs invoke it twice. Different output-format paths show the same source-backed separation. Assertions are external to the fixture.

The legitimate new behavior remains: declared custom query values participate in the cache key and the service receives only declared/global fields. Stable query ordering shares a cache entry; escaped values preserve identity; an undeclared query is excluded. The derived repair additionally preserves a declared `__proto__` value and separates two different values of it. Base's earlier omission of custom query values from its cache key is recorded as preexisting behavior, not the gold invariant.

## Independent controls and data flow

`cache-controls.mjs` executes **18 scenarios at four stages: 72 comparisons**, with zero source/adaptation discrepancies. It uses the complete recovered or explicitly derived source handler and actual LRU, then compares the prepared full module under the same external ports.

| Source → sink | Control configurations | Result |
|---|---|---|
| Resource match + serialized declared fields → cache key → response | Different resources, formats, prototype values, canonical escaped ordering | Intended source regression isolated; repair preserves identity |
| Query fields → filtered handler input | Declared fields, unknown fields, `__proto__`, `constructor`, `hasOwnProperty` | Derived dictionary preserves valid declared values and filtering |
| maxAge/query + request clock → response headers | Valid numeric and invalid maxAge, repeated cached request | Header behavior matches source |
| Cache API/LRU → lookup and eviction | Explicit clear; 1001 distinct resources followed by the evicted first resource | Base/repairs call handler 1002 times; bug's resource collision calls it once |
| Vendor callback + timer → response/fallback | No initial cache, existing stale cache, timeout, late completion | Fallback matches source and late completion does not double-send |
| Domain-bound asynchronous failure → log + timeout fallback | Vendor callback throws asynchronously | Error/fallback behavior matches source |
| Network adapter → cache interval and callback | String URI, options object, explicit options/UA, network error, vendor max-age | Arguments, callback results and learned interval match source |
| Existing cache entry → refresh | Payload changes after expiry | Same preexisting LRU behavior in all stages; no invented clean claim |

The parent's 28 earlier comparisons remain valid evidence and include the observed repair's prototype-key failure. This critique supplements them rather than replacing or silently rewriting them.

## Reached consumers and honest ports

The original source documentation requires services to declare custom fields and permits handler-function shorthand. The inspected upstream tests exercise both forms, identical requests, standard fields, ignored unknown fields and declared custom fields. The introducing commit also updates relevant server registrations. The fixture's caller follows the same options/shorthand boundary.

The source badge-data consumer reads declared/global fields and turns `link` into an array; it does not require an ordinary object prototype. The source result-sender is format-dependent rendering/response plumbing. Those dependencies remain external ports in the fixture, together with network, analytics and logging. The controls preserve business payload/format identity and call behavior; they do not claim SVG/raster rendering correctness, real network availability, Camp HTTP integration, or a historical Node deployment.

Clock and timer ports make 25-second failure schedules deterministic. Native Node domains and asynchronous callbacks are exercised. Only the actual handler's unit-capacity LRU mode is reached; the unused heap heuristic is not independently qualified. The original code and fixture both retain it unchanged.

## Critical issues

None for the explicitly derived repaired postimage. The **observed upstream repair alone remains unqualified as clean** for the declared prototype-key input; the current proposal already discloses and addresses that fact.

## Warnings and limits

1. **Preserve the repair origin.** Keep the exact original base/introduction/observed-repair identities and the derived-source hash in the admission receipt. Do not shorten the provenance into “upstream repair verified clean”; the null-prototype dictionary is an agent extension.
2. **Do not turn preexisting LRU behavior into another gold or a repair blocker.** The unchanged LRU `set` method does not replace an existing slot's value. Refresh observations therefore retain old cache metadata in every stage. This is visible existing source behavior, outside the introduced cache-key/dictionary change. The LRU is present unchanged in both base and staged maps, so it is not an added hidden dependency or a new defect caused by this repair.

Source/behavior verification is not independent human ground truth. Family/privacy/native admission and frozen comparison controls remain the parent's responsibility; no score or model-output assessment was performed here.

## Recommended path

1. Carry this one pair forward using the proposed derived repair and existing native admission.
2. Preserve the observed repair's limitation and exact one-line derivation in provenance, rather than manufacturing an upstream-clean claim.
3. Keep this family intact for holdout/accounting and retain the external control receipts.

## Evidence artifacts

- `source-identities.json`: six source endpoints, three fixture-map identities, true introducing parent, unchanged LRU and exact derived delta.
- `cache-controls.mjs`: independent executable original/derived-source versus fixture controls.
- `cache-observations.json`: all 72 comparison results, runtime/serializer identity and explicit operation boundary.
- `edge-cases.json`: six risks and thirteen atomic controls.

Run with `LOCAL_PATH`. Every new artifact is confined to the assigned private `cache-pair-critique/` directory. Source files, builders, proposals and repository artifacts remain unchanged by this critique.
