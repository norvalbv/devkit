# @norvalbv/devkit

Single source of truth for my reusable developer toolkit. One git repo, two halves shipped on the
**same tag** so an agent skill and the engine it drives can never drift apart:

| Half      | What                                                                       | How consumers get it |
| --------- | -------------------------------------------------------------------------- | -------------------- |
| **AGENT** | `skills/` + `agents/` — Claude/Cursor skills + reviewer/testing subagents  | bundled in the package; `devkit init` / `devkit sync-skills` / `devkit sync-agents` copy them in |
| **CODE**  | shared **configs** (Biome, tsconfig) + the portable **gate-engine**        | `bun add -D git+ssh://git@github.com/norvalbv/devkit.git#<tag>` |

## Reference

- **Commands:** `devkit help` lists them all; `devkit help <command>` (or `devkit <command> --help`) prints full options.
- **[docs/glossary.md](docs/glossary.md)** — package/standalone/overlay modes, gates, ratchets, baselines, scanRoot, manifest, self-heal.
- **[docs/troubleshooting.md](docs/troubleshooting.md)** — missing git, corrupt config JSON, monorepo setup, overlay self-heal, blocked commits, post-merge reconcile.
- **[docs/structure-governance.md](docs/structure-governance.md)** · **[docs/directory-structure.md](docs/directory-structure.md)** — folder + import-wall governance.
- **[docs/decisions/INDEX.md](docs/decisions/INDEX.md)** — the why-store (current ruling per architectural axis).

## The one rule: ship the generator, never the data

devkit ships **mechanisms** — the gate engines, the config loader, the shared lint/TS configs. It
never ships a consumer's **data**: no baselines, no allowlists, no decision log, no
`guard.config.json`. Those are born and live in each consumer repo. Bump the tag to update the
engine; your data is untouched because it was never in here.

**W-3 — everything resolves against the CONSUMER cwd.** Every path the engine touches (`scanRoots`,
the decisions dir, the allowlist, the search-code index) resolves against the consumer's working
directory, never `__dirname` (the package dir in `node_modules`). An engine run from another repo
scans **that** repo.

## Three ways to consume devkit

| Mode | How | When |
| ---- | --- | ---- |
| **Package** (default) | `bun add -D` the git dep; configs `extends "@norvalbv/devkit/…"`; hook calls `bunx guard-*` | your own repos — auto-updates on a tag bump |
| **Standalone** (`--standalone`) | `bun add -g` devkit once; vendors configs + a **fail-open** hook calling the global `guard-*` bins; **nothing in package.json** | shared / work repos where a private dep is unwanted, or you want zero tool deps |
| **Overlay** (`--overlay`) | global devkit; everything **git-ignored**, the hook **chains** to the repo's own, configs **extend** theirs | a repo you **can't modify** — local + invisible |

See [docs/glossary.md](docs/glossary.md) for what each mode means and `devkit help init` for the flags.

**Zero consumer tool-deps.** devkit bundles the gate tools (jscpd, eslint + the structure plugin), so
a consumer's `package.json` never gains them. The clone gate resolves devkit's own jscpd; structure-lint
runs through the `guard-structure` bin (devkit's own eslint + plugin) for the config-driven stacks
(react-app, component-lib). So **package mode adds only `@norvalbv/devkit` (+ biome/husky)**, and
**standalone adds nothing at all** — with structure-lint now included in both. (electron keeps its
consumer-side eslint preset.) Standalone gates are **fail-open**, so CI/contributors must install the
pinned global devkit (`bun add -g …#<devkitRef>`); without it the gates silently skip.

## Install (package mode)

```bash
bun add -D git+ssh://git@github.com/norvalbv/devkit.git#<tag>
```

- **Private repo:** use the `git+ssh://` form, not bun's `github:` shorthand — the latter resolves
  through GitHub's API tarball endpoint, which 404s on a private repo.
- **No build step, no `dist/`** — everything ships as runnable `.mjs` / `.json` / `.jsonc`. What you
  install is what runs.

### Extend the BARE subpath, never a file path

```jsonc
// biome.jsonc
{ "extends": ["@norvalbv/devkit/biome/base"] }    // or "@norvalbv/devkit/biome/react"
// tsconfig.json
{ "extends": "@norvalbv/devkit/tsconfig/base" }   // also .../tsconfig/next · .../tsconfig/node
```

Do **not** write `@norvalbv/devkit/biome/base.jsonc` — the exports map owns the file extension;
commit to the stable bare name and the package decides what backs it.

## gate-engine — portable governance gates

Seven bins, run from your repo root (e.g. in a pre-commit hook), each scanning the **consumer's**
cwd. They read **one** config — `guard.config.json` at the repo root (copy `guard.config.example.json`,
drop the `//`-comment keys). The shared loader `@norvalbv/devkit/gate-engine/config`
(`resolveGuardConfig`) is the single source of defaults + `GUARD_*` env overrides.

| bin                   | engine |
| --------------------- | ------ |
| `guard-decisions`     | append-only decision-log CLI + architectural-smell gate (`detect`) + flip-flop guard (`check-alignment`) |
| `guard-dup`           | semantic cross-file duplication matcher (search-code index) |
| `guard-clone`         | token-level copy-paste / clone detector (jscpd) |
| `guard-fanout`        | folder fan-out ratchet (≤N impl files/folder, any depth) |
| `guard-size`          | size-disable ratchet (`eslint-disable max-lines` may only shrink) |
| `guard-fallow-staged` | re-scopes a `fallow audit` JSON to the staged-diff overlap |
| `guard-sentry`        | commit-msg advisory judge — flags a swallowed runtime error-class worth a Sentry capture |

## Onboarding — `devkit init`

```bash
bunx devkit init     # interactive wizard on a TTY; --yes for all defaults; --dry-run to preview
```

Auto-detects the stack, lets you pick components + gate-engine guards, scaffolds them, and records
the selection in `.devkit/config.json` (so `doctor` knows what to check). Monorepo: run `init`
**inside the package** — devkit is git-root-aware (the hook installs at the git root with a
package-scoped block). Full flags, components, and removal: `devkit help init`. Verify the wiring
anytime with `devkit doctor` (`--fix` re-runs init for the recorded selection).

## Updating (consumers)

One command reconciles a consumer fully — pin + devkitRef, emitted configs, skills/agents/hooks,
and the husky/guard block — reading the recorded selection from `.devkit/config.json`:

```bash
bunx devkit upgrade            # --dry-run to preview; --force to adopt consumer-authored asset collisions
```

`upgrade` composes the individual slices idempotently and ends by running `doctor`. If a newer tag
has been *published*, it installs it and asks you to re-run (a running CLI can't hot-swap to
just-installed code); for a local checkout / already-current install it reconciles in one pass and
never re-adds a deselected agent surface. Consumer-tuned configs are never overwritten — record an
intentional override in `.devkit/config.json` `configOverrides: ["tsconfig.json"]` so `doctor`
treats it as OK, not drift.

The slices are still available if you want to run them by hand: `devkit update` (self-update the
package), `devkit migrate --apply` (reconcile emitted configs), `devkit sync-skills` /
`devkit sync-agents`, and `devkit doctor --fix` (re-run init for the recorded selection).
