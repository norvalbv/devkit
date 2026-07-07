# Structure governance — a developer's guide

> **New here? Read this first.** It explains *how* devkit keeps a repo's file structure clean
> automatically, what happens when you hit a wall, and how to fix it. The companion
> [`directory-structure.md`](directory-structure.md) is the **spec**; the full schema +
> walker design live in [`docs/design/structure/01-generalize-engine.md`](design/structure/01-generalize-engine.md);
> the research rationale is [`docs/design/structure/research-auto-foldering.md`](design/structure/research-auto-foldering.md).

---

## 1. The one thing to understand

**Structure is enforced by lint, not by documentation.** Prose rules ("please put logic in `lib/`")
get ignored — by humans in a hurry and by agents that never read them. So every structural rule is a
*lint error*: put a file in the wrong place or import across a forbidden boundary and `eslint` fails,
blocking the commit. You mostly **don't need to remember the rules** — the linter names the fix.

Two ideas:

1. **Walls** — rules that say where files live, how they're named, and what they may import.
2. **Grandfather-and-shrink** — when a wall is switched on, the repo already has violations. Rather
   than rewrite everything at once, every existing violator is recorded in a generated *baseline*
   ([`eslint/baselines/`](../eslint/baselines/)) and exempted. **New** violations are blocked; old
   ones shrink away as files are touched. The baselines are a to-do list that empties itself.

## 2. Declare once — devkit generates the rest

The whole topology lives in **one place**: the `structure` block of `guard.config.json`. devkit's
interpreter ([`gate-engine/structure/`](../gate-engine/structure/)) reads that single spec and drives
both the eslint rule (in-IDE squiggles + the commit gate) **and** the grandfather baseline walk from
it — so the rule and the baseline can never drift apart.

```jsonc
// guard.config.json
"structure": {
  "trees": [
    {
      "name": "cli",
      "root": "cli",
      "sourceExtensions": ["mjs", "js"],
      "entryAllowlist": ["index.mjs"],
      "libDomains": { "lib": ["generate", "husky", "install"] },
      "grammar": { /* folders + {token} file patterns — see 01-generalize-engine.md */ }
    }
  ],
  "walls": []          // import walls — empty = no import-wall gate (the common case)
}
```

A **tree** = `{ name, root, sourceExtensions?, grammar (or preset), libDomains?, frozenDirs?,
ignoredDirs?, entryAllowlist? }`. The `grammar` references `{token}` patterns (`{kebab}`, `{pascal}`,
`{test}`, …) resolved per-tree from `sourceExtensions` — this is why the same engine governs a `.ts`
app and a `.mjs` CLI. The intricate Electron renderer/main shapes ship as the `electron` **preset**;
everything else is expressible directly in `grammar`.

## 3. The walls

| Wall | What it stops | Mechanism |
|------|---------------|-----------|
| **Placement** | files in the wrong folder / wrong name | `eslint-plugin-project-structure` (folder-structure), generated from `grammar` |
| **Domain vocabulary** | junk-drawer `lib/misc`, flat `lib/` dumps | closed `libDomains` registry — the first folder under a `lib/`-style root must be registered |
| **Frozen dirs** | growing a legacy pile you're migrating out of | `frozenDirs` — existing files grandfathered, new files rejected |
| **Import walls** | crossing trust / feature boundaries | `independent-modules`, from `structure.walls` (empty ⇒ skipped) |
| **File size** | god-files | `max-lines` + the size ratchet ([`gate-engine/ratchets/`](../gate-engine/ratchets/)) |
| **Folder fan-out** | 30 files dumped flat in one folder | fan-out ratchet (≤ `fanoutCap`/folder, recursive) |

**Casing** is whatever the grammar's `{token}` patterns say — typically PascalCase for component
folders/files (`index.tsx`), kebab-case for everything else.

### Domain vocabulary, in one paragraph

