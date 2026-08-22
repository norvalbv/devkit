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

## My commit in a worktree ran a DIFFERENT checkout's hook

Symptom: a commit made in a linked worktree is blocked by a gate that worktree's own
`.husky/pre-commit` doesn't even contain (or sails past one it does). The hook that ran belongs to
another checkout — usually the main one, on its branch, at its version.

Diagnose in one line, from the worktree:

    git config --worktree --get core.hooksPath

An **absolute** path into another checkout is the fault. Some worktree tooling writes it right after
`git worktree add`, back when husky gitignored the `.husky/_` runner and a fresh worktree genuinely
had none — borrowing the main checkout's beat having no gates at all. Once the runner is **tracked**
(`devkit sync-hook-runner`) every checkout carries its own, and the pin only shadows it.

Fix: `devkit sync-hook-runner` in that worktree. Once the checkout provably gates itself, it replaces
the exact sibling value with the repo's relative fallback (usually `.husky/_`) in one locked Git
config write; `devkit doctor` reports the state as **hooksPath owner** either way. It will not replace
an external central-hooks path, an ambiguous value, or a target Git no longer records as a sibling.

Two scopes are _not_ covered, by design. A **repo-wide** `core.hooksPath` (`git config --local`) is
reported but never replaced — it belongs to the repo, not to one checkout. And a value arriving via
`GIT_CONFIG_*`, `--global` or `--system` is invisible to `devkit doctor`, while `devkit review` reads
the fully merged value and _does_ see it — so review can fail on a hooksPath doctor calls fine.

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
- **decisions / dup / clone / comments** — see each gate's message; it names the offending file and
  the fix. For `guard-comments`, remove the explanatory workaround or run the printed
  `guard-comments justify <id> "<specific rationale>"` command. The rationale is local evidence,
  not a bypass: an independent reviewer must still approve it.

## `guard-comments` blocked an added or modified comment paragraph

The gate challenges standalone staged JS/TS-family comment paragraphs when the staged change adds
or modifies at least three non-structural text lines. One- and two-line changes, inline comments,
untouched comments, deletions, and pure renames pass automatically. Long license or generated
headers are reviewed like any other paragraph; keywords never bypass the gate. Prefer fixing the
implementation and deleting workaround narration. When a
paragraph carries a durable constraint that code, types, assertions, or tests cannot express, use
the exact finding ID printed by the gate:

    guard-comments justify <finding-id> "why this constraint must remain"
    guard-comments justify <finding-id> "why temporary debt is unavoidable and what removes it" --ticket SC-123

When `devkit ship` finds a comment only after applying your scoped changes to the requested current
base, its failed-worktree cleanup removes the staged context that produced that ID. Use the exact
`--from-ship-log` command printed by that ship attempt. It validates the unresolved finding against
the retained caller-root gate log before recording the same pending evidence in shared Git-local
state; it does not approve the rationale, and the next ship still runs the independent reviewer.

The command records pending evidence under the repository's local Git metadata, so it is shared by
linked worktrees but never committed. If two worktrees encounter the same finding ID, they may share
identical evidence; conflicting rationale text is rejected instead of silently overwriting either
author. Legacy tracked rationale files are recovered from the pre-change Git blob and merged once per
worktree; after upgrading, commit the generated file's deletion. Managed review reads shared evidence
but redirects mutations into its private review-data root. One Haiku request reviews every pending
paragraph in the gate run and returns a decision per finding. Exit 2 means the reviewer is temporarily unavailable in the
ordinary fail-open policy; exit 3 means the same outage under strict policy; exit 4 means local
evidence, configured language support, or receipt persistence is unsafe, so the commit stays
blocked. Each entry records its owning worktree, so `justify` never prunes and `guard-comments
prune` removes only obsolete entries owned by the calling worktree. Other linked worktrees and
entries created after the prune snapshot remain intact.

## The dup gate names a symbol my file doesn't define (extract refactor blocked)

It can't any more, and if you see it on an older devkit: **the search-code index is stale, not your code.**
`guard-dup` now verifies every pair against the working tree first — a side whose indexed body is no
longer on disk drops the pair and is printed as `Stale index — dropped N candidate pair(s) …`. That is a
_withheld_ finding: re-index those files (`search-code index --seed-files "<files>"`) and re-run to get
coverage back. **Never** paste the `guard-dup-allowlist add` command for such a pair — it would record a
permanent approval for a duplication that does not co-exist. A `Freshness NOT verified` line means the
index carries no `raw_code`/`id` (or its paths don't resolve here), so the pairs above it were reported
unchecked — eyeball the ranges before approving. `GUARD_DUP_VERIFY_TREE=0` disables the check.

## `devkit doctor` reports `search-code index: DRIFT` or `MISSING`

These index-freshness findings are advisory: they keep their warning glyph but do not make doctor exit
nonzero. `DRIFT` means the owned index has file stamps behind the checkout; force-refresh the named files
with `touch <files> && search-code index --seed-files "<files>"`. `MISSING` is common in a clone or linked
worktree because the index is gitignored: build it locally, or link the primary checkout's `.search-code`
directory (`devkit ship` does this automatically). Scan-time body verification remains the gate's source
of truth while the index is stale or its freshness metadata cannot be inspected.

## Commit blocked because I'm on a protected branch

Don't hand-roll a branch (that moves a shared checkout's HEAD). Use `devkit ship <branch> "<title>" -- <paths>`
— it commits onto a new branch and opens a PR **without** moving HEAD, so parallel agents stay undisturbed.

