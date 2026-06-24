# Six walls — per-wall live-truth pointers

Canonical: [`docs/developer-docs/structure-governance.md`](../../../../docs/developer-docs/structure-governance.md); this file adds the per-wall live-truth pointers.

> Directory paths below follow the **electron-stack template** — see [`SKILL.md`](../SKILL.md)'s layout note; map them to your repo's `guard.config.json` `structure.trees`.

This file OWNS one thing: **what each wall is + where its live truth lives** (which config / baseline file you read or edit to see the *current* state). It is NOT the error→fix runbook ([`fixing-lint-errors.md`](./fixing-lint-errors.md)) and NOT the spec tree ([`docs/developer-docs/directory-structure.md`](../../../../docs/developer-docs/directory-structure.md)). Per-violation fixes are named by the eslint error messages themselves; the *why* lives in [`docs/decisions/renderer-structure-governance.md`](../../../../docs/decisions/renderer-structure-governance.md).

## Two mechanisms (read this first)

The walls split across **two** enforcement mechanisms — no single `bun run` covers both:

- **eslint** (`bun run lint` / `lint:structure`, staged-only at commit): placement (Walls 1, 2, 5), import walls (Wall 6), and the size **cap** (`max-lines` 500 / fn 200·300).
- **husky-only ratchets** (fire at commit via `.husky/pre-commit`, NOT in `bun run lint`): the size-disable **count gate** (Wall 3) and the fan-out **count gate** (Wall 4).

So `bun run lint` catches a misplaced file, a forbidden import, or an over-cap file — but a *new* `eslint-disable max-lines` or a folder breaching 12 files is caught only by the husky ratchet gates. Full mechanism split + the by-hand approximation: structure-governance.md [`## 7`](../../../../docs/developer-docs/structure-governance.md#7-how-it-runs-at-commit-time).

---

## Wall 1 — Placement

- **Triggers when:** a file lands in the wrong folder or carries the wrong name/casing for its tree (e.g. a loose `.ts` at a feature root, a component not named `index.tsx`, a kebab where Pascal is required).
- **Live truth:** the per-tree shapes in [`eslint.config.mjs`](../../../../eslint.config.mjs) (`createFolderStructure` blocks); grandfathered offenders per tree in [`eslint/baselines/`](../../../../eslint/baselines/) (`renderer.mjs`, `main.mjs`, `shared.mjs`, `preload.mjs`, `socket.mjs`, `vercel.mjs`).
- **Detail:** structure-governance.md [`Wall 1 — placement`](../../../../docs/developer-docs/structure-governance.md#wall-1--placement).

## Wall 2 — Domain vocabulary

- **Triggers when:** a flat file sits directly at a `lib/` root, or a first-level `lib/` subfolder is an unregistered domain (`lib/notifications/…` when `notifications` isn't registered).
- **Live truth:** the closed registries in [`eslint/domains.mjs`](../../../../eslint/domains.mjs) — one array per tree (`RENDERER_LIB_DOMAINS`, `MAIN_LIB_DOMAINS`, `SOCKET_LIB_DOMAINS`, `VERCEL_LIB_DOMAINS`, plus `MAIN_ROOT_FOLDERS`). **Read the arrays there for the current vocabulary; never reproduce them — they churn.** Both the lint rule and the baseline generator import this same file, so they can't drift. Adding a domain = one kebab append + `bun lint:structure:baseline` (a new MAIN domain also needs an `index.ts`).
- **Detail:** structure-governance.md [`Wall 2 — domain vocabulary`](../../../../docs/developer-docs/structure-governance.md#wall-2--domain-vocabulary).

## Wall 3 — File size (cap + ratchet)

- **Triggers when:** a file exceeds 500 lines, a `.ts` function exceeds 200, or a `.tsx` function exceeds 300 (the **cap**, in eslint); or a *new* `// eslint-disable max-lines` directive appears (the **ratchet**, husky-only — the count may only shrink).
- **Live truth:** cap rules in [`eslint.config.mjs`](../../../../eslint.config.mjs) (`max-lines`); frozen disable count in [`eslint/baselines/size.json`](../../../../eslint/baselines/size.json), gated by [`scripts/size-disable-ratchet.mjs`](../../../../scripts/size-disable-ratchet.mjs).
- **Detail:** structure-governance.md [`Wall 3 — file size`](../../../../docs/developer-docs/structure-governance.md#wall-3--file-size).

## Wall 4 — Folder fan-out (ratchet)

- **Triggers when:** any folder, at any depth, holds more than 12 non-test implementation files (`index` barrels and tests don't count). Recursive per-folder, not a repo-wide total — split into cohesive kebab subfolders.
- **Live truth:** frozen over-cap folders in [`eslint/baselines/fanout.json`](../../../../eslint/baselines/fanout.json), gated by [`scripts/folder-fanout-ratchet.mjs`](../../../../scripts/folder-fanout-ratchet.mjs) (husky-only). Exempt-with-reason folders (`src/main/lib/trpc/routers`, `src/renderer/components/ui`) are encoded in that ratchet script.
- **Detail:** structure-governance.md [`Wall 4 — folder fan-out`](../../../../docs/developer-docs/structure-governance.md#wall-4--folder-fan-out).

## Wall 5 — Frozen legacy dirs

- **Triggers when:** a new file is added to a frozen renderer dir (`src/renderer/utils/`, `types/`, `constants/`, `contexts/`) — or (via Wall 6) a new import of what's already in them. Existing files are grandfathered; the dirs are shrinking toward removal. Migrate to `lib/<domain>/`.
- **Live truth:** the seal (match-nothing regex) in [`eslint.config.mjs`](../../../../eslint.config.mjs); grandfathered files in [`eslint/baselines/renderer.mjs`](../../../../eslint/baselines/renderer.mjs); the consumption-ban half in [`eslint/baselines/imports.mjs`](../../../../eslint/baselines/imports.mjs).
- **Detail:** structure-governance.md [`Wall 5 — frozen legacy dirs`](../../../../docs/developer-docs/structure-governance.md#wall-5--frozen-legacy-dirs).

## Wall 6 — Import walls

- **Triggers when:** a forbidden cross-boundary import is added — renderer→`src/main` (banned even as `import type`), deep cross-feature import (must go through the feature's `index.ts` barrel), consuming a frozen dir, a Node-builtin in the renderer (bare `path` excepted), or `src/shared` importing upward into main/renderer.
- **Live truth:** `independent-modules` + `no-restricted-imports` config in [`eslint.config.mjs`](../../../../eslint.config.mjs); the grandfathered offenders (mostly renderer→main *type* imports) in [`eslint/baselines/imports.mjs`](../../../../eslint/baselines/imports.mjs); the sole permanent exception (tRPC `AppRouter`) in [`eslint/baselines/exempt.mjs`](../../../../eslint/baselines/exempt.mjs).
- **Detail:** structure-governance.md [`Wall 6 — import walls`](../../../../docs/developer-docs/structure-governance.md#wall-6--import-walls).

---

**The escape hatch:** a genuine, permanent architectural exception goes in [`eslint/baselines/exempt.mjs`](../../../../eslint/baselines/exempt.mjs) (the only hand-edited baseline) with a one-line reason. Never hand-edit a *generated* baseline — it's wiped on the next regen. The end goal is every generated debt baseline at `[]`/`0`; see structure-governance.md [`## 6`](../../../../docs/developer-docs/structure-governance.md#6-the-baselines--debt-vs-exempt-and-the-end-goal).
