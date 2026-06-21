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
