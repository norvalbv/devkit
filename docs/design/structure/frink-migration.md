# Frink migration checklist — move frink onto devkit's config-driven structure engine

> **Tracked TODO for the USER, to do in the frink repo later.** This work (the devkit generalization)
> does NOT touch frink. When you're ready, follow this to retire frink's six hand-written walkers and
> have it consume the same engine devkit now ships. Until then, frink keeps its current bespoke setup
> and nothing breaks.
>
> Paths below are **frink-relative**. Reference state captured 2026-06-21.

## Why

Frink's structure governance is hand-written: six `createFolderStructure` blocks in
`eslint.config.mjs`, six matching walkers in `scripts/generate-eslint-baseline.mjs`, and a 5-export
`eslint/domains.mjs`. devkit's engine now expresses all of that as **one `structure` config block + one
generic walker** (the `electron` preset already reproduces frink's renderer/main shapes exactly). So
frink can delete the hand-written half and declare its topology instead — single source of truth, no
walker-vs-rule drift to maintain.

## Steps

1. **Author frink's `structure` block** in `guard.config.json` from the current
   `eslint/domains.mjs` + the six `createFolderStructure` blocks:
   - `renderer` + `main` trees → `{ "preset": "electron-renderer" }` / `{ "preset": "electron-main" }`
     (the intricate PascalCase-component / required-`index.ts` shapes ship as presets — see
     `cli/lib/generate/generate-structure-baseline.mjs` in devkit).
   - `shared`, `preload`, `socket`, `vercel` trees → express directly as `grammar` (they are
     kebab-module / flat shapes the generic walker covers).
   - Move each `*_LIB_DOMAINS` array into the matching tree's `libDomains`.
   - Move the import-wall classes (`crossProcess` / `frozenDirRe` / `featureRe` / `baseRef` /
     `lintGlobs`) into `structure.walls`.

2. **Regenerate baselines via the new engine** (devkit's `init`/generators reading the new config),
   and confirm the emitted `eslint/baselines/<tree>.mjs` match the current committed ones (diff should
   be empty — the preset is exact). If a diff appears, the preset/grammar isn't faithful yet → file it
   back to devkit Piece 1, don't hand-patch frink.

3. **Emit the eslint shim.** Replace the hand-written six `createFolderStructure` blocks in
   `eslint.config.mjs` with the devkit-generated shim that compiles the rule from `guard.config.json`
   (keeps in-IDE squiggles; `compileToEslint`, devkit Piece 3).

4. **Delete the now-redundant frink files** once 2–3 are green:
   - `scripts/generate-eslint-baseline.mjs` (the six hand-written walkers) — replaced by devkit's
     generic walker + `electron` preset.
   - `scripts/generate-import-wall-baseline.mjs` — replaced by devkit's config-driven generator.
   - the six `createFolderStructure` blocks + the `regex`/`rules` boilerplate in `eslint.config.mjs`
     — replaced by the generated shim.
   - `eslint/domains.mjs` — folded into `guard.config.json` `libDomains` (keep only if some other
     script still imports it; otherwise delete).
   - `scripts/generate-eslint-baseline.test.mjs` — its coverage moves to devkit's
     `cli/__tests__/{generate-structure-baseline,structure-walk}.test.mjs`.

5. **Keep** (do NOT delete — these are frink-internal, not devkit-portable):
   - `docs/decisions/renderer-structure-governance.md` (the append-only why).
   - `eslint/baselines/exempt.mjs` (frink's real exemptions — the tRPC `AppRouter` import).
   - `.claude/skills/structure-governance/` (frink's agent-facing placement table).
   - the ratchet `.json`s (`size.json`, `fanout.json`) + the size/fan-out gates if frink's are newer
     than devkit's `gate-engine/ratchets/*` — reconcile, don't blindly drop.

## Open items to fold back into devkit before frink can migrate

- **`compileToEslint(treeSpec)`** — devkit Piece 3 emits the eslint shim; until it does, step 3 has no
  generator. (Piece 1 deferred this; the baseline walk is independent and already done.)
- **`electron-renderer` / `electron-main` presets** exposed by `name` in `structure.trees[].preset`
  — devkit currently keeps frink's walkers internally; wiring them as named presets is the last gap.
- **Import-wall `wallClasses`** — devkit's import-wall generator early-returns on empty `walls` but
  still uses the electron `DEFAULT_WALLS` shape for non-empty `walls` (marked `ponytail:` in
  `generate-import-wall-baseline.mjs`). Generalize `classifyWidening` to declared `wallClasses` before
  frink's walls migrate.
