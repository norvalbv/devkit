# Piece 1 — Generalize the structure engine (config-driven, declare-once)

> Durable design record (compaction-safe). Master plan: `~/.claude/plans/plan-mode-on-for-golden-curry.md`.
> Research: `docs/design/structure/research-auto-foldering.md` (committed in Piece 2).

## Goal

devkit's structure-lint is frink's six electron trees (renderer/main/shared/preload/socket/vercel),
`.tsx` only, encoded **twice** — once as the static `templates/electron/eslint.config.mjs` rule, once
as the imperative walkers in `cli/lib/generate/generate-structure-baseline.mjs` — hand-synced. Collapse
both onto ONE declarative spec in `guard.config.json`, drive both the emitted eslint rule and the
baseline walk from it. Result: works on ANY repo (incl. devkit's own `.mjs` `cli/`+`gate-engine/`).

## Architecture: declare-once-and-generate

```
guard.config.json `structure`   (the ONE spec = data)
        │
        ▼  gate-engine/structure/tree/grammar.mjs   (interpreter devkit ships = the generator)
        ├─► compileToEslint(treeSpec)  → createFolderStructure arg object  → eslint.config.mjs shim
        ├─► (emit eslint/domains.mjs from libDomains, for IDE ergonomics)
        └─► resolvePatterns(names, exts) → the {token}→regex table, extension-aware
        │
        ▼  gate-engine/structure/tree/walk.mjs
        └─► walkTree(treeSpec, absRoot)  → grandfather seed (baseline string[])
```
Single source → 3 derived artifacts → zero hand-sync. This generalizes frink's "rule + generator import
the SAME `domains.mjs`" idiom from *domain lists* to the *entire grammar*. `eslint.config.mjs` becomes a
thin shim importing the interpreter from `@norvalbv/devkit` and feeding it `guard.config.json` —
"ship the generator, never the data" (the eslint object shape is a peer-dep's, not devkit's).

## The `structure` config schema

Added to `gate-engine/config.mjs` `DEFAULTS` (`structure: { trees: [], walls: [] }`) + resolveGuardConfig
(deep-merge like `review`/`thresholds`). New helper `resolveTreeExtensions(cfg, tree)` = tree.sourceExtensions ?? cfg.sourceExtensions.

**Tree** = `{ name, root, sourceExtensions?, grammar, libDomains?, frozenDirs?, ignoredDirs?, entryAllowlist? }`
- `name` — baseline export id + eslint `structureRoot` label.
- `root` — repo-relative dir, resolved against consumer cwd (W-3), never `__dirname`.
- `sourceExtensions?` — overrides global for THIS tree; drives the eslint files-glob AND the `{token}` regexes.
- `grammar` — the folder-grammar node (below) — the ONE thing that replaces the 6 `make*Walker`.
- `libDomains?` — closed-vocabulary registries keyed by folder name (`{ lib: ["generate","husky"] }`); empty registry ⇒ existing domain folders grandfathered (verbatim current behavior).
- `frozenDirs?` — one-way-door dirs: every descendant grandfathered (frink's `'^$'` match-nothing).
- `ignoredDirs?` — never visited (eslint ignorePatterns + walker skip).
- `entryAllowlist?` — files allowed at the tree root.

**Grammar node** (subset of frink's `createFolderStructure` `structure`/`rules` shape + 2 devkit primitives):
```jsonc
{
  "files": ["index.ts", "{kebab_ts}", "{kebab_test}"],   // allowed leaf-file name-patterns
  "enforceExistence": "index.ts",                          // folder must contain this, else broken
  "folders": { "lib": { "domainOf": "lib", "recurse": "kebabModule" } },  // named child folders
  "recurse": "kebabModule",          // generic recursive rule for any other (kebab) subfolder
  "rootDomainOf": "@root",           // devkit primitive: this tree's OWN first-level folders ARE the vocabulary
  "rules": {                         // named recursive grammar fragments (frink's `ruleId`)
    "kebabModule": { "folderName": "{kebab_case}", "files": ["index.ts","{kebab_ts}","{kebab_test}"], "recurse": "kebabModule" }
  }
}
```
`{token}` vocabulary (`{kebab_ts}`,`{kebab_mjs}`,`{PascalCase}`,`{pascal_tsx}`,`{camel_ts}`,`{kebab_test}`,
`{test_file}`,`{any_css}`,`{any_json}`,`{kebab_case}` folder-name, …) lives in `grammar.mjs`, parameterized
by the tree's `sourceExtensions` — the SINGLE fix for hardcoded `\.tsx?$`.

**Wall** = `{ name, pattern, allowImportsFrom, errorMessage, wallClasses:[{match, widen}] }`. `wallClasses`
is an ordered first-match-wins list (`widen` may use `$1` capture refs) replacing the hardcoded
`crossProcess`/`frozenDirRe`/`featureRe` + the `classifyWidening` throw. Empty `walls` ⇒ generator
early-returns (no eslint scan).

## The 6 topology examples

**devkit-itself** (multi-export-tool, the dogfood):
```jsonc
"structure": {
  "trees": [
    { "name":"cli", "root":"cli", "sourceExtensions":["mjs","js"], "entryAllowlist":["index.mjs"],
      "ignoredDirs":["__tests__"], "libDomains":{ "lib":["generate","husky","install"] },
      "grammar":{ "files":["index.mjs"],
        "folders":{ "commands":{"recurse":"kebabModule"}, "lib":{"domainOf":"lib","recurse":"kebabModule"} },
        "rules":{ "kebabModule":{"folderName":"{kebab_case}","files":["{kebab_mjs}","{kebab_test}","{any_json}"],"recurse":"kebabModule"} } } },
    { "name":"gate-engine", "root":"gate-engine", "sourceExtensions":["mjs","js"], "entryAllowlist":["config.mjs"],
      "ignoredDirs":["__tests__","eval"], "libDomains":{ "@root":["co-occurrence","decisions","fallow","judge","ratchets","search-tool","sentry"] },
      "grammar":{ "files":["config.mjs"], "rootDomainOf":"@root", "recurse":"engineModule",
        "rules":{ "engineModule":{"folderName":"{kebab_case}","files":["{kebab_mjs}","{kebab_test}","{any_json}"],"recurse":"engineModule"} } } }
  ],
  "walls": []
}
```
(`{any_json}` because `gate-engine/co-occurrence/labels.json`. `gate-engine`'s 7 sub-engine dirs are the
`@root` vocabulary — adding an 8th engine = one `libDomains["@root"]` append.)

**frink-primitives** (component-lib): flat `src/`, no folders/domains/walls — the case the 6 walkers can't express:
```jsonc
"structure": { "trees": [ { "name":"primitives", "root":"src", "sourceExtensions":["ts","tsx"],
  "entryAllowlist":["index.ts","cn.ts"], "grammar":{ "files":["index.ts","cn.ts","{pascal_tsx}","{camel_ts}","{test_file}"] } } ], "walls": [] }
```

The other four fall out the same way:
- **electron** — 4 trees (main/renderer/preload/shared) each with grammar + `libDomains.lib`, plus renderer⊅main `walls` (today's hand-coded shape, now data).
- **nextjs app-router** — 1 tree `root:"src"`, `folders:{app,components,lib}`.
- **node-backend** — 1 tree `root:"src"`, `folders:{api,lib}`.
- **monorepo** — 1 tree per package, `root:"packages/<x>/src"` (future: `roots:["packages/*"]` glob).

## The ONE generic walker (`gate-engine/structure/tree/walk.mjs`)

`walkTree(treeSpec, absRoot)` — recursive descent carrying a **grammar cursor** (current grammar node) +
`broken` flag (generalizes the `ancestorBroken`/`broken` boolean already threaded through every existing
walker). Emits the grandfather set; the ratchet (eslint `ignorePatterns` / freeze-gate) is untouched.
```
walk(dir, gnode, broken):
  entries = readdirSync(dir)
  if gnode.enforceExistence and not entries.has(gnode.enforceExistence): broken = true   # generalizes missingIndex
  for e in entries:
    childRel = rel + '/' + e.name
    if e.isFile():
      if broken: add(childRel); continue                                   # capture EVERY file in a broken folder
      if matchesAny(e.name, resolvePatterns(gnode.files, treeExts)): continue
      add(childRel)
    else (dir):
      if e.name in tree.ignoredDirs: continue
      if e.name in tree.frozenDirs: walkAll(childRel, broken=true); continue
      if e.name == '__tests__': walkTests(...); continue
      named = gnode.folders?.[e.name]
      if named:
        cb = broken || (named.domainOf and not libDomains[named.domainOf].includes(<nextLevelName>))
        walk(childRel, ruleFor(named.recurse), cb)
      elif gnode.rootDomainOf:
        cb = broken || not libDomains[gnode.rootDomainOf].includes(e.name)
        walk(childRel, ruleFor(gnode.recurse), cb)
      elif gnode.recurse:
        cb = broken || not matchesFolderName(e.name, ruleFor(gnode.recurse).folderName)
        walk(childRel, ruleFor(gnode.recurse), cb)
      else:
        add(childRel + '/'); walkAll(childRel)                             # unexpected folder in flat/leaf tree
```
Preserves verbatim: shrink-only (walker is seed, not gate); "capture every file in broken folder";
"empty registry grandfathers existing lib folders" (empty `includes()` ⇒ always broken); `add()`
skip-folder-entries; `enforceExistence`. Per-tree extension via `resolvePatterns(..., treeExts)`.

## Implementation note — approach A (preset + generic, not a fragile full rewrite)

The frink **renderer** tree (and to a lesser extent main) encodes intricate semantics the pin test
asserts exactly: PascalCase component folders requiring `index.tsx`, the `components/ui` shadcn
exception, `use-*`/`useX` hook naming, `features` dispatch, frozen dirs, per-folder `__tests__` rules.
Reimplementing all of that in a declarative grammar = a large, fragile re-derivation of
eslint-plugin-project-structure's own semantics, risking the exact-match test.

So a tree spec is one of two forms:
- **`{ preset: "<name>" }`** — uses a built-in, battle-tested walker (the existing frink
  `makeRendererWalker`/`makeMainWalker`/… stay as the **`electron` preset**, unchanged → pin test green,
  electron template unchanged).
- **`{ grammar: {...} }`** — uses the NEW generic `walkTree` (this doc's schema). Covers the
  kebab-module / flat-component-lib / domain shapes that devkit's own `cli/`+`gate-engine/`,
  frink-primitives, node-backend, and most nextjs `lib/` need — i.e. the actual generalization targets.

This is additive: the generic engine coexists with the frink presets; nothing is deleted. devkit's own
`guard.config.json` uses `{ grammar }` trees → dogfood achieved without touching the proven electron
path. (Generalizing electron itself onto `{ grammar }` is a future refinement, noted in frink-migration.)

## File changes

**New:**
- `gate-engine/structure/tree/grammar.mjs` — `{token}` table parameterized by sourceExtensions + `resolvePatterns(names, exts)` + `compileToEslint(treeSpec)` (→ createFolderStructure arg) + `compileWalls(walls)` + `emitDomains(trees)`.
- `gate-engine/structure/tree/walk.mjs` — `walkTree(treeSpec, absRoot)`.

**Modify:**
- `gate-engine/config.mjs` — add `structure` to DEFAULTS + resolveGuardConfig (deep-merge); add `resolveTreeExtensions`. KEEP `sourceMatchers`, env ladder, `resolveFromCwd` verbatim.
- `cli/lib/generate/generate-structure-baseline.mjs` — DELETE the 6 `make*Walker`, regex consts, `DEFAULT_ROOTS`/`TREE_META`/`TREES`, `ALLOWED_TOP`/`IGNORED_DIRS`/`FROZEN_DIRS`, `*FileAllowed`, `loadDomains`. Rewrite `generateTreeBaseline`/`generateStructureBaselines` to iterate `cfg.structure.trees` via `walkTree`. KEEP `add()`/`collect()`/`renderBaselineFile()` + the **public signatures** the pin test imports (`generateStructureBaselines`, `generateTreeBaseline`).
- `cli/lib/generate/generate-import-wall-baseline.mjs` — `DEFAULT_WALLS`→config `wallClasses`; `classifyWidening` iterates declared classes (first-match, `$1`); add empty-`walls` early-return (skip `runScan`). KEEP loud guards, `parseImportPath`, `resolveEslintBin`, `runScan`, both env flags verbatim.
- `cli/commands/init.mjs` — `STRUCTURE_STACKS` → "any stack whose template guard.config has a `structure` block" (generic/next/node can opt in); `STRUCTURE_TEMPLATE_FILES` → one thin generic eslint shim, topology in each template's guard.config; `runStructureBaselines`/`enableStructureLint` flow unchanged but stack-agnostic.
- `templates/{electron,react-app}/eslint.config.mjs` → shared shim; topology moves into each template's `guard.config.json` `structure`. `templates/generic/guard.config.json` gets an (empty-trees, safe) `structure` block. `templates/*/eslint/domains.mjs` becomes a generated artifact.

## Preserve verbatim (load-bearing)
Ratchets (`gate-engine/ratchets/*` freeze/gate, fanout.json/size.json state, countFanout/overCap);
debt-vs-exempt split (`loadBaseline()` returns `[]` when absent + hand-maintained `exempt.mjs`);
shrink-only/self-healing grandfather; fail-open-on-missing-baseline (`process.exit(2)`); W-3.

## Verification
- `cli/__tests__/generate-structure-baseline.test.mjs` stays GREEN (pins shrink-only + "capture every file in broken folder" + "empty registry grandfathers"). Keep `generateStructureBaselines`/`generateTreeBaseline` signatures.
- New tests: flat component-lib tree; `rootDomainOf` tree; empty-walls early-return; `.mjs` extension matching.
- `bun run test:run` (430+), `npx tsc -p tsconfig.json`, `bun run lint` clean; `fallow audit`/health/dupes/dead-code 0.
- Cross-repo proof: one interpreter expresses a 6-tree electron fixture AND devkit's 2-tree `.mjs` spec.
