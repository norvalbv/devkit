# devkit glossary

The jargon you'll meet in devkit's help, prompts, and gate output — in one place.

> **Layout note:** any concrete directory path below (e.g. `src/`, `services/webapp/src`) is an
> **example**, not a universal name. Your repo's real roots live in `guard.config.json`
> (`scanRoots`, `structure.trees`, `review` roots) — read each path here as a placeholder and map
> it to your own tree.

## Install modes

- **package mode** (default) — devkit is a dev dependency (`bun add -D git+ssh://…#vX.Y.Z`). Configs
  `extends` the published subpath; the pre-commit hook calls `bunx guard-*`. Auto-updates on a tag bump.
- **standalone mode** (`devkit init --standalone`) — no package.json dependency. Configs are **vendored**
  into `.devkit/`, and a **fail-open** hook calls the **global** `guard-*` bins. For shared repos where a
  private dependency is unwanted. Requires devkit installed globally (`bun add -g`).
- **overlay mode** (`devkit init --overlay`) — for a repo you can't modify. Everything is git-ignored via
  `.git/info/exclude` (invisible to the team), the local hook **chains** to the repo's own, and the
  eslint/biome configs **extend** the repo's. Requires global devkit. See **self-heal** below.

## Gates & enforcement

- **gate** — a check that runs in the pre-commit hook and can block a commit (e.g. duplication, clone,
  decisions). Each gate reads `guard.config.json`.
- **ratchet** — a gate that only allows a metric to **shrink**, never grow:
  - **fanout** (`guard-fanout`) — caps the number of impl files in one folder (`fanoutCap`). Over the cap →
    split the folder into cohesive kebab-named subfolders.
  - **size** (`guard-size`) — the count of `eslint-disable max-lines` may only go down.
- **baseline** — a one-time snapshot of pre-existing violations (`eslint/baselines/*.mjs`) that are
  grandfathered in. Generated **once**, then shrink-only — devkit never re-snapshots to "launder" new debt.
- **fail-open** — a gate that, when it can't run (missing index, missing dep), **allows** the commit rather
  than blocking. Standalone hooks are fail-open by design.
- **fail-closed** — the ship-only inverse of **fail-open**: when a strict AI gate can't reach a verdict
  (a `claude` outage, or inconclusive after its one retry) it **blocks** the ship instead of skipping.
  Armed by `GUARD_AI_STRICT=1`, which only `devkit ship` exports; an ad-hoc `git commit` stays fail-open.
- **exit-3 contract** — a strict AI gate that fails closed exits **3**, kept distinct from a real finding's
  exit **1** (and a deterministic fail-open's **2**). Exit 3 means "the judge couldn't run — check `claude`
  auth and re-run", never "the code failed review", so a hook never renders an outage as an opus-confirmed
  FAIL. Only ship's `GUARD_AI_STRICT` produces it; hand-authored consumer hooks must special-case it.
- **deterministic-prefix cache** (`guard-prefix`) — once every deterministic gate passes, their all-green
  result is cached against the staged tree's hash under `.devkit/`, armed only under `DEVKIT_SHIP=1` (a ship
  worktree, where working tree ≡ index, is the key's soundness bound). A re-run with an unchanged staged tree
  skips the whole deterministic block. Stale against gitignored inputs → `guard-prefix clear`.
- **checkpointed verdicts** — earned AI verdicts persist per-completion so a killed ship re-runs only
  unfinished work: reviewer PASSes checkpoint as each reviewer finishes (not batched at the end), and
  decisions ROUTINE/ALIGN/depth-PASS verdicts cache on their exact evidence bytes (`.devkit/`). This is what
  lets a ship retry **converge** instead of restart. Drop them with `guard-review clear-cache`.

## Config & structure

- **scanRoot** (`scanRoots`) — the directories a gate scans (e.g. `["src"]`). Set up front with
  `devkit init --scan-root <a,b>` for a nested app; **never** the devkit package dir.
- **boundary / domain** — `structure.trees` describes allowed folders (boundaries) and the kinds of files
  (domains) each may hold. The structure gate enforces "one home per kind".
- **stack** — the repo's framework preset (`electron | react-app | next | node-service | generic`),
  auto-detected from package.json or set with `--stack`. `generic` ships no structure preset.

## Sync & versioning

- **manifest** — `.devkit/skills-manifest.json` / `agents-manifest.json`: a sha256 per synced file so
  `devkit doctor` can tell which side (devkit source vs your committed copy) drifted.
- **drift** — your repo no longer matches what `devkit init` would produce (or a synced copy diverged from
  its manifest). `devkit doctor` reports it; `devkit doctor --fix` repairs the repairable parts.
- **minDevkit** — an optional `"minDevkit":"x.y.z"` floor in `.devkit/config.json`. `doctor` warns if the
  running devkit is older. Config-only (never package.json) so overlay/standalone repos stay invisible.

## Overlay self-heal

- **self-heal / `git ci` alias** — in overlay mode, a plain `git commit` runs the **repo's own** hooks, not
  devkit's (devkit's hook lives outside the committed tree). The per-clone `git ci` alias re-points
  `core.hooksPath` to devkit's hook just before committing, so the overlay gates actually run. A plain
  `git commit` (or an IDE/GUI commit) **skips** them — see [troubleshooting.md](troubleshooting.md). An
  opt-in machine-global husky shim (`devkit init --overlay --global-commit-gate`) closes this gap.
