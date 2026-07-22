---
name: using-devkit
description: Use when working in a repo that has devkit installed and you are about to run a git or maintenance command — a commit was denied on a protected branch, `devkit doctor` reports drift, you need to relocate/rename source files, refresh a shared checkout after your PR merged, uninstall devkit, or update it — and you must pick the right devkit command instead of a hand-rolled git workflow.
---

# Using devkit

This repo has **devkit** installed — a CLI that wires it onto shared configs + commit-time governance
gates and syncs agent skills. devkit ships a purpose-built command for several git/maintenance
situations. **The failure this prevents:** an agent reaches for the familiar raw-git move
(`git switch -c …`, `git pull`, `git restore`, hand-editing synced files) and either gets **blocked**
by a gate, **disturbs other agents** sharing the tree, or runs a command that **doesn't exist**
(a baseline agent guessed `devkit sync` — there is no such command). Recognize the situation, run the
devkit command.

> **Layout note:** any path below (`src/`, a branch name, …) is an example. This repo's real roots and
> protected branches live in `guard.config.json` — map each example to this repo.

## Terms you must recognize

- **Protected branch** — a branch you may not commit to directly (typically `main`/`master`; the set
  is repo config). devkit **provides** a `guard-branch` command; wired as a Claude Code PreToolUse
  hook it **denies** a `git commit` there and hands back a ready-to-run `devkit ship …`. `devkit init`
  does **not** auto-wire it — a repo opts in by registering the shim in its `.claude` settings, and
  wired that way it gates **Claude Code agents only**, not Cursor. Signal: your commit was rejected
  with a message naming a protected branch, **or** `git branch --show-current` is `main`/`master`.
- **Drift** — the repo no longer matches what devkit set up, or a synced copy under `.claude/`/`.cursor/`
  diverged from its **manifest** (`.devkit/*-manifest.json`, a sha256 per synced file). Signal: a
  `devkit doctor` line says `DRIFT` or `MISSING`.
- **Shared checkout** — one working tree that several agents / linked worktrees use **at the same
  time**. Any command that moves `HEAD` (`git switch -c`, `git checkout`, `git pull`, `git reset`)
  yanks the tree out from under the others. Signal: linked worktrees exist, or the task says parallel
  agents share this tree.

## Situation → command

| You observe (trigger) | Run | Why not the raw-git move |
|---|---|---|
| A commit was **denied on a protected branch**, or you're on `main`/`master` and need to land a change | `devkit ship <branch> "<title>" -- <paths>` | `git switch -c` + commit + push **moves the shared checkout's HEAD**, disturbing parallel agents; `ship` commits in an ephemeral worktree and opens a PR without moving HEAD |
| The PR must target a branch **other than the one you're on** — e.g. your work is already committed on a source branch and the base is a different one | `devkit ship <branch> "<title>" --base <base-branch> -- <paths>` (branch + title FIRST — see Rules) | plain `ship` bases on this checkout's HEAD, where those paths are already identical, so it stages nothing and aborts `nothing to commit`; `--base` diffs your **working tree** against `origin/<base-branch>` and targets the PR there — no checkout, no worktree juggling |
| You're in a **linked worktree, already on a branch**, and need a PR | `devkit ship <new-branch> "<title>" --base <base> -- <paths>` | you don't need — and must not create — another branch: `ship` makes the PR branch itself, and a branch that already exists is the one state it cannot recover from |
| Ship reports the branch **already exists on origin** (an open PR uses it) | `devkit ship <branch> "<title>" --pr -- <paths>` | picking a new name orphans the existing PR; `--pr` fast-forwards a new commit onto that branch instead |
| `devkit doctor` reports **config drift** (`biome.jsonc`/`tsconfig.json`/husky `DRIFT`/`MISSING`) | `devkit doctor --fix` | hand-editing re-introduces the same drift on the next sync; `--fix` re-runs the recorded init idempotently |
| `devkit doctor` reports **skills/agents drift** (synced copy ≠ manifest) | `devkit sync-skills` / `devkit sync-agents` | editing `.claude/.cursor` copies by hand just re-drifts; `devkit sync` is **not a command** |
| You must **relocate or rename source files** and imports must follow | `devkit move <src...> <dest-dir>` | `git mv` leaves every `import`/`vi.mock`/dynamic-import pointing at the old path; `move` rewrites them all in the repo's alias style |
| Your PR **merged** and a **shared checkout** still has the old shipped files | `devkit reconcile` (preview) then `devkit reconcile --apply` | `git pull`/`git restore` on a shared tree moves HEAD and clobbers concurrent edits; `reconcile` confirms each PR merged and restores only still-pristine files without moving HEAD |
| **Uninstall** devkit from this repo | `devkit clean` | deleting `.devkit/` + configs by hand leaves the husky block + git-ignore entries behind; `clean` reverses init for the recorded mode |
| A consumer is **behind across the board** (stale pin, drifted skills/agents/hooks, un-reconciled configs) and you want **one command** | `devkit upgrade` (add `--dry-run` to preview, `--force` to adopt consumer-authored asset collisions) | it composes the slices idempotently from `.devkit/config.json` (re-pin + `migrate` + sync skills/agents/hooks + refresh husky/guards for the *recorded* selection) and ends with `doctor`; chaining `update`+`migrate`+`sync-*`+`init` by hand is error-prone and re-adds deselected surfaces |
| devkit **itself is out of date** (just the package) | `devkit update` then `devkit migrate --apply`, or `devkit upgrade` for the full reconcile | re-pinning the dep by hand skips the config reconciliation `migrate` performs; `upgrade` does both plus the agent-surface + hook refresh |
| You're unsure of a command's **flags/behavior** | `devkit help <command>` | don't guess flags — this table routes; `help` is the source of truth |

