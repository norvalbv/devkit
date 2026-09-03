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
| You want to prove ship's exact base/path brief and deterministic gates before paying for the full reviewer chain | `devkit ship <branch> "<title>" --dry-gates [--base <base>] -- <paths>` | It reuses ship's ephemeral staging, projected runtime/config/coverage, formatter, deterministic/structure/extra gates, and the deterministic comment budget gate, but creates no branch, commit, push, or PR. |
| You need to preview a hot file's real line ceiling before shipping | `guard-size preflight --base origin/<branch> -- <paths>` | It reads `size-lines.json` from the requested base, prints current lines / effective cap / headroom, and names any stale working-tree baseline. `devkit ship` runs the same preflight automatically before creating its gate worktree. |
| The PR must target a branch **other than the one you're on** — e.g. your work is already committed on a source branch and the base is a different one | `devkit ship <branch> "<title>" --base <base-branch> -- <paths>` (branch + title FIRST — see Rules) | plain `ship` bases on this checkout's HEAD, where those paths are already identical, so it stages nothing and aborts `nothing to commit`; `--base` diffs your **working tree** against `origin/<base-branch>` and targets the PR there — no checkout, no worktree juggling |
| Your source branch contains a **large committed multi-commit change** and manually reproducing its complete path list is error-prone | `devkit ship <new-branch> "<title>" --base <base-branch> --from-branch` | this opt-in mode pins `origin/<base-branch>` and `HEAD`, proves ancestry, derives the literal committed path set, and refuses any uncommitted overlay on those paths. Explicit paths remain the default for dirty work because ownership cannot be inferred safely in a shared checkout. |
| You're in a **linked worktree, already on a branch**, and need a PR | `devkit ship <new-branch> "<title>" --base <base> -- <paths>` | you don't need — and must not create — another branch: `ship` makes the PR branch itself. An unrelated existing branch is rejected; only the exact local commit with a gate receipt from a prior post-commit failure can resume. |
| You already ran `git switch -c <branch>` and now want to ship **that same branch** — ship says it *is checked out in THIS worktree* | `git branch -m <branch> <the-name-ship-prints>`, then re-run ship **with `--base <branch-on-origin>`**. Ship prints both commands, filled in — run them verbatim | `ship` CREATES the branch, so it cannot already be checked out here. It tells you to RENAME, never to delete: a rename cannot lose a commit however the refs change under it, and it carries this worktree onto the new name without touching a file (a `git switch` can refuse when your uncommitted work collides with the base). HEAD then sits on a branch origin does not have, which is why the re-run must name `--base`. Never `git worktree remove --force` the tree you are running in. Drop the renamed branch once the PR is open |
| Ship refuses with **`base '<x>' is not on origin`** | `devkit ship <branch> "<title>" --base <branch-on-origin> -- <paths>` | the PR base defaults to the branch this checkout is on, and a provisioned worktree's scratch branch exists only locally — GitHub cannot open a PR against it. Ship now refuses **before** it pushes, so nothing is left on origin to clean up |
| Ship reports the branch **already exists on origin** (an open PR uses it) | `devkit ship <branch> "<title>" --pr -- <paths>` | picking a new name orphans the existing PR; `--pr` fast-forwards a new commit onto that branch instead |
| The work is **not ready for review** — you want a visible PR running CI, but no reviewers pinged yet | `devkit ship <branch> "<title>" --draft -- <paths>` | ship opens a **ready-for-review** PR by default, which requests review the moment it lands; `--draft` opens a draft instead. The bit is recorded with the invocation, so a gate-blocked draft ship still opens a draft under `--resume`. To make **every guard-suggested** ship in a repo a draft, set `.devkit/config.json` → `{ "ship": { "command": "devkit ship", "extraArgs": ["--draft"] } }` — the `command` key is required or `extraArgs` is ignored, and the guard drops `--draft` from its `--pr` suggestions, where it cannot apply |
| A **draft** PR is finished and you are pushing the final commit | `devkit ship <branch> "<title>" --pr --ready -- <paths>` | one command instead of a re-push followed by a hand-run `gh pr ready`. The flip runs **last**, so a gh failure never costs the pushed commit — it names the exact `gh pr ready` to re-run. `--ready` requires `--pr` (a new ship is ready already); to go the other way, `gh pr ready --undo <branch>` |
| An existing PR conflicts after its base moved, and you have **already resolved it locally** | First rebase/merge the actual PR base, then `devkit ship <branch> "<title>" --pr --base <actual-pr-base> -- <every-old-pr-path...>` | devkit gates one replacement commit and rewrites only under an exact head-OID lease. It publishes the caller-prepared resolution; it does not perform the rebase or merge. |
| A ship was **blocked or timed out** and you are about to re-type the command | `devkit ship --resume <branch>` — in explicit-path mode only, a fix that ADDS a file: `devkit ship --resume <branch> -- <new-path>` | every attempt records its invocation (title, base, body, links, paths); `--resume` replays it byte-identically, so cached verdicts and a preserved landed commit still converge. Branch-source membership stays frozen; start a fresh full `--from-branch` invocation to include another committed path. Re-typing a multi-KB heredoc across 20–70 attempts is pure token burn, and one typo forfeits the landed-commit resume |
| The PR body is **long** and the ship may take several attempts | write it to a file once, then `devkit ship <branch> "<title>" --body-file <file> -- <paths>` | a heredoc does not survive a retry through a wrapper (its stdin reads as a silently EMPTY body); the file and the recorded invocation both do |
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
- **Ship CREATES the positional `<branch>`; do not create it yourself.** An unrelated local branch or
  any branch on origin is rejected. The sole local exception is an exact commit preserved by a prior
  post-commit ship failure: an identical retry verifies its ship-owned gate receipt, base, message,
  and paths; explicit mode also rebuilds the current scoped tree, while a v3 branch-source resume
  publishes its already-gated immutable commit. Already sitting on some *other* branch is fine and normal:
  ship reads file **content** from your working tree, so uncommitted work ships correctly without a
  single commit of your own.
