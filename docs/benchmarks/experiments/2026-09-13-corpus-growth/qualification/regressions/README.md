# Population and ESLint source qualification replay

This bundle publishes source-conformance evidence for nine admitted population rows and four ESLint regression families. It makes no model calls and never edits a corpus or source clone. It uses the existing public qualification runtime helper; it does not add a benchmark runner.

The corpus is pinned to SHA-256 `fa62708388345fcf776bad30811a9aa8641b68d00219b104ff19dec29caf4b9e` (285 rows). Admission is six population PASS rows, three population source-regression FAIL rows, four ESLint FAIL rows and the padded-blocks PASS sibling. The other three later ESLint repairs are **target-specific evidence only** and are not clean or paired corpus rows.

## Dynamic verification

`eslint-regression-replay-results.json` records a successful fresh replay on the admitted corpus with Node v24.19.0: **240 target observations + 546 independent observations = 786**, and **393 exact source/adaptation comparisons**. Four historical cores were reconstructed from the specified local Git clone and four frozen npm locks installed with `npm ci --ignore-scripts`. Every admitted fixture input was read from the canonical corpus and hash-checked. Actual outputs matched the complete expected observations, including defects in rejected later endpoints.

Population edge controls have 192 source/adaptation observations from the independent qualification. The parent integrates and dynamically replays these controls using the existing public `replay-runtime.py`; this bundle does not claim that an identity check itself reran those controls. `population-edge-manifest.json` binds all nine admitted row IDs and their exact fixture hashes.

## ESLint replay

Requirements: Python 3, Git, Node v24.19.0 and npm on PATH; a local read-only BugsJS/eslint clone; the devkit repository containing the pinned corpus and its public qualification helper. Initial npm installation needs registry access. No live application, database or credentials are used.

```sh
python3 replay-eslint-regressions.py \
  --repository "$DEVKIT_REPO" \
  --source "$BUGSJS_ESLINT_CLONE" \
  --work "$NEW_DISPOSABLE_DIRECTORY" \
  --output "$REPLAY_RESULT_JSON"
```

The work directory must not exist. It receives source snapshots, temporary endpoint files, install logs and dependencies; it is disposable. The read-only helper is loaded from `docs/benchmarks/experiments/2026-09-13-corpus-growth/qualification/replay-runtime.py` inside the supplied repository. Python bytecode writes are disabled. No private paths or symlink targets are required. The helper supplies the existing archive extraction/hash implementation; all family-specific checks live in this bundle.

`eslint-regression-manifest.json` contains exact source endpoints, real core commits, archive hashes, package-lock hashes, license paths and canonical corpus pointers. Rejected repair adaptations are stored under `target-only/`; original endpoint sources are obtained from their exact Git refs. The same historical parser/context/fixer serves all three endpoints. `eslint-regression-target-controls.cjs` reproduces the original qualification targets; `eslint-regression-edge-controls.cjs` independently exercises the full changed rule, policy boundaries and real fixes. Both compare complete diagnostic and fix outcomes, not only pass counts.

## Population integration

Use `population-edge-manifest.json` to attach each case's `edgeControl` and `edgeExpected` fields to the corresponding entry in the existing public `runtime-manifest.json`. The control interface matches that runtime runner:

```sh
node mongoose-population-edge-controls.cjs NUMBER CASE_DIRECTORY STAGE OUTPUT_JSON
```

`CASE_DIRECTORY/source` must already contain the selected original source or corpus-adapted module mounted by the existing runner, with its real historical dependencies. `STAGE` is `base`, `repair`, `base-adapted` or `repair-adapted`; the runner owns substitutions. The control uses actual model/schema/document/query receivers and controlled collection callbacks. It does not simulate MongoDB server projection, sorting or limit enforcement. The meaningful limit/projection evidence is the outgoing query contract.

The supplemental manifest follows the existing runner's normalization interface. This population subset has no private path-valued outcomes; no semantic fields are removed. Parent source/adaptation observations must agree **before** expected-record path normalization. Source locations and stack traces are not label evidence. Complete current expected observations are included in `edgeExpected`; canonical IDs are final, not pending placeholders.

## Evidence and limitations

- `qualification-evidence.json` gives admitted IDs, source identities, findings, exact target stage outcomes and family roles.
- `source-conformance-report.md` is the bounded independent qualification report. Original per-case paths are logical identifiers: population stage records map to `population-edge-manifest.json` → `edgeExpected`; ESLint stage records map to `expected/FAMILY/{targets,edges}.json`. Exact combined independent observations are also retained.
- `source-identities.json`, `eslint-source-identities.json` and `ast-conformance.json` preserve full source/adaptation hashes. Runtime paths are portable manifest-relative locations, not references to the original machine. Mongoose 18's dataset repair changes one comment capitalization and Mongoose 24 adds one blank line relative to upstream; whole executable ASTs match.
- `expected/` stores every original target and independent ESLint outcome. Rejected repair failures are expected evidence, not successful clean qualification.
- `constructor-effect-control.cjs` independently demonstrates the effect lost by deleting the falsely reported rest-pattern constructor.
- `artifact-hashes.json` inventories public bundle files; disposable replay directories and caches are not included.

All source was inspected during qualification. Labels for newly found regressions are agent-verified source evidence, not claims that BugsJS or upstream independently labeled those new defects. No independent human-ground-truth, source-unseen confirmation or reviewer-quality result is claimed. Shared source contexts remain transitive families; only explicit repair endpoints and valid legacy pairs enter pair-discrimination metrics.