## Rules

- **`<branch>` and `"<title>"` are positional and come BEFORE every flag.** `ship --base X <branch>
  "<title>"` binds the branch name to `--base`. A guard now rejects that outright; before it existed,
  the run died ~180 lines later inside an internal git call with `error: unknown option 'base'` —
  naming neither the ordering rule nor the arguments at fault. Five of six recorded agent sessions
  wrote the flags-first form *after* reading `devkit help ship`, so do not trust your recall here.
- **Ship CREATES the positional `<branch>` — it must not already exist** locally or on origin. Never
  `git switch -c` the branch you intend to ship to. Already sitting on some *other* branch is fine
  and normal: ship reads file **content** from your working tree, so uncommitted work ships
  correctly without a single commit of your own.
- **`branch already exists` → ship to a different name; on ORIGIN → `--pr`.** Do not detach HEAD,
  delete the branch, or switch to the base branch to free the name. In a linked worktree all three
  fail (`already used by worktree at …`) and none of them is necessary.
- **Detached HEAD only matters when `--base` is absent.** With `--base <b>` the PR target comes from
  the flag and HEAD is never consulted — so detaching to "free" something fixes nothing.
- **Never hand-roll a `git commit` on a protected branch.** If the branch guard is wired, it blocks it
  and returns the exact `devkit ship …` to run — run that.
- **On a shared checkout, never move HEAD** (`switch`/`checkout`/`pull`/`reset`). Use `ship` to commit
  and `reconcile` to refresh.
- **Run `devkit ship` in the BACKGROUND** (`run_in_background`), never as a foreground tool call: the
  gate chain's worst case (AI reviewer cascades) exceeds the 10-minute foreground Bash cap, which kills
  the ship mid-gates as exit 143 with no banner. Poll the shell output for the per-reviewer heartbeat
  lines (`guard-review: <name> — PASS … (checkpointed)`).
- **A timed-out ship (exit 124) is NOT stuck at zero — re-run the SAME command.** Reviewer PASSes
  checkpoint as they land, cleared decisions judgements and the deterministic gate prefix are cached,
  so a re-run only pays for the unfinished work; the timeout banner names the stage that was mid-flight.
  Do not respond to a 124 by bypassing gates (`--no-verify`, `GUARD_NO_REVIEW`) — that defeats the ship.
- **Raising the gate budget: `SHIP_COMMIT_TIMEOUT` must be an EXPORTED env var** (`export
  SHIP_COMMIT_TIMEOUT=2400`, then ship). An inline `SHIP_COMMIT_TIMEOUT=2400 devkit ship …` prefix can
  be silently stripped by command-rewriting shell hooks — verify with `env | grep SHIP` if in doubt.
- **A coverage block you didn't cause is not yours to fix — `export GUARD_COVERAGE_OK=1` and re-ship.**
  If `devkit ship` fails on `guard-coverage` because the artifact is absent, or for a shortfall your
  diff didn't cause, that is the BASE branch's debt. Export the flag (`GUARD_NO_COVERAGE=1` also
  works), re-run the same ship, and note the bypass in the PR body. A shortfall your own change *did*
  cause, you fix. Two dead ends to skip: editing `"coverage": false` in `guard.config.json` **silently
  does nothing** under ship (it reads that file from the committed tree, not your working tree), and
  re-running the full coverage suite to manufacture the artifact can take tens of minutes and still
  produce nothing if the base's tests are already failing — don't idle on it.
- **`devkit help <command>` is the source of truth for flags.** This skill routes you to the command;
  it deliberately does not restate usage.

## When NOT to use

Ordinary work — editing files, running tests, a normal commit on your own feature branch — needs no
devkit command. This skill fires only for the git/maintenance situations above.
