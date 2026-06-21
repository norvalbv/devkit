# Piece 6 — Collapse stacks to data (the universal solution)

> **Decision (user, "Full universal"):** kill the per-stack hand-written `eslint.config.mjs` templates.
> A repo's topology lives ONLY in `guard.config.json` `structure` (data); ONE generic shim compiles it
> via devkit's `compileToEslint`; one walker generates the baseline. "Stacks" become starter `structure`
> blocks (JSON), not code. A repo devkit has never seen self-governs by declaring its grammar — no
> template, no release. This is what Pieces 1–3 built + dogfooded on devkit's own repo; this piece makes
> it the consumer path too (instead of the per-stack templates Piece 3 left in place).

## Architecture

```
guard.config.json  "structure": { trees:[...], walls:[] }   ← the ONE per-repo source (data)
        │
        ▼  ONE shim, identical in every repo (templates/_shared/eslint.config.mjs)
  eslint.config.mjs → for each tree: createFolderStructure(compileToEslint(tree, exts, {baseline, exempt}))
        │
        ├─► eslint rule (IDE squiggles + commit gate)
        └─► baseline walk (generateStructureBaselines, already config-driven)
```

- **One shim, every stack.** `templates/_shared/eslint.config.mjs` imports `compileToEslint` +
  `resolveGuardConfig`/`resolveTreeExtensions` from `@norvalbv/devkit` and renders the consumer's
  `structure` block. Byte-identical across repos. (It's devkit's own `eslint.config.mjs`, with the
  imports pointed at the package instead of relative paths and the root read from the config's own dir.)
- **Stacks = data presets.** Each stack is a `structure` block embedded in that stack's
  `templates/<stack>/guard.config.json`. No per-stack `eslint.config.mjs`.
- **Unknown layout = no stack needed.** A repo writes its own `structure` block → the same shim governs
  it. This is the real escape hatch the per-stack templates couldn't offer.
- **Consumer already depends on devkit.** The husky ratchet bins (`guard-fanout`/`guard-size`) already
  require `@norvalbv/devkit` to resolve, so the shim's runtime import of devkit is the SAME dependency,
  not a new fragility class — which is why "self-contained to avoid devkit coupling" was the wrong call.

## Grammar vocabulary additions (to express react-app + electron as data)

`gate-engine/structure/grammar.mjs` `tokenRegex` + `STRUCTURE_TOKENS`:
- `{use_hook}` — `^use(-[a-z][a-z0-9-]*|[A-Z][a-zA-Z0-9]*)\.<ext>$` (use-foo.ts / useFoo.ts).
- `{md}` — `\.md$` (colocated docs in component folders).
- (existing `{pascal}`/`{camel}`/`{test}`/`{css}`/`{kebab}`/`{kebab_dir}`/`{pascal_dir}` cover the rest.)

No-drift test (`structure-compile.test.mjs`) extends to the new tokens.

## Stages (each: build → verify → commit)

- **Stage 1 (this piece's proof):** export `./gate-engine/structure/compile`; write the generic shim
  (`templates/_shared/eslint.config.mjs`); migrate **component-lib** to data — embed its `structure`
  block in `templates/component-lib/guard.config.json`, ship the shim, drop its hand-written
  `eslint.config.mjs`. `init` sources `eslint.config.mjs` from `_shared` for config-driven stacks.
- **Stage 2:** **react-app** as data — TWO trees (`components`, `pages`) scoped to `src/components` /
  `src/pages` (the "govern some roots, leave the rest open" model = a tree per governed root, no tree =
  ungoverned). Add `{use_hook}`/`{md}`. Drop `templates/react-app/{eslint.config.mjs,eslint/domains.mjs}`.
- **Stage 3 (riskiest):** **electron** as data — renderer/main/shared/preload/socket/vercel as a 6-tree
  `structure` block. MUST reproduce the 6 hand-written walkers' EXACT output (the
  `generate-structure-baseline.test.mjs` pin test). Validate walkTree(electron-block) == the preset
  walkers on a fixture before deleting the walkers. Needs `enforceExistence` + the `ui/` shadcn ignore +
  `{use_hook}`. If a shape proves grammar-inexpressible, keep ONLY that sub-tree as a named preset.
- **Stage 4:** node-service/generic data presets (or "no structure block" = ungoverned); delete the
  per-stack `eslint.config.mjs` templates + `STRUCTURE_TEMPLATE_FILES` per-stack eslint entries; update
  detect-stack docs; `frink-migration.md` (electron walkers now data); docs sync.

## Invariants preserved

Declare-once (one source → rule + baseline); no-drift (`tokenRegex` single truth); grandfather-and-shrink;
debt-vs-exempt; the generic walker + ratchets unchanged. The ONLY structural change is **where the eslint
rule comes from** (generated shim from data, not a per-stack code file).

## Verify (whole piece)

tsc + biome + fallow(0/0/0) + full suite green; `compileToEslint` resolves as a package subpath import
from a consumer; the generic shim governs a real flat lib (frink-primitives) live; electron pin test
green against the data block (Stage 3); a repo with a hand-authored `structure` block + the shim
self-governs with no devkit stack.

---

## Progress + workflow findings (derive-structure-blocks, run wf_cf2b5431-704)

**DONE + committed:**
- **Stage 1** (`e7d73c4`): universal shim + exports (`compileToEslint`, `buildStructureConfigs`,
  `makeBaselineLoaders`); component-lib migrated to data; fixed the `rootName` bug (structure root node
  name must be the structureRoot basename, not the tree's logical name).
- **Foundation** (`07e01ef`): the 11 convention tokens (`pascal_ts/pascal_tsx/use_hook_{camel,kebab,
  pascal}/kebab_{ts,tsx}/kebab_test_dotted/vercel_route/any_md/any_file`) + **multi-recurse**
  (`recurse: string|string[]`, first-matching-folderName dispatch) in walk.mjs + compile.mjs, with
  no-drift + dispatch tests.

**Per-tree verdict (full derivations in the workflow output / task wf5cq7n5j.output):**
| tree | verdict | ship as | needs |
|------|---------|---------|-------|
| react-app/components | partial | **data** | tight tokens (done) |
| react-app/pages | partial | **data** | (multi-recurse done; both rules share `{pascal_dir}` so single `pageFolder` suffices) |
| electron/renderer | full | **data** | frozenDirs + ignoredDirs(+ui) + entryAllowlist + domainGate + enforceExistence + new tokens (done) |
| electron/shared | full | **data** | `{kebab_test_dotted}` (done) |
| electron/preload | partial | **data** | `{kebab_test_dotted}`; unknown-folder grandfather via no-recurse branch |
| electron/socket | full | **data** | named folders (types/api/lib) + recurse + domainGate |
| electron/vercel | full | **data** | `{vercel_route}` + `{any_file}` + per-domain `__fixtures__/__snapshots__` |
| **electron/main** | partial | **PRESET (keep)** | a `MAIN_ROOT_FOLDERS` known-root-allowlist node feature (deferred) — unknown top-level dirs must grandfather-all, not become broken kebab-modules |

So **5/6 electron trees + react-app → data; electron/main stays the one named code preset** until a
`rootFolderAllowlist` node feature lands.

## DECISIONS

1. **Size caps — RESOLVED: the guard-size ratchet caps raw lines (option C).** Today the ratchet only
   COUNTS `eslint-disable max-lines` directives — it relies on eslint's `max-lines` rule as the actual
   cap, so a structure-only shim would silently drop size enforcement (and component-lib + devkit's own
   repo, already structure-only shims, currently have NO file-size cap — a pre-existing gap). Fix: add
   `maxLines` (+ later `maxLinesPerFunction`) to `guard.config.json`; make `gate-engine/ratchets/size-disable.mjs`
   enforce a raw-line cap directly (grandfather-and-shrink baseline, language-aware via sourceExtensions),
   so NO eslint size rule is needed anywhere and size is fully data/ratchet-owned across ALL stacks.
   - **Sub-caveat:** per-FILE cap is trivial (count lines). per-FUNCTION cap needs an AST/parser (eslint
     does this today). Implement file-cap in the ratchet first; per-function is a follow-up (light parser,
     or keep a per-function eslint block only for stacks that opt in). This unblocks the react-app/electron
     structure-only migration; the per-function cap is the one piece that may lag.
2. **Pin-test equality (the gating invariant).** For EACH electron walker, extend
   `generate-structure-baseline.test.mjs` to assert `walkTree(dataBlock)` deepEquals
   `generateTreeBaseline(presetWalker)` on the same fixture BEFORE deleting that walker. This is
   parallelizable (one validation agent per tree) — a good second workflow.

## Remaining order (workflow-recommended)

react-app (components, then pages) → electron data trees (renderer/shared/preload/socket/vercel, each
gated by the equality test) → keep main as preset → final cleanup (delete per-stack eslint.config
templates + the now-unused walker code once all non-main trees are data).
