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

## `devkit init: another devkit init/upgrade is running in <root> (pid N)`

`devkit init` and `devkit upgrade` hold one lock per repository for their whole run. The lock sits
in the git admin dir, as `.git/devkit-init.lock` (or under the `gitdir:` a worktree's `.git` file
names), so it can never be staged. Outside git it is `.devkit/init.lock`. A second run waits about
5 seconds and then refuses, instead of overwriting the first run's component record and undoing its
installs. Monorepo packages share the one lock.

Wait for pid N to finish, then re-run. A lock left by a crashed run is removed automatically once it
is older than 60 seconds and its pid is gone. To clear one sooner, check that the pid is not running
and delete the lock path the message prints. `--dry-run` never takes the lock.

## My commit didn't run the gates (overlay mode)

In **overlay mode** a plain `git commit` (or an IDE/GUI commit) runs the **repo's own** hooks, not devkit's —
that's the **self-heal** gap. Commit via the per-clone `git ci` alias instead, or enable the opt-in global
shim with `devkit init --overlay --global-commit-gate`. The shim runs the pre-commit gates and the
completeness and sentry commit-message judges. Husky only reaches it for a hook the repo commits, so the
judges need a committed `.husky/commit-msg` (`devkit doctor` warns when one is missing). A shim an older
devkit wrote runs the pre-commit gates only until `devkit doctor --fix` refreshes it. See **overlay
self-heal** in the glossary.

**In a linked worktree** (`git worktree add`), the overlay's hooks run too: `core.hooksPath` is the
absolute path of the overlay's `.devkit/hooks`, and a commit in a worktree that lacks any of the overlay's
gate inputs projects them in first (a `✓ <worktree>: projected …` line). When that projection fails, or
devkit is not on PATH, the commit is **blocked** rather than run without gates, and the lines above it
name the fix: install devkit, add a slash-less `.git/info/exclude` line, or run `devkit doctor --fix`.
An install from before this change wrote a relative path, and under it every linked worktree ran no
hooks at all. `devkit doctor --fix` (or `devkit upgrade`) re-points it.

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

In devkit's own repo, run these from source: `bun run devkit sync-skills`. A global or `dist/` devkit
would hash its own bundled skills into the manifests and revert every entry the checkout has moved
past, so the writers refuse it with that remedy.

## My stack was detected as `generic`

Detection is heuristic (it reads framework markers in package.json). If nothing matched, you get `generic`,
which ships **no structure preset**. Set it explicitly: `devkit init --stack react-app` (or electron/next/…).

## A pre-commit gate blocked my commit

- **fanout** — too many impl files in one folder. Split it into cohesive kebab-named subfolders (don't
  `freeze` to launder it). See the **ratchet** / **baseline** entries in the glossary, and the
  `structure-governance` skill.
- **size** — you added an `eslint-disable max-lines`; the count may only shrink. Refactor instead.
- **decisions / dup / clone / comments** — see each gate's message; it names the offending file and
  the fix. For `guard-comments`, shorten the paragraph to two lines or move the explanation into
  code, tests, or a decision record; there is no waiver.

## `guard-comments` blocked an added or modified comment paragraph

The gate is deterministic. It blocks any standalone JS/TS-family comment paragraph where the staged
change adds or modifies three or more non-structural text lines; comment groups separated only by
blank lines count as one paragraph. One- and two-line changes, inline comments after code, untouched
comments, deletions, and pure renames pass automatically. Keywords, license headers, and JSDoc tags
never exempt a paragraph.

Shorten the paragraph to at most two lines, or move the information into code, types, a test
name/assertion, or a decision record (`guard-decisions`). There is no rationale, waiver, or reviewer.
Exit 4 means the staged evidence was unreadable or a configured language has no lexer adapter; that
is not a rejection, so follow the printed remedy.

Older installs may still hold `.devkit/comment-firewall-receipts.json` and
`<git-common-dir>/devkit/comment-firewall-rationales.json` from the retired rationale flow. Nothing
reads them; both are safe to delete.

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

## A devkit test failed with `ceiling-timeout:`

The label means setup ran out of time **before** it reached the step under test. The two
ceiling-sentinel tests in `cli/__tests__/review.test.mts` (the asset wedge and the
`preflight-verify:deps-final` wedge) set `DEVKIT_PREFLIGHT_TIMEOUT` and assert that the ceiling fires
*at the wedge*. When the wedge's marker is absent and review's own ceiling banner names an earlier
phase, the test fails with `ceiling-timeout: the 90s setup ceiling fired during <phase> before
reaching <phase>`. There are two possible causes, and the label names the likelier one:

- **Machine load** (the 1-minute loadavg exceeds `cpus=`): setup was starved of CPU.
- **A real hang in the named earlier phase** (loadavg within `cpus=`): treat it as a regression.

A failure **without** the prefix, or with the marker present, is an ordinary assertion failure.

Every `vitest run` (unit and e2e configs) also prints `devkit test load: start …` and
`devkit test load: end …` to stderr, so you can weigh any timeout-shaped failure. To confirm, re-run
the file alone: `bun run test:run -- cli/__tests__/review.test.mts`. If it still fails at normal load,
investigate the named phase. Raise the ceiling only when setup is legitimately slower; never lower
it and never serialise the file (`suite-hangs-bound-at-the-spawn-site`,
`test-deadlines-are-hang-detectors`).

## CI `Release-only dist` failed: `this ship rewrites tracked dist, which is release-only`

This applies only in devkit's own repo. Between releases, `bun run build` rewrites tracked `dist/` files
whose sources were changed by **other** merged PRs. Those rewrites ship only with `devkit release`
(`docs/decisions/typescript-source-prebuilt-mjs.md`), so the `gate` workflow judges your PR's committed
tree and fails if it changes any tracked dist file. Whole-file mirrors such as `dist/README.md` count
too. A feature PR may only **add** dist files (new artifacts) or **delete** them.

- **Before shipping:** `devkit ship` lists rebuilt files as `release-only drift from main — leave them
  out of the brief`. Brief your source, plus only the **new** dist paths the preflight names.
- **Already on the PR:** restore the listed files from the PR's merge-base, which is what CI diffs
  against (`main` may have moved its own dist since). Run
  `git checkout "$(git merge-base origin/main HEAD)" -- <listed paths>`, commit, and `devkit ship --pr`.

## A gate exited 3: the judge hit a usage limit, or its CLI is missing

Exit 3 is the **exit-3 contract** — the judge could not run, not a finding against your code. The
message names the CLI that went dark and why: absent, logged out, or a usage limit with the wait it
carries. Re-running clears none of those, and a multi-day lock outlasts any ship.

If the banner instead reads `<gate>: could not run — <error> (strict ship mode: failing closed)`, no
judge is involved: the gate itself failed (for example a git read), and a strict ship blocks rather
than proceed unjudged. Fix the named error and re-run; the judge-family moves below do not apply.

Move every judge **away from the CLI the message names**, in the shell the ship runs in.

**`codex` is dark** — move to the claude family. Set all four knobs, never a subset:

```
export GUARD_REVIEW_MODEL=haiku GUARD_REVIEW_ESCALATION_MODEL=opus \
  GUARD_CORRECTNESS_MODEL=sonnet GUARD_CORRECTNESS_CHUNK=off
unset GUARD_SENTRY_MODEL FRINK_SENTRY_MODEL
devkit ship --resume <branch>
```

**`claude` is dark** — return to the packaged codex family. Unset every judge env:

```
unset GUARD_REVIEW_MODEL FRINK_REVIEW_MODEL GUARD_REVIEW_ESCALATION_MODEL \
  GUARD_CORRECTNESS_MODEL GUARD_CORRECTNESS_CHUNK GUARD_SENTRY_MODEL FRINK_SENTRY_MODEL
```

Then check `guard.config.json`. If `review["//judgeFamily"]` is exactly this string, the text doctor
writes:

```
claude family bound by devkit doctor --fix (codex binary was unresolvable). Explicit edits and GUARD_* envs win; delete these four keys to return to package defaults.
```

then a doctor bind put the claude family there, and unsetting alone leaves it in force. Delete
that key and the four keys it names (`model`, `escalationModel`, `correctnessModel`,
`correctnessChunkLoc`) by hand, then commit the file, because a ship reads it from the base commit.
Leave the file alone if the marker is absent or holds your own note: those keys are yours. Then
`devkit ship --resume <branch>`. This is also the way back once a codex outage clears.

**The message names both** (`` `codex` or `claude` ``) — that judge spans both families, so either may
be the dark one. Find out first with `devkit doctor` or the ship preflight, then use the matching block.

Export or unset in the shell; never prefix the command. An inline `VAR=x devkit ship` can be stripped
by a command-rewriting shell hook, exactly as with `SHIP_COMMIT_TIMEOUT` below.

- The chunk cap matters: 400 LOC is benched for `gpt-5.6-sol` only, so moving three knobs runs the
  correctness reviewer at a cap never measured for the model now judging.
- A sentry pin (`GUARD_SENTRY_MODEL` or `FRINK_SENTRY_MODEL`) stays where it points until cleared, which
  is why both blocks unset it. `devkit doctor --fix` refuses to bind while one pins codex, rather than
  reporting a move that left a judge behind.