## After my PR merged, the shared checkout still has stale files

Don't `git pull` / `git restore` by hand on a shared tree. Run `devkit reconcile` (dry-run) then
`devkit reconcile --apply` — it confirms each PR is merged, restores only still-pristine files, and never
moves the shared HEAD or clobbers a concurrent edit.

## `devkit ship` stopped at `⏱ ship: gate chain hit the …s ceiling (exit 124)`

This is **budget, not a hang** — the banner says so. The gate chain has a **hang ceiling**
(`SHIP_COMMIT_TIMEOUT`, default 3600s); hitting it usually means the first attempt ran out of budget, not
that a gate wedged. Everything earned is cached — completed reviewer verdicts (**checkpointed verdicts**),
the completeness judgement, cleared decisions judgements, and the all-green **deterministic-prefix cache**. **Re-run the same
`devkit ship` command**: only unfinished work re-runs, so the retry converges. The banner names the stage
it was mid-flight in and any reviewers missing a completion heartbeat. For more room per attempt, see
`SHIP_COMMIT_TIMEOUT` below.

## A `.devkit/` ship cache looks stale (gates pass when they shouldn't)

The **deterministic-prefix cache** and **checkpointed verdicts** live under `.devkit/`, keyed on the
staged-tree hash and evidence bytes. They can go stale against **gitignored** inputs a gate reads but the
key can't see (e.g. the search-code index behind `guard-dup`). Escape hatches — the first two only
discard cached _passes_, never hide a failure:

- `guard-prefix clear` — drop the cached all-green deterministic prefix (forces a full deterministic re-run).
- `guard-review clear-cache` — drop cached reviewer PASS verdicts (forces the reviewers to re-run).
- `rm .devkit/sentry-verdict-cache.json` — drop cached sentry-judge verdicts. Unlike the two above, this
  store also persists a confident **MONITOR** (a block): a byte-identical retry replays it **by design**,
  and any restage of the staged diff re-judges (the cache is diff-tier-only), so remove the file only when
  a cached block is provably stale (e.g. after rolling devkit back).

## `✗ deterministic gates failed: <names>`

The deterministic gates (structure, fanout, size, dup, clone …) run all-and-**aggregate**: instead of
failing fast on the first, they collect every failure into one report naming each (`guard-<id>`). Fix each
named gate (see **A pre-commit gate blocked my commit** above) and re-commit — the **deterministic-prefix
cache** means the gates that already passed won't re-run. AI gates are the exception: they stay fail-fast,
one finding at a time, by design.

## `bun install` fails: `no commit matching "<sha>" found for "@norvalbv/devkit"`

Also seen as `error: GET https://codeload.github.com/norvalbv/devkit/legacy.tar.gz/<sha> - 404`. Two shapes,
one fault: bun clones for a `git+ssh`/`git+https` ref and fetches a codeload tarball for the
`github:owner/repo` shorthand. Your `bun.lock` recorded a specific object for the devkit tag it resolved,
and that object is no longer reachable on the remote — the tag was re-pointed, or the history under it was
rewritten. Machines that already have it cached keep working; a fresh clone or CI does not.

Repair it with **`bun update @norvalbv/devkit`**, which re-resolves the pin from `package.json`.

- **`devkit update` will NOT fix this.** When the repo already pins the newest tag it short-circuits with
  "devkit is up to date" and changes nothing — you'll see success and stay broken.
- **`bun install --force` does not re-resolve** either; it only re-extracts.
- **Don't reach for `bun pm cache rm`.** It isn't needed, and it deletes the one local copy of the orphaned
  object — which can break a machine that was still working.
- If it somehow persists, delete the `@norvalbv/devkit` lines from `bun.lock` and re-run `bun install`.

`devkit doctor` reports this as **devkit lock** DRIFT before it bites, so you find it on a working machine
rather than in CI.

## I set `SHIP_COMMIT_TIMEOUT` but the ship still uses the default

It must be **exported**, not passed inline: `export SHIP_COMMIT_TIMEOUT=2400 && devkit ship …`, not
`SHIP_COMMIT_TIMEOUT=2400 devkit ship …`. An inline env prefix can be stripped by a command-rewriting
shell hook (a proxy that rewrites your git/devkit commands) before the gate chain reads it, so the default
silently wins. Export it in the shell the ship runs in.
