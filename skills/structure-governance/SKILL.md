---
name: structure-governance
description: Use when placing or creating a NEW file and you need to know where it goes ("where does X go", "what folder/domain", "which directory for this router/hook/component"), when naming a new file/folder (PascalCase vs kebab), or when a structure LINT error blocked a commit ("lint blocked my commit", project-structure / max-lines / folder fan-out / import-wall / domain-registry / "folder not allowed" / "size debt may only shrink"). NOT for general edits to existing files, behaviour refactors, or any non-structural max-lines turn — only fires on placement, naming, or a structure-rule violation.
---

# Structure governance

The structure is enforced by **lint, not docs** — the eslint gate is the law; this skill is the
write-time guide that gets you placed right the first time and unblocks you when a wall fires.

## Authority chain

- **Spec / full tree / per-kind rules** → [`docs/developer-docs/directory-structure.md`](../../../docs/developer-docs/directory-structure.md)
- **How-to / "I hit a wall" symptom→fix table** → [`docs/developer-docs/structure-governance.md`](../../../docs/developer-docs/structure-governance.md) (its `## 3` section)
- **The *why* / rejected alternatives** → [`docs/decisions/renderer-structure-governance.md`](../../../docs/decisions/renderer-structure-governance.md)
- **The LIVE domain registry** → [`eslint/domains.mjs`](../../../eslint/domains.mjs) (cite this file — never reproduce the arrays; they churn)
- **The per-violation fix** → the eslint error message itself (it names the fix)

**This skill OWNS the placement decision table + the per-wall fix runbook; everything else it links.**

## The one principle

**Process boundary first → kind second → one home per kind.** Lint is the law; this is the
write-time guide. Match placement to the process that runs the code, then to what kind of thing it
is, and never give a kind two homes.

## When / when-NOT

- **When:** creating a brand-new file and unsure where it lives · naming a new file or folder ·
  a structure lint error blocked your commit (project-structure, max-lines, fan-out, import-wall,
  domain-registry) · adding a new lib domain or feature folder.
- **When NOT:** editing existing files in place · behaviour refactors that don't move/create files ·
  a max-lines turn that's really "this function got long" with no relocation question.

## The placement decision table

Match the FIRST row that fits, then check the HARD STOPS.

```
WHAT I'M WRITING                          →  HOME                                  →  NAME
─────────────────────────────────────────────────────────────────────────────────────────
Node: DB/secrets/fs/IPC impl              →  src/main/lib/<domain>/                →  index.ts + <kebab>.ts
tRPC router                               →  src/main/lib/trpc/routers/            →  <kebab>.ts
Railway API handler (Express)             →  socket-server/src/api/routes/         →  <kebab>.ts (flat)
Railway backend logic                     →  socket-server/src/lib/<domain>/       →  <kebab>.ts (registry)
Vercel webhook/cron handler               →  vercel-serverless/api/<domain>/       →  <kebab>.ts or [param].ts
Vercel shared logic                       →  vercel-serverless/lib/<domain>/       →  <kebab>.ts (registry)
Bridge channel for renderer               →  src/preload/                          →  <kebab>.ts (flat)
Type used by BOTH processes               →  src/shared/types/                     →  <kebab>.ts
Helper used by BOTH processes             →  src/shared/lib/                       →  <kebab>.ts
Component reused by 2+ features            →  src/renderer/components/<Pascal>/     →  index.tsx
Component for ONE feature                  →  src/renderer/features/<f>/<Pascal>/   →  index.tsx
shadcn/Radix primitive                    →  src/renderer/components/ui/           →  <kebab>.tsx
Generic reusable hook                     →  src/renderer/hooks/                   →  use-foo.ts
Renderer logic / atom / non-component      →  src/renderer/lib/<concern>/          →  <kebab>.ts
Pure renderer util                        →  src/renderer/lib/utils/               →  <kebab>.ts

HARD STOPS (lint errors, not guidelines):
 1. SIZE: new file >500 lines, or fn >200 (.ts) / >300 (.tsx) → SPLIT before writing.
    Adding `eslint-disable max-lines` is BLOCKED by the size ratchet (counts shrink-only).
 2. FEATURE: feature folders are UI ONLY (Pascal component folders + index.ts barrel).
    Logic/hooks/atoms/stores → renderer/lib/<concern>, /hooks. Never loose .ts at feature root.
 3. UTILS: renderer logic+utils have ONE home — renderer/lib/. (utils/ + contexts/ are legacy,
    grandfathered-shrinking; don't add to them.)
 3b. DOMAIN: lib/ roots are FOLDER-ONLY (a flat file at renderer/lib/, main/lib/,
    socket-server/src/lib/ or vercel-serverless/lib/ root is a lint error) and the first-level
    folder MUST be a registered domain — see eslint/domains.mjs (one registry array per tree).
    New domain = one-line append there (named for the concern it owns; never misc/helpers/common).
 3c. FAN-OUT: max 12 impl files per folder, ANY depth (tests/index barrels don't count).
    Folder full → split into cohesive kebab subfolders (group by concern; graphify/co-occurrence
    can suggest clusters). Existing piles are grandfathered shrink-only (eslint/baselines/fanout.json).
 4. PROCESS: renderer never imports src/main — not even types (cross-process types live in
    src/shared/types; existing offenders are grandfathered shrink-only in eslint/baselines/imports.mjs;
    sole permanent exempt: lib/trpc.ts AppRouter). No Node builtins in renderer (bare `path` OK —
    vite-aliased to path-browserify). Other features only via their index.ts barrel, never deep paths.
 5. Component folders: PascalCase + index.tsx required; co-locate constants.ts/types.ts/tests.
```

