# @norvalbv/devkit

Single source of truth for my reusable developer toolkit. One git repo, two halves:

| Half      | What                                                          | How consumers get it                       |
| --------- | ------------------------------------------------------------ | ------------------------------------------ |
| **AGENT** | `skills/` — Claude/agent skills (governance, design, review) | `npx skills add github:norvalbv/devkit/<skill>` |
| **CODE**  | shared **configs** (Biome, tsconfig) + the **gate-engine**   | `bun add git+ssh://git@github.com/norvalbv/devkit.git#<tag>` |

The two halves ship from the **same repo, same tag** so an agent skill and the engine
it drives can never drift apart.

## The one rule: ship the generator, never the data

devkit ships **mechanisms** — the gate engines, the config loader, the shared lint/TS
configs. It never ships a consumer's **data**: no baselines, no allowlists, no decision
log, no `guard.config.json`. Those are born and live in each consumer repo, addressed
relative to the consumer's cwd (see "W-3" below). Update the engine by bumping the tag;
your data is untouched because it was never in here.

## CODE half

### Install (consumer)

```bash
bun add -D git+ssh://git@github.com/norvalbv/devkit.git#v0.1.0
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

## AGENT half

Skills live under `skills/` and install with the `skills` CLI, same repo + tag:

```bash
npx skills add github:norvalbv/devkit/<skill-name>
```

A skill and the gate-engine bin it invokes are versioned together — adopt a tag and
both halves move in lock-step.
# devkit
