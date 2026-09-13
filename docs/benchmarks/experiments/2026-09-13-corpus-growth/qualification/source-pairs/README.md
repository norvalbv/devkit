# Portable source-conformance replay: fifteen admitted rows

This bundle replays the fifteen already-admitted public-source rows listed in `manifest.json` against the frozen 285-row corpus. It contains no reviewer invocation or benchmark score. The full source was exposed during agent qualification; these observations are bounded regression evidence, not independent human labels or unseen production data.

Run with Node **v24.19.0**, npm, Python 3 and Git:

```sh
python3 replay.py \
  --repository /path/to/devkit \
  --sources /path/to/local-bugsjs-clones \
  --work /path/to/new-disposable-directory \
  --output /path/to/replay-receipt.json
```

The source directory must contain read-only Git clones named `bugsjs-express`, `bugsjs-eslint`, `bugsjs-hessian`, `bugsjs-shields` and `bugsjs-mongoose`, with the manifest's commits available. Source refs are read locally; npm needs access to the lock-file package URLs or its populated package cache. The exact repository corpus hash is required. Output and work paths are user-selected, and work must not already exist. The script never deletes work automatically.

The replay imports only the existing `qualification/replay-runtime.py` archive/hash helper from the repository. It extracts pinned source archives into work, installs nine frozen npm runtimes with `npm ci --ignore-scripts --no-audit --no-fund --legacy-peer-deps`, and loads adapted bytes directly from canonical corpus rows. Original source modules and admitted fixtures have full SHA-256 bindings. Getter source spans replace the original AST-discovery step only; the complete source file hash is checked before extracting and executing each getter. The sparse validator's complete function is extracted using a byte range bound to its complete source and operation hashes. No production dependencies or install scripts are changed.

## Included source contexts

| Context | Rows | Source/adaptation control observations |
|---|---:|---:|
| Express middleware argument/path handling | 2 | 120 |
| Express parameter-result cache | 2 | 78 |
| Express IP subdomains | 1 | 432 |
| Express bracketed Host port | 1 | 248 |
| Hessian null decoded key | 1 | 120 |
| Shields resource cache | 2 | 200 |
| ESLint export declarations | 2 | 162 + 300 published tests |
| Mongoose sparse validation | 2 | 90 |
| ESLint statement separator | 2 | 168 + 804 published tests |

Total: **1,618 target/independent observations + 1,104 published-test observations = 2,722 observations / 1,361 source-adaptation comparisons**. One comparison means executing corresponding source and adaptation, not an additional test. Historical buggy-state test failures are retained; all admitted repaired states satisfy their qualified repair controls. The JSON expected observations are the preexisting qualification evidence, not generated from the replay's output.

## Contracts and limits

- Express uses complete historical libraries and loopback HTTP. Middleware registration is installed on the actual application receiver. Parameter caching is scoped to the real per-dispatch `called` object; the older incorrect request-keyed harness appears only as a labeled counterfactual in the independent observations.
- Express accessor controls preserve actual accessor bodies and request/app ports, including a real historical Host getter where the subdomain boundary requires it. `net.isIP` is the actual Node API.
- Hessian uses its real binary decoder and lock-pinned packages. Its clean row is a standalone corrective change whose base already fails on null keys. The quarantined Hessian map-projection pair contributes no row, fixture or executable replay here; its exclusion remains in the historical review.
- Shields executes the complete original handler plus actual LRU with declared rendering, analytics, clock and network ports and genuine `query-string`. Its admitted clean repair is **agent-derived**: the observed interpolation fix plus `Object.create(null)` for declared query keys. The unchanged upstream repair remains an explicitly unclean comparison endpoint because it drops a declared `__proto__` key. Cache-capacity observations retain call/output counts and first/last results rather than all 1,002 payloads.
- Mongoose executes the complete validation operation in native model/schema/document callers without a database. Fresh npm hoists two packages that historical source imports through nested paths; the manifest recreates the same two package-layout aliases as the qualified runtime. They point to the same lock-pinned `mongodb-core` and `bson`, with the real BSON JavaScript fallback; native installation is disabled. The initial packaging failure and correction are preserved in `initial-portability-correction.json`.
- ESLint uses the complete original rule modules, actual historical core, parser, source-code fixer and full later-repair published RuleTester files. The earlier parent may lack new features or retain unrelated policy behavior; only the claimed target is required to pass at that parent. The semicolon tests preserve the distinction between a syntax-invalid regex boundary and valid division parsing that changes the program's value.
- Exact source/adaptation outcomes and exact preexisting expected observations are checked separately. No timing exception is needed for these fifteen rows. The tests do not claim a live Redis/MongoDB server, real remote vendor behavior, or contemporary framework compatibility.

`historical-reports/` preserves sanitized full earlier review reports. Some discuss neighboring excluded or separately admitted cases; those contextual findings are not new admissions or additional replay rows. `source-module-identities.json`, `manifest.json`, `licenses/`, and `artifact-hashes.json` bind public source, complete fixtures, runtime locks, controls and notices. MIT notices are retained for Express, ESLint, Mongoose and Hessian; Shields is CC0 as recorded by its source license. Dependency packages retain their own licenses through their exact npm archives.
