# Structure-engine — open tickets

The universal structure engine is shipped and proven; 2 of 3 stacks (component-lib, react-app) are
config-driven data. These are the tracked follow-ups. Full design context: `06-universal-collapse.md`.

---

## TICKET-1 — electron → data (5/6 trees)

**Status:** open. **Size:** large + risky. **Spec:** `06-universal-collapse.md` (per-tree derivations
in the workflow output) + the per-tree blocks already derived.

Collapse the electron preset to declared `structure` data, like component-lib/react-app:

- **5/6 trees ship as data:** `renderer`, `shared`, `preload`, `socket`, `vercel`. Blocks derived
  (workflow run `wf_cf2b5431-704`); all needed grammar tokens + multi-recurse already landed
  (`07e01ef`).
- **`electron/main` stays a code preset** until a `MAIN_ROOT_FOLDERS` known-root-allowlist node feature
  is added (an unknown top-level dir must grandfather-all, not become a broken kebab-module). See
  `featuresToAdd` in the doc.
- **Gating invariant (the actual work):** for EACH tree, extend
  `cli/__tests__/generate-structure-baseline.test.mjs` to assert `walkTree(dataBlock)` deepEquals
  `generateTreeBaseline(presetWalker)` on the same fixture. Only delete a `make<Tree>Walker` from
  `cli/lib/generate/generate-structure-baseline.mjs` once its tree matches byte-for-byte. This is
  parallelizable — one validation agent per tree (a good second workflow).
- **Then:** wire `templates/electron/guard.config.json` `structure` block, switch its
  `eslint.config.mjs` to the shared shim (keep `main` via the preset fallback in `generateConfigTree`),
  add `maxLines` for size; remove the now-unused walker code + the per-stack `eslint.config.mjs` once
  all non-main trees are data.

## TICKET-2 — per-function line cap

**Status:** open. **Size:** medium (needs a parser). **Spec:** `06-universal-collapse.md` decision 1.

The `guard-size` ratchet caps per-FILE lines now (`maxLines`, `f2aa430`). Per-FUNCTION caps (the old
eslint `max-lines-per-function` 200/300) need AST/function-boundary parsing — not yet ported. Until
this lands, react-app/electron lose only the per-function cap (file cap preserved). Options: a light
parser in the ratchet (e.g. `@typescript-eslint/parser` or a cheap brace-scan), or a per-function
eslint block only for stacks that opt in.

## Already documented elsewhere (not re-ticketed here)

- **frink migration** → `frink-migration.md` (user-driven, in the frink repo).
- **advisory suggester** → `05-suggester-DEFERRED.md` (deferred by decision).