- **`--from-branch` owns only committed bytes.** It requires `--base`, accepts no explicit paths on
  the full invocation, and is unavailable with `--pr`. Rebase or merge the current remote base first;
  a divergent/ahead base, changed submodule gitlink, non-UTF-8 path, or staged/unstaged/untracked/
  ignored overlay on any derived path is a refusal. Unrelated dirty paths are deliberately ignored.
  A blocked attempt resumes with the ordinary `devkit ship --resume <branch>` form and frozen path
  membership. Before a commit lands, those paths refresh from the then-current `HEAD`; after a gate
  receipt proves a commit landed, resume publishes that already-gated immutable OID instead. Later
  HEAD fixes therefore need a new ship branch and fresh full `--from-branch` invocation. Extra resume
  paths are refused for the same reason.
- **`branch already exists` → ship to a different name; on ORIGIN → `--pr`.** Do not detach HEAD,
  delete the branch, or switch to the base branch to free the name. In a linked worktree all three
  fail (`already used by worktree at …`) and none of them is necessary.
- **A `--pr` re-ship changes the existing PR description only with explicit `--body` or
  `--body-file`.** Omitting both preserves it; piped stdin remains commit-only. Use `--body ""` to
  clear the description deliberately.
- **`another ship for <branch> is still running` → wait or stop that run; never force-remove it.**
  Ship reclaims the worktree and branch a KILLED ship left behind automatically, so a refusal means
  it proved the owner is alive. When the message says the shell is gone but the gate tree survives,
  the pid it names is the gate supervisor — reviewers are still working inside that worktree, and
  removing it corrupts the run. The remove/delete pair it prints applies only once nothing is running
  there.
- **`no devkit run record there` → that checkout is not ship's to reclaim.** Ship only removes
  worktrees it can attribute to a killed run of its own. An unattributable one — an orphan predating
  this behaviour, or a checkout that is not yours — is reported and left alone; `git worktree remove`
  never applies to a main working tree anyway. When the holder is **your own** checkout, ship says
  `is checked out in THIS worktree` and prints a `git branch -m` rename — run that, not a switch:
  moving HEAD on a shared checkout disturbs every other agent in it, and the rename frees the name
  without touching a file.
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
- **A blocked or timed-out ship retries with `devkit ship --resume <branch>` — never re-type the
  invocation.** Reviewer PASSes checkpoint as they land, cleared decisions judgements and the
  deterministic gate prefix are cached, so a retry only pays for the unfinished work; `--resume`
  replays the recorded title/base/body/paths byte-identically, which is exactly what the caches and
  the landed-commit resume verify against. If the commit landed before a timeout surfaced, the retry
  verifies its gate receipt and publishes that preserved commit without re-running gates; it never
  adopts a merely same-named or hand-made commit. In explicit-path mode, a fix that ADDS a file rides
  the retry as a trailing path (`--resume <branch> -- <new-path>`). Branch-source mode refuses extra
  resume paths because membership is frozen; use a fresh full `--from-branch` command for a new set.
  Changing branch/title/base means running the full command, which re-records. If the blocked attempt
  WARNED that it could not record the invocation (the intent
  file is not gitignored — a managed .gitignore predating this feature), `--resume` will refuse: run
  `devkit doctor --fix` to restore the ignore line, then the full command once — recording resumes
  from that attempt. Do not answer a real finding with a bypass (`--no-verify`, `GUARD_NO_REVIEW`) —
  that defeats the ship. A cascade-confirmed reviewer may print `GUARD_REVIEW_SKIP=<reviewer>`; fix
  first, and use it only when the user has explicitly accepted a false positive or residual. It skips
  only the named reviewer, so every other reviewer still runs.
- **Ship-message rules — structure the message for the gates; length is yours.**
  - The **subject line** is what retrieves the governing decision Targets — make it the change's real
    intent, not a mechanical file list.
  - Author a long body **once, in a file**, and pass `--body-file` — it survives every retry via the
    recorded invocation.
  - **Never reword the body between attempts.** The completeness judge keys on the exact message
    bytes: an unchanged body replays its cached PASS, a reworded one re-pays a multi-minute opus
    call — per attempt.
  - Gates read only the **first ~2KB** of the message, so put the load-bearing claims (what changed,
    why, any bypass notes) up front. The long narrative after that is for human reviewers and is
    welcome — it is recorded once and costs nothing on retries.
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