- `devkit doctor --fix` writes the same four keys into `guard.config.json` — durable, but it binds
  only toward Claude, and a ship reads that file **from the base commit**, so commit it first. It
  binds only when no codex binary resolves: for a codex that is installed but usage-limited or
  logged out it is a silent no-op, so use the export. An exported env needs no commit and works
  mid-ship.
- Both routes re-judge every reviewer: a cached PASS is keyed on the model that earned it, so an
  in-flight converging ship restarts its review wave.
- Claude publishes no quota query, so nothing can warn you before its headroom runs out.

`devkit doctor` reports the same models per role, and says which env is blocking an automatic bind.

## A reviewer shows `PASS over an incomplete packet` (or `partial evidence`)

Each AI reviewer reads a capped diff packet. On a large diff, files past the budget are OMITTED or
TRUNCATED. Only the correctness reviewer is chunked so that every file reaches some judge. Every other
reviewer's PASS on a large diff may cover only part of it, so the ship digest lists that PASS as
unverified (`·`) with the files it was not shown. The review run's completion line appends `partial
evidence: N/M file(s) omitted`. The row does not block.

The judge was told to inspect the omitted files before passing, but the verdict alone cannot show that
it did. To get a full review:

- Split the change into smaller ships so each reviewer's diff fits the budget.
- Or review the named files yourself before merging.

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

## `managed Oxlint base manifest digest is stale; refusing an incomplete baseline`

Also seen as `anti-slop capability is not fully integrated`. This is **provenance drift, not your
content**: it compares devkit's committed managed state (`.devkit/oxc/manifest.json`,
`.devkit/anti-slop/manifest.json`) against the devkit package that's actually running, and fails when
the two disagree.

- **During a `devkit ship` / `devkit ship --pr`** you shouldn't see it: the ship worktree is cut from
  the base (for `--pr`, the existing PR branch tip), so a branch that forked before a gate-infra
  change carries that change's _predecessor_ — while the gates come from the caller's linked
  `node_modules`. `prepare_gate_worktree` therefore refreshes the managed state from the running
  package and prints `↳ shipping: refreshed managed capability state …`. That refresh touches the
  **working tree only** — it is never staged and never reaches the commit, so the PR branch stays
  self-consistent for its own CI. If you instead see `↳ shipping: managed capability refresh skipped
— <reason>`, the reason names the fix (usually `devkit doctor --fix`).
- **On a plain commit**, your checkout's managed state lags the devkit you upgraded to. Run
  `devkit doctor --fix` and commit the refreshed `.devkit/` bytes.

When a devkit upgrade newly activates anti-slop rule IDs, it merges only those rules' current
findings into an existing `.anti-slop-baseline.json`; all older rule entries and counts remain
shrink-only. Stage the managed capability and baseline together. If the previous managed manifest or
config is missing or invalid, upgrade cannot prove which rules are newly active, leaves the baseline
unchanged, and says so; repair the managed state, then explicitly review and re-baseline if needed.
Capability repair commands preserve a pending activation marker, so a later `devkit upgrade` can
still perform the scoped merge after `init` or `doctor --fix` refreshed the managed bytes.

## `✗ deterministic gates failed: <names>`

The deterministic gates (structure, fanout, size, dup, clone, anti-slop, comments …) run
all-and-**aggregate**: instead of failing fast on the first, they collect every failure into one report
naming each (`guard-<id>`). Fix each named gate (see **A pre-commit gate blocked my commit** above) and
re-commit. To converge without a ship round, stage the paths and run `guard-deterministic` locally.
`guard-comments(unreadable-evidence)` is not a rejection: the gate could not read the staged content.
On a commit or ship, the decision and reviewer gates run only after this stage passes, one finding
at a time, by design.

## `✗ review: failed gates: <names>`

`devkit review` runs every selected gate even after one blocks, then prints this line and exits 1.
The deterministic stage (guard-comments included) defers under `--dry-gates` too, where the line
reads `✗ dry-gates: …`. A confirmed AI finding from guard-decisions or guard-review defers only in review. A
judge outage (exit 3) or unreadable evidence (exit 4) from an AI gate, or a Qavis strict block, still
stops the run at once.
Each named gate's findings appear above the line.

To check a fix without another commit or ship, stage it and run the per-gate command the block prints
under `Re-check a fix locally` (anti-slop: `devkit anti-slop check --staged`). Under `devkit ship`, those
commands judge your checkout's index; the ship block also prints the `devkit ship … --dry-gates` invocation
that re-runs the deterministic set on ship's exact staging. No judges run after a deterministic block.

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
