# Fixing structure lint errors — RUNBOOK

> **Runbook only — do not restate the spec tree or per-kind rules.** This file OWNS the
> *error-text → exact command* mapping. For where files go, the tree, and per-kind naming, link
> [`directory-structure.md`](../../../../docs/developer-docs/directory-structure.md) — never copy it
> here. The eslint messages already name their own fix; this just gives you the copy-paste.
>
> Directory paths below follow the **electron-stack template** — see [`SKILL.md`](../SKILL.md)'s
> layout note; map them to your repo's `guard.config.json` `structure.trees`.
>
> Paths below (`src/renderer`, `src/main`, …) follow the **electron-stack template** — see
> [`SKILL.md`](../SKILL.md)'s layout note; map them to your repo's `guard.config.json` `structure.trees`.

Look up the row whose **left column matches the text the linter actually printed**, run the recovery
in the right column, then run the [verify-by-hand block](#verify-before-commit-by-hand) before you
commit. `🔥` in the error is literal (the plugin emits it).

---

## The runbook (keyed by error text)

### 1. Flat file at a `lib/` root

```
🔥 File '<name>.ts' is invalid. 🔥
Allowed names  = …
```
…printed for a file sitting directly at `src/renderer/lib/`, `src/main/lib/`,
`socket-server/src/lib/`, or `vercel-serverless/lib/`.

**Cause:** `lib/` roots are folder-only. A loose file there has no domain.
**Fix:** move it into a registered domain folder — `lib/<domain>/<name>.ts`. Pick the existing domain
that owns the concern (the live list is in [`eslint/domains.mjs`](../../../../eslint/domains.mjs); do
not invent `misc`/`helpers`/`common`). If no domain fits, that's row 2.

---

### 2. `Folder '<x>' is invalid` under `lib/` — unregistered domain

```
🔥 Folder '<x>' is invalid. 🔥
Allowed names  = <the registered domains>…
```

**Cause:** `<x>` is not in the closed domain registry for that tree.
**Fix:** append the domain name (kebab-case, named for the concern) to the right array in
[`eslint/domains.mjs`](../../../../eslint/domains.mjs), then grandfather any pre-existing files and let
the rule see the new domain:

```bash
bun lint:structure:baseline
```

**A new `src/main/lib/` domain ALSO needs `index.ts`** in the folder (main modules enforce a public
API barrel) — create `src/main/lib/<x>/index.ts` before re-linting, or you'll trade this error for a
missing-`index.ts` error.

> The `Allowed names` list in the message is the live registry at lint time — trust it over any list
> written down elsewhere.

---

### 3. New file in a frozen legacy dir (`utils/`, `contexts/`, `types/`, `constants/`)

```
🔥 File '<name>.ts' is invalid. 🔥   (under src/renderer/utils|contexts|types|constants)
```
…or, if you *imported* from one: the [import-wall](#6-renderer-import-wall-block) message naming
`@/utils,@/types,@/constants,@/contexts`.

**Cause:** these dirs are frozen — grandfathered shrink-only, no additions, no new consumers.
**Fix:** put the new file in a `lib/` domain instead — `src/renderer/lib/<domain>/<name>.ts` (add the
domain via row 2 if needed). Do **not** add to the frozen dir to "match the neighbours". If you were
importing *from* one, migrate the source out to `lib/<domain>/` and import that.

---

### 4. `max-lines` / "size debt may only shrink"

```
File has too many lines (NNN). Maximum allowed is 500.        # eslint max-lines (cap)
Function 'foo' has too many lines …                            # 200 (.ts) / 300 (.tsx)
```
or, from the husky ratchet:
```
size debt may only shrink …                                   # a NEW eslint-disable max-lines
```

**Cause:** file/function over the hard cap, OR you added an `eslint-disable max-lines`.
**Fix: SPLIT — never add a disable.** The size-disable ratchet blocks new disables monotonically, so
suppressing it is not an option. Extract cohesive pieces into sibling files (or a kebab subfolder if
you'd cross the fan-out cap → row 5). After shrinking, optionally lock in the lower count:

```bash
node scripts/size-disable-ratchet.mjs freeze
```

---

### 5. `Folder fan-out exceeded`

```
Folder fan-out exceeded … (>12 impl files)
```
(from `node scripts/folder-fanout-ratchet.mjs gate` at commit; tests/index barrels don't count.)

**Cause:** more than 12 implementation files in one folder, at any depth.
**Fix:** split into cohesive kebab subfolders — group the files by concern (graphify
co-occurrence can suggest clusters), move each group into `lib/<domain>/<sub-concern>/`. Don't create
a junk-drawer subfolder to dump the overflow. Re-`freeze` after if you want the lower count pinned:

```bash
node scripts/folder-fanout-ratchet.mjs freeze
```

---

### 6. Renderer import-wall block

```
🔥 This import is not allowed in the module 'renderer'. 🔥
Renderer import wall: no src/main (cross-process types -> src/shared/types),
no other-feature deep paths (use the @/features/<x> barrel),
no frozen legacy dirs (@/utils,@/types,@/constants,@/contexts -> lib/).
Grandfathered files: eslint/baselines/imports.mjs …
```

**Cause + fix (the message names which one):**
- **Imported `src/main/...`** (even `import type`): the renderer can't reach across the process
  boundary. Move the shared *type* into `src/shared/types/`, import it from there. For runtime
  behaviour, call main via **tRPC / IPC**, never a direct import.
- **Imported another feature deeply** (`@/features/x/lib/...`): import via that feature's public
  barrel — `@/features/x` (its `index.ts` / `index.tsx`) — see row 7.
- **Imported a frozen dir** (`@/utils`, `@/types`, `@/constants`, `@/contexts`): migrate the source
  to `lib/<domain>/` and import that (row 3).

---

### 7. Cross-feature deep import

```
🔥 This import is not allowed in the module 'renderer'. 🔥   (… use the @/features/<x> barrel)
```
…where the offending path is `@/features/<other>/…` below the feature root.

**Cause:** feature internals are barrel-only from outside.
**Fix:** import from the feature's barrel, not a deep path:

```ts
// ✗  import { Foo } from '@/features/agents/lib/foo'
// ✓  import { Foo } from '@/features/agents'
```

If the symbol isn't exported from `@/features/<other>/index.ts(x)`, add it to that barrel (or
reconsider whether it should be shared at all).

---

## Verify before commit, by hand

**No single `bun run` command covers everything** — the size + fan-out ratchets are husky-only.
Run all four to approximate the full commit gate:

```bash
bun run lint                                  # biome + eslint: placement, imports, size CAP
node scripts/size-disable-ratchet.mjs  gate   # Wall 3 ratchet (new eslint-disable max-lines)
node scripts/folder-fanout-ratchet.mjs gate   # Wall 4 ratchet (>12 files/folder)
bunx vitest run scripts/                       # the governance test suites
```

A ratchet `gate` that finds **growth** exits 1 and blocks the commit (split, don't disable). One that
finds **shrinkage** reminds you to re-`freeze`. Both fail open (exit 2) if their baseline is missing,
so a fresh checkout never wedges.

---

## When you've genuinely fixed nothing wrong (the escape hatches)

- **Symptom→fix table & "I hit a wall":**
  [`structure-governance.md` §3](../../../../docs/developer-docs/structure-governance.md#3-i-hit-a-wall--what-do-i-do)
- **Baseline lifecycle (debt vs exempt, the drive-to-zero goal):**
  [`structure-governance.md` §6](../../../../docs/developer-docs/structure-governance.md#6-the-baselines--debt-vs-exempt-and-the-end-goal)
- **The ONE permanent escape hatch** — a genuine, permanent architectural exception (not "I'm in a
  hurry"): add a reasoned entry to [`eslint/baselines/exempt.mjs`](../../../../eslint/baselines/exempt.mjs).
  It is the *only* hand-edited baseline; every entry is reviewed. **Never** hand-edit a generated
  baseline — the next regen wipes it.
