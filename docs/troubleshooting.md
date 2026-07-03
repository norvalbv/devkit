# devkit troubleshooting

Common failures and what to do. Terms in **bold** are defined in [glossary.md](glossary.md).

> **Layout note:** paths below (`src/`, `services/webapp/src`, …) are examples. Your repo's real roots
> live in `guard.config.json` — map each example to your own tree.

## `git is not installed or not on PATH`
A devkit command that needs git (init, doctor, clean, move, ship, release, update) couldn't find git.
Install git (https://git-scm.com/downloads) and re-run. devkit shells out to git for nearly everything.

## `invalid JSON: …` from `devkit doctor`
A managed config (`biome.jsonc`, `tsconfig.json`) has a syntax error (a trailing comma, a missing brace).
doctor now reports the parser's reason. Fix the JSON and re-run `devkit doctor`. For `guard.config.json`
specifically, the error comes from the config loader — same fix.

## I ran `devkit init` but a package in my monorepo isn't governed
devkit is git-root-aware: in a monorepo, run `init` **inside the package**, not at the repo root. The
pre-commit hook lives at the git root with a **package-scoped** block. Example:
`cd services/webapp && bunx devkit init --stack react-app`. Re-run `devkit doctor` from that package dir.

## My commit didn't run the gates (overlay mode)
In **overlay mode** a plain `git commit` (or an IDE/GUI commit) runs the **repo's own** hooks, not devkit's —
that's the **self-heal** gap. Commit via the per-clone `git ci` alias instead, or enable the opt-in global
shim with `devkit init --overlay --global-commit-gate`. See **overlay self-heal** in the glossary.

## `devkit doctor` reports skills/agents drift
A synced copy in `.claude/` or `.cursor/` diverged from its **manifest** (or devkit's source moved ahead).
Re-run `devkit sync-skills` / `devkit sync-agents` (NOT a hand edit). `devkit doctor --fix` also repairs it.

## My stack was detected as `generic`
Detection is heuristic (it reads framework markers in package.json). If nothing matched, you get `generic`,
which ships **no structure preset**. Set it explicitly: `devkit init --stack react-app` (or electron/next/…).

## A pre-commit gate blocked my commit
- **fanout** — too many impl files in one folder. Split it into cohesive kebab-named subfolders (don't
  `freeze` to launder it). See the **ratchet** / **baseline** entries in the glossary, and the
  `structure-governance` skill.
- **size** — you added an `eslint-disable max-lines`; the count may only shrink. Refactor instead.
- **decisions / dup / clone** — see each gate's message; it names the offending file and the fix.

## Commit blocked because I'm on a protected branch
Don't hand-roll a branch (that moves a shared checkout's HEAD). Use `devkit ship <branch> "<title>" -- <paths>`
— it commits onto a new branch and opens a PR **without** moving HEAD, so parallel agents stay undisturbed.

## After my PR merged, the shared checkout still has stale files
Don't `git pull` / `git restore` by hand on a shared tree. Run `devkit reconcile` (dry-run) then
`devkit reconcile --apply` — it confirms each PR is merged, restores only still-pristine files, and never
moves the shared HEAD or clobbers a concurrent edit.

## `devkit ship` stopped at `⏱ ship: gate chain hit the …s ceiling (exit 124)`
This is **budget, not a hang** — the banner says so. The gate chain has a **hang ceiling**
(`SHIP_COMMIT_TIMEOUT`, default 1800s); hitting it usually means the first attempt ran out of budget, not
that a gate wedged. Everything earned is cached — completed reviewer verdicts (**checkpointed verdicts**),
cleared decisions judgements, and the all-green **deterministic-prefix cache**. **Re-run the same
`devkit ship` command**: only unfinished work re-runs, so the retry converges. The banner names the stage
it was mid-flight in and any reviewers missing a completion heartbeat. For more room per attempt, see
`SHIP_COMMIT_TIMEOUT` below.

## A `.devkit/` ship cache looks stale (gates pass when they shouldn't)
The **deterministic-prefix cache** and **checkpointed verdicts** live under `.devkit/`, keyed on the
staged-tree hash and evidence bytes. They can go stale against **gitignored** inputs a gate reads but the
key can't see (e.g. the search-code index behind `guard-dup`). Escape hatches — both only discard cached
*passes*, never hide a failure:
- `guard-prefix clear` — drop the cached all-green deterministic prefix (forces a full deterministic re-run).
- `guard-review clear-cache` — drop cached reviewer PASS verdicts (forces the reviewers to re-run).

## `✗ deterministic gates failed: <names>`
The deterministic gates (structure, fanout, size, dup, clone …) run all-and-**aggregate**: instead of
failing fast on the first, they collect every failure into one report naming each (`guard-<id>`). Fix each
named gate (see **A pre-commit gate blocked my commit** above) and re-commit — the **deterministic-prefix
cache** means the gates that already passed won't re-run. AI gates are the exception: they stay fail-fast,
one finding at a time, by design.

## I set `SHIP_COMMIT_TIMEOUT` but the ship still uses the default
It must be **exported**, not passed inline: `export SHIP_COMMIT_TIMEOUT=2400 && devkit ship …`, not
`SHIP_COMMIT_TIMEOUT=2400 devkit ship …`. An inline env prefix can be stripped by a command-rewriting
shell hook (a proxy that rewrites your git/devkit commands) before the gate chain reads it, so the default
silently wins. Export it in the shell the ship runs in.
