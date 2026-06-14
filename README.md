# @norvalbv/devkit

Single source of truth for my reusable developer toolkit. One git repo, two halves:

| Half      | What                                                          | How consumers get it                       |
| --------- | ------------------------------------------------------------ | ------------------------------------------ |
| **AGENT** | `skills/` — Claude/agent skills (governance, design, review) | bundled in the package; `devkit init` / `devkit sync-skills` copies them in |
| **CODE**  | shared **configs** (Biome, tsconfig) + the **gate-engine**   | `bun add git+ssh://git@github.com/norvalbv/devkit.git#<tag>` |

The two halves ship from the **same repo, same tag** so an agent skill and the engine
it drives can never drift apart.

## The one rule: ship the generator, never the data

devkit ships **mechanisms** — the gate engines, the config loader, the shared lint/TS
configs. It never ships a consumer's **data**: no baselines, no allowlists, no decision
log, no `guard.config.json`. Those are born and live in each consumer repo, addressed
relative to the consumer's cwd (see "W-3" below). Update the engine by bumping the tag;
your data is untouched because it was never in here.

## Three ways to consume devkit

| Mode | How | When |
| ---- | --- | ---- |
| **Package** (default) | `bun add -D` the git dep; configs `extends "@norvalbv/devkit/…"`; hook calls `bunx guard-*` | Your own repos — auto-updates on a tag bump |
| **Standalone** (`--standalone`) | `bun add -g` devkit once; `devkit init --standalone` vendors configs + a fail-open hook; **nothing in package.json** | **Shared / work repos** where a private dep is unwanted ([↓](#standalone-no-package--like-fallow-init)) |
| **Overlay** (`--overlay`) | global devkit; `devkit init --overlay` — everything **git-ignored** (`.git/info/exclude`), hook **chains** to the repo's own, configs **extend** theirs | A repo you **can't modify** — the team would reject a devkit PR, but you want it locally + invisibly ([↓](#overlay-local-only--invisible--non-invasive)) |

## CODE half (package mode)

### Install (consumer)

```bash
bun add -D git+ssh://git@github.com/norvalbv/devkit.git#v0.8.0
```

> Private repo: use the `git+ssh://` form, not bun's `github:` shorthand — the latter
> resolves through GitHub's API tarball endpoint, which 404s on a private repo.

There is **no build step and no `dist/`** — bun runs no lifecycle scripts on a git
install, so everything is committed as runnable plain `.mjs` / `.json` / `.jsonc`
(BL-2). What you install is what runs.

### Shared configs — extend the BARE subpath, never a file path (BL-1)

Consumers extend the **bare exports subpath**, NOT the underlying `.jsonc`/`.json` file:

```jsonc
// biome.jsonc
{ "extends": ["@norvalbv/devkit/biome/base"] }      // ✅ bare subpath
// or, for a React app:
{ "extends": ["@norvalbv/devkit/biome/react"] }
```

```jsonc
// tsconfig.json
{ "extends": "@norvalbv/devkit/tsconfig/base" }      // ✅ bare subpath
// also: @norvalbv/devkit/tsconfig/next · @norvalbv/devkit/tsconfig/node
```

Do **not** write `@norvalbv/devkit/biome/base.jsonc` — the exports map owns the file
extension; consumers commit to the stable bare name and the package decides what backs it.

### gate-engine — portable governance gates

The engine ships five bins. They scan the **consumer's** repo (the cwd they run in),
not the package:

| bin                | engine                                                    |
| ------------------ | --------------------------------------------------------- |
| `guard-decisions`  | append-only decision-log CLI + architectural-smell gate   |
| `guard-dup`        | semantic cross-file duplication matcher (search-code index) |
| `guard-clone`      | token-level copy-paste / clone detector (jscpd)           |
| `guard-fanout`     | folder fan-out ratchet (≤N impl files/folder, any depth)  |
| `guard-size`       | size-disable ratchet (`eslint-disable max-lines` may only shrink) |

Run them from your repo root, e.g. in a pre-commit hook:

```bash
bunx guard-fanout gate
bunx guard-size gate
bunx guard-decisions --gate
```

### Configuring the engine — `guard.config.json`

The engine reads **one** config file: `guard.config.json` at your repo root. The shared
loader (`@norvalbv/devkit/gate-engine/config`) is the single place that knows defaults,
env, and that file — every engine imports `resolveGuardConfig` from it, none redefines
defaults. Copy `guard.config.example.json`, drop the `//`-comment keys, and keep only
what you override:

```jsonc
import { resolveGuardConfig } from '@norvalbv/devkit/gate-engine/config'
const cfg = resolveGuardConfig() // reads <cwd>/guard.config.json + GUARD_* env
```

Env overrides use the `GUARD_*` prefix (with `FRINK_*` read as back-compat aliases):
`GUARD_NO_LOG=1` bypasses the decision gate; `GUARD_DECISION_NO_LLM=1` forces the
pure-regex path; `GUARD_INDEX_PATH`, `GUARD_ALLOWLIST_PATH`, `GUARD_DECISIONS_DIR`
point at the consumer's data.

#### W-3: everything is relative to the CONSUMER cwd

Every path the engine touches — `scanRoots`, `decisionsDir`, the allowlist, the
search-code index — resolves against the **consumer's** working directory, never
`__dirname` (the package dir inside `node_modules`). An engine run from another repo
scans **that** repo. This is why devkit ships no data: the data is yours, found from
your cwd.

## Onboarding a repo — `devkit init` (the setup wizard)

After installing the CODE half, scaffold the guardrails:

```bash
bunx devkit init [--stack electron|react-app|next|node-service|generic] [options]
```

The stack auto-detects from the repo's `package.json` (`react` → `react-app`, `next` → `next`,
`electron` → `electron`, headless ESM → `node-service`, else `generic`).

### Monorepo (a package in a subdir)

Run `init` **inside the package** — devkit is git-root-aware:

```bash
cd services/webapp
bunx devkit init --stack react-app --no-biome --no-tsconfig   # if the package has its own
```

- **Configs + baselines** (`eslint.config.mjs`, `guard.config.json`, `eslint/baselines/*`) land
  **in the package**, governed at its own root (`scanRoots: ["src"]`, no `--scan-root` needed —
  the eslint-plugin's project-root resolves to the package via its own `node_modules`).
- The **husky hook** is installed at the **git root** with a *package-scoped* block whose gates
  run `( cd "services/webapp" && … ) || exit 1` — so the one hook (the only place git fires it)
  governs the package. A second JS package adds its **own** block; they coexist.
- **Skills** sync to the **repo-root** `.claude`/`.cursor` (repo-wide), not the package.

A single-package repo (cwd IS the git root) behaves exactly as before — one unscoped block, no
`cd`. (Alternative for a one-off: stay at the root and pass `--stack react-app --scan-root
services/webapp/src` to govern the subdir from a root-level config — but per-package install is
the cleaner, scalable path.)

On a TTY (and without `--yes`) `init` runs an **interactive setup wizard** (powered by
[`@clack/prompts`](https://www.npmjs.com/package/@clack/prompts)): confirm the detected
stack, then pick which components to install, then pick which gate-engine guards to enable,
review a summary, and apply. **Ctrl-C aborts cleanly — nothing is written.**

### The selectable components

| Component   | What it wires                                                            |
| ----------- | ----------------------------------------------------------------------- |
| `biome`     | `biome.jsonc` extending the devkit base + `@biomejs/biome` devDep + `lint`/`format` scripts + the staged-format step in the hook |
| `tsconfig`  | `tsconfig.json` extending the devkit base                               |
| `skills`    | the agent skills synced into `.claude` + `.cursor` (+ the manifest)     |
| `husky`     | the `.husky/pre-commit` hook (the `# devkit-guards` block container)    |
| `guards`    | a multi-select of the gate lines: `size · fanout · dup · clone · decisions` |
| `structure` | the stack's eslint folder/import-wall preset — **only offered when a template exists** for the detected stack (currently `electron` + `react-app`; `next`/`node-service`/`generic` skip it with a note) |
| `fallow`    | the optional [fallow](https://www.npmjs.com/package/fallow) code-health layer — **off by default**; installs the pinned CLI zero-config (`bun add -g` → `npm i -g` → `cargo install fallow-cli`, no brew/curl) and wires fallow's **own** git hook via `fallow hooks install` (not a devkit gate line) |

Whatever you choose is recorded in `.devkit/config.json` under `components`, so `doctor`
knows what to check.

### Scriptable / CI (non-interactive)

`--yes` (or any non-TTY run) installs **all recommended defaults** (the pre-wizard
behaviour). Per-component flags work with or without `--yes`:

```bash
bunx devkit init --yes --no-biome              # everything except biome
bunx devkit init --yes --guards fanout,size    # only those two gate lines
bunx devkit init --yes --no-skills --no-structure
# nested app at the git root: govern the subdir, gate stays at the root
bunx devkit init --stack react-app --scan-root services/webapp/src --no-biome --no-tsconfig
```

Flags: `--no-biome` `--no-tsconfig` `--no-skills` `--no-husky` `--no-structure`
`--no-guards` `--no-fallow`, `--guards <a,b,…>` (a subset of `size,fanout,dup,clone,decisions`),
`--fallow` (opt-in code-health layer), and `--scan-root <a,b,…>` (override `guard.config.json`
`scanRoots` up front — set **before** the freezes + the `react-app` `structureRoot`, so a
non-`src` root like `services/webapp/src` is grandfathered correctly without an edit-then-refreeze).
A non-TTY run without `--yes` behaves as `--yes` plus any `--no-*` flags (it never hangs
waiting for input). `--dry-run` prints every action and writes nothing.

### Removing a deselected component

Re-running `init` and **deselecting** a component that's currently installed triggers
removal. In the wizard you're asked per component (`Remove <x>? It's currently installed.`,
default **NO** — removal is non-destructive). Non-interactively, pass
`--remove-deselected` (with `--yes`) to remove without prompting:

```bash
bunx devkit init --yes --no-biome --remove-deselected   # uninstall biome
```

Removal is **safe — it never deletes a file devkit didn't create**:

- **biome** → deletes `biome.jsonc`, drops the `@biomejs/biome` devDep + `lint`/`format` scripts + the biome step from the hook block.
- **tsconfig** → strips only the devkit `extends` (a `tsconfig.json` with your own content is kept; if it's left with no extends, you're told to review it).
- **a guard** → removes just that gate line from the `# devkit-guards` block, keeping the others.
- **skills** → removes the devkit-synced files (per the manifest) from `.claude`/`.cursor` + drops the manifest. **Consumer-authored skills are never touched.**
- **husky** → removes the whole `# devkit-guards` block, leaving the rest of your hook.
- **structure** → removes the eslint files **only if devkit created them** (guarded by the recorded config) + re-comments the structure-lint line.

### Structure stack (`--stack electron`)

Additionally emits the structure-governance `eslint.config.mjs` + a growable
domain-registry skeleton and grandfathers the folder-structure + import-wall baselines, so
the boundary/structure walls go live **born-grandfathered**. `init` **prints** (never
installs) the referenced-tool steps (fallow, the search-code MCP index).

### Structure stack (`--stack react-app`)

Ships a **LIGHT** preset for any plain Vite/CRA app: PascalCase component/page folders +
file/function size caps + fan-out (via `guard.config.json`) — and nothing else. The
frink-renderer taxonomy is deliberately **not** imposed: no `lib/<domain>` mandate, no
import walls, and the domain registries (`eslint/domains.mjs`) ship **empty +
grandfathered** (every existing top-level folder is left ungoverned). You **AMEND** it
per-repo: register a concern in `eslint/domains.mjs` (or copy a `structureRoot` block to
govern a new folder), then **re-run the baseline generator** (`devkit init --stack
react-app`) to grandfather the current tree. A non-standard `src` root (e.g. a monorepo
package at `services/webapp/src`) is set via `guard.config.json`'s `scanRoots`, not eslint.

### `devkit doctor`

`bunx devkit doctor [--fix]` checks the wiring for the **installed component set** only (a
deselected component is never flagged as missing) — husky calls the selected guards,
configs extend the bases, skills match the manifest, baselines exist, devkit pinned to a
tag. Exit `0` OK / `1` drift / `2` not-initialized. `--fix` re-runs `init` **for the
recorded selection** (it won't silently re-add a component you removed).

## Standalone (no-package) — "like `fallow init`"

For a **shared / work repo** you may not want a private `@norvalbv/devkit` entry in
`package.json` (it forces every teammate to have repo access just to `bun install`). Standalone
mode mirrors `fallow init`: install devkit **globally**, scaffold the repo, and the gates run off
the global CLI — **package.json is never touched.**

```bash
bun add -g git+ssh://git@github.com/norvalbv/devkit.git#v0.8.0   # once per machine
cd <shared-repo>           # (or a package subdir in a monorepo)
devkit init --standalone   # --stack <x> --scan-root <p> etc. all still apply
```

What standalone does differently:

- **package.json**: untouched — no devkit dep, no scripts.
- **biome / tsconfig**: devkit's bases are **vendored** into `.devkit/{biome,tsconfig}/` and your
  `biome.jsonc` / `tsconfig.json` extend them by **relative path** (no package to resolve).
  Re-run `init` to refresh the vendored copies on a devkit bump.
- **hook**: a committed `.husky/pre-commit` whose gates call the **global** `guard-*` bins,
  **fail-open** — `command -v guard-X || skip`. A teammate without devkit installed is **never
  blocked** (exactly fallow's `command -v fallow || exit 0`); a real violation (gate exit 1) still
  blocks. Wired via `core.hooksPath` — **no `husky` dependency**.
- **structure-lint** is **omitted** in standalone (its eslint flat-config needs the plugin
  resolvable from the repo, which a no-package setup can't provide; it also doesn't apply to a
  `generic` stack). The ratchet guards + biome cover the shared-repo case.

`devkit doctor` is standalone-aware (no pin check; verifies the vendored relative-extends).

## Overlay (local-only) — invisible + non-invasive

For a repo you **can't modify** — a shared work repo whose team would reject a devkit PR — but
where you still want the guardrails locally. Overlay mode touches **nothing committed** and is
**invisible to git**:

```bash
bun add -g git+ssh://git@github.com/norvalbv/devkit.git#v0.8.0   # once per machine
cd <work-repo>
devkit init --overlay
```

- **Invisible**: every devkit file is added to **`.git/info/exclude`** (per-clone, uncommitted —
  not `.gitignore`, which the team would review). `git status` stays clean.
- **Non-invasive pre-commit**: the repo's committed husky hook is **not edited**. `core.hooksPath`
  (a **local** git config, never committed) points at a git-ignored `.devkit/hooks/` whose hook
  runs devkit's gates, then `exec`s the repo's own hook unchanged. **Every other hook the repo
  has** (`pre-push`, `commit-msg`, …) gets a pass-through wrapper, so taking over `core.hooksPath`
  never silently drops one.
- **ours-extends-theirs**: `eslint.config.devkit.mjs` / `biome.devkit.jsonc` (git-ignored)
  **import + extend** the repo's committed configs and add devkit's rules; the local hook runs
  them over **staged files only** (your changes are checked without flooding on existing code).
- **package.json untouched.**

Caveat: husky's `prepare` re-claims `core.hooksPath` on the next `bun install` — re-run
`devkit init --overlay` (idempotent) to re-apply. `devkit doctor` reports if it was reclaimed.

**Undo it all:** `devkit clean` restores `core.hooksPath` to exactly what it was, removes every
devkit file, and prunes the devkit lines from `.git/info/exclude` — the repo goes back to
untouched. (`devkit clean` also uninstalls a package/standalone install: removes the configs,
the `# devkit-guards` hook block, skills, and the `@norvalbv/devkit` dep + devkit scripts.)

## AGENT half — skills

Skills live under `skills/` and ship **inside this package** (same repo, same tag as the
engine). `devkit init` (or `devkit sync-skills`) copies them into the consumer's
`.claude/skills` + `.cursor/skills` and writes `.devkit/skills-manifest.json` (per-file
SHA-256) so `doctor` detects drift. A skill and the gate-engine bin it drives stay
lock-stepped to one tag. (We do **not** use `npx skills` — its private-repo support is
unreliable; bundling skills in the package is the maintainable single channel.)

## Updating devkit (consumers)

Bump the pinned tag, then — two bun gotchas worth knowing:

```bash
bun pm cache rm            # bun caches git deps; without this it won't see the new tag
# edit package.json's devkit dep to the new #vX.Y.Z, then:
bun install                # use install for a RE-PIN; `bun add` can hit a DependencyLoop
                           # transitioning one git-tag ref to another
bunx devkit doctor --fix   # re-sync skills + template configs to the new version
```