**Casing law:** components + their folders are `PascalCase` with the file always `index.tsx`;
everything else (hooks, lib, types, main/preload/shared modules) is `kebab-case`.

## The six walls (navigation)

Full prose lives in [`references/walls.md`](references/walls.md) and the matching
[structure-governance.md `## 2`](../../../docs/developer-docs/structure-governance.md) wall sections.

| # | Wall | One-line fix |
|---|------|--------------|
| 1 | Placement | move the file to its kind's home in the table above |
| 2 | Domain vocabulary | put it under a registered `lib/<domain>/`; add the domain to `eslint/domains.mjs` |
| 3 | File size | split below the cap — never add `eslint-disable max-lines` |
| 4 | Folder fan-out | split the >12-file folder into cohesive kebab subfolders |
| 5 | Frozen legacy dirs | don't add to `utils/`/`contexts/`; use `lib/<domain>/` |
| 6 | Import walls | no renderer→main, no deep cross-feature; use shared types / barrels / tRPC |

## I hit a wall — the loop

1. **Read the lint error** — it names the fix (see the symptom→fix table).
2. Still stuck → [structure-governance.md `## 3`](../../../docs/developer-docs/structure-governance.md) ("I hit a wall — what do I do?").
3. Need the step-by-step → [`references/fixing-lint-errors.md`](references/fixing-lint-errors.md).
4. Genuine **permanent** architectural exception (not "I'm in a hurry") → one reasoned entry in
   [`eslint/baselines/exempt.mjs`](../../../eslint/baselines/exempt.mjs). Never hand-edit a generated baseline.

## Adding a domain / feature

- **New lib domain:** append it to the right array in [`eslint/domains.mjs`](../../../eslint/domains.mjs)
  (named for the concern — never `misc`/`helpers`/`common`), then `bun lint:structure:baseline`.
  A new MAIN domain also needs an `index.ts` in the folder.
- **New feature:** `src/renderer/features/<kebab>/` with PascalCase component folders (each
  `index.tsx`) + an `index.ts` barrel; logic/hooks/atoms go in `src/renderer/lib/`, not the feature folder.

## Reference index

- [`references/walls.md`](references/walls.md) — the six walls, what each catches, and where to look.
- [`references/fixing-lint-errors.md`](references/fixing-lint-errors.md) — per-violation fix runbook.

_The `.cursor/skills` mirror is a manual byte-identical copy — re-copy on edit._