A `lib/`-style root is **folder-only** and its first-level subfolders must be **registered** in
`libDomains`. That's what stops an agent inventing `lib/misc/` or dumping ten files flat — an
unregistered folder is a hard lint error at commit. Adding a domain is one kebab-name append to
`libDomains`, then regenerate. Because the rule and the baseline read the same config, they can't
disagree. (`@root` is the special key for a tree whose *root* folders are the closed vocabulary —
e.g. devkit's `gate-engine/`, whose top-level folders are its sub-engines.)

## 4. "I hit a wall — what do I do?"

| Symptom | Cause | Fix |
|---------|-------|-----|
| "file does not match the structure" | wrong place / wrong name for its kind | move it to the home the message names |
| flat file at a `lib/` root rejected | `lib/` is folder-only | put it in a registered domain folder |
| "folder not allowed" under `lib/` | domain not registered | add it to `libDomains`, then regenerate |
| new file in a frozen dir rejected | `frozenDirs` one-way door | put it in the live home instead |
| `max-lines` / "size debt may only shrink" | over cap, or a new disable | **split the file** — don't add a disable |
| "Folder fan-out exceeded" | > cap impl files in one folder | split into cohesive kebab subfolders |
| import across a wall rejected | a `structure.walls` boundary | route through the allowed surface (a barrel, a bridge) |

**If you believe a block is genuinely a permanent exception** (architectural, not "I'm in a hurry"):
add an entry to `eslint/baselines/exempt.mjs` with a one-line reason. That hand-edited file is the
*only* escape hatch; never hand-edit a generated baseline (it's wiped on the next regen).

## 5. Debt vs exempt, and the end goal

- **Debt** (everything generated, `<tree>.mjs` / `imports.mjs` / the ratchet `.json`s): a file that
  *should* conform but doesn't *yet*. **Shrink-only** and **self-cleaning** — fix the file and its
  entry drops out on the next regen. You can't game it by hand-deleting an entry (regen re-adds
  anything still violating; the `.json` ratchets gate the count monotonically down).
- **Exempt** ([`eslint/baselines/exempt.mjs`](../eslint/baselines/exempt.mjs)): a deliberate permanent
  exception with a written reason. **Never shrinks.**

**The goal is to drive every debt baseline to `[]` / `0`,** reclassifying genuine permanent exceptions
into `exempt.mjs` as you find them. **Keep the empty files** — an empty baseline is the standing proof
that its wall has zero grandfathered exceptions.

## 6. Regenerating (only after a deliberate audit — never to silence a new offender)

```bash
devkit init            # re-runs the structure + import-wall baseline generators from guard.config.json
```

**Regenerate ≠ silence.** Regenerating to make a *new* violation disappear defeats the whole system.
Regen only after a deliberate audit — a domain rename, a real migration. The honest way to remove a
debt entry is to *fix the file*.

## 7. How it runs at commit time

No single command covers everything — the walls split across two mechanisms:

| Wall | In `eslint` (`bun run lint`)? | Where it fires |
|------|------------------------------|----------------|
| Placement, domain, frozen-dir, import walls | ✅ yes | eslint (generated rule) |
| Size **cap** (`max-lines`) | ✅ yes | eslint |
| Size-disable **ratchet** (count gate) | ❌ no | `gate-engine/ratchets/*` at pre-commit |
| Fan-out **ratchet** | ❌ no | `gate-engine/ratchets/*` at pre-commit |

The ratchet gates fire via husky (and a **CI mirror** — `--no-verify` is bypassable, so a load-bearing
gate must run on the server too). A `gate` that finds *growth* exits 1 and blocks the commit (split,
don't disable); one whose last grandfathered entry *heals* in the commit self-deletes the baseline.
A missing baseline means "no grandfathered debt": a **governed** repo (one with `guard.config.json` —
every adopted repo, CI included) still **enforces the cap from config**, and only an ungoverned repo
fails open, so an unadopted checkout never wedges. Baselines are cut once at adoption and never
re-snapshotted (an absent one is healthy, not drift).
