# Directory-structure spec

> This is the **principle**. The authoritative, machine-readable **spec** is the `structure` block of
> a repo's `guard.config.json` (schema + the generic walker algorithm in
> [`docs/design/structure/01-generalize-engine.md`](design/structure/01-generalize-engine.md)). The
> day-to-day how-to is [`structure-governance.md`](structure-governance.md).

## 1. Principle

> **Process boundary first → kind second → one home per kind → enforced by lint, not prose.**

Three nested questions resolve every "where does this go?":

1. **Which boundary owns it?** A trust/process boundary (in an Electron app: `main` trusted Node ·
   `preload` bridge · `renderer` UI+logic · `shared` process-agnostic) is a hard import wall, not a
   suggestion. A plain library or CLI may have only one boundary — that's fine; the model degrades to
   "one tree."
2. **What kind is it?** A fixed, closed vocabulary of kinds per boundary (a component, a hook, a lib
   domain, a route…). No inventing new top-level dirs.
3. **One canonical home per kind.** Ambiguity is the enemy — agents guess when there are two homes.
   Every kind resolves to exactly one path, and the wrong choice is a *lint error*, not a silent
   accept.

Existing violations are **grandfathered into shrink-only baselines** — never a flag-day.

## 2. How the principle becomes config

Each boundary is one `structure.trees[]` entry. Its `grammar` encodes the closed vocabulary:

- **`grammar.files`** — the file kinds allowed directly in a directory, as literals (`index.mjs`) or
  `{token}` patterns (`{kebab}`, `{pascal}`, `{camel}`, `{test}`, `{css}`, `{json}`) resolved per the
  tree's `sourceExtensions`.
- **`grammar.folders`** — named child folders, each with its own sub-grammar.
- **`grammar.recurse` + `grammar.rules`** — a named recursive rule for unnamed child folders (e.g. a
  kebab module that nests kebab modules).
- **`domainGate` + `libDomains`** — the closed-registry wall: a node's child folders must be registered
  (the `@root` key applies it at the tree root, making the top-level folders the closed vocabulary).
- **`frozenDirs` / `ignoredDirs` / `entryAllowlist`** — the one-way-door legacy dirs, the
  never-linted dirs (assets, build output), and the permitted loose root files.

The same grammar drives the eslint placement rule **and** the grandfather walk — declare once, generate
both. See `01-generalize-engine.md` for the full schema and the six worked topology examples
(devkit's own two-tree `.mjs` layout, a flat component library, an Electron app, a Next.js app, a node
backend, a monorepo).

## 3. Casing law (one sentence)

*Whatever the grammar's `{token}` patterns say* — conventionally, components and their folders are
`PascalCase` with the file always `index.tsx`; everything else (hooks, lib modules, types, CLI
commands, gate engines) is `kebab-case`.

## 4. The hard stops (lint errors, not guidelines)

1. **PLACEMENT** — a file whose name/location doesn't match its tree's grammar fails.
2. **DOMAIN** — a flat file at a `lib/`-style root, or an unregistered domain folder, fails. Add a real
   domain (named for the concern it owns, never `misc`/`common`/`utils`) or move the file.
3. **FROZEN** — no new file in a `frozenDirs` dir; migrate to the live home.
4. **SIZE** — over the line/function cap → split. An inline disable is blocked by the ratchet.
5. **FAN-OUT** — more than `fanoutCap` impl files in one folder → split into cohesive subfolders.
6. **IMPORT** — crossing a declared `structure.walls` boundary fails; route through the allowed surface.
