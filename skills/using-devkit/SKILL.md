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
| `devkit doctor` reports **config drift** (`biome.jsonc`/`tsconfig.json`/husky `DRIFT`/`MISSING`) | `devkit doctor --fix` | hand-editing re-introduces the same drift on the next sync; `--fix` re-runs the recorded init idempotently |
| `devkit doctor` reports **skills/agents drift** (synced copy ≠ manifest) | `devkit sync-skills` / `devkit sync-agents` | editing `.claude/.cursor` copies by hand just re-drifts; `devkit sync` is **not a command** |
| You must **relocate or rename source files** and imports must follow | `devkit move <src...> <dest-dir>` | `git mv` leaves every `import`/`vi.mock`/dynamic-import pointing at the old path; `move` rewrites them all in the repo's alias style |
| Your PR **merged** and a **shared checkout** still has the old shipped files | `devkit reconcile` (preview) then `devkit reconcile --apply` | `git pull`/`git restore` on a shared tree moves HEAD and clobbers concurrent edits; `reconcile` confirms each PR merged and restores only still-pristine files without moving HEAD |
| **Uninstall** devkit from this repo | `devkit clean` | deleting `.devkit/` + configs by hand leaves the husky block + git-ignore entries behind; `clean` reverses init for the recorded mode |
| A consumer is **behind across the board** (stale pin, drifted skills/agents/hooks, un-reconciled configs) and you want **one command** | `devkit upgrade` (add `--dry-run` to preview, `--force` to adopt consumer-authored asset collisions) | it composes the slices idempotently from `.devkit/config.json` (re-pin + `migrate` + sync skills/agents/hooks + refresh husky/guards for the *recorded* selection) and ends with `doctor`; chaining `update`+`migrate`+`sync-*`+`init` by hand is error-prone and re-adds deselected surfaces |
| devkit **itself is out of date** (just the package) | `devkit update` then `devkit migrate --apply`, or `devkit upgrade` for the full reconcile | re-pinning the dep by hand skips the config reconciliation `migrate` performs; `upgrade` does both plus the agent-surface + hook refresh |
| You're unsure of a command's **flags/behavior** | `devkit help <command>` | don't guess flags — this table routes; `help` is the source of truth |

## Rules

- **Never hand-roll a `git commit` on a protected branch.** If the branch guard is wired, it blocks it
  and returns the exact `devkit ship …` to run — run that.
- **On a shared checkout, never move HEAD** (`switch`/`checkout`/`pull`/`reset`). Use `ship` to commit
  and `reconcile` to refresh.
- **`devkit help <command>` is the source of truth for flags.** This skill routes you to the command;
  it deliberately does not restate usage.

## When NOT to use

Ordinary work — editing files, running tests, a normal commit on your own feature branch — needs no
devkit command. This skill fires only for the git/maintenance situations above.
