---
name: commit-gates
description: Use when a Devkit-managed commit or ship gate blocks, or before considering a GUARD_* bypass. Diagnose the exact gate and apply its intended remediation without weakening unrelated verification.
---

# Commit gates

Devkit's hook output is the authority: it names the gate, the evidence, and usually the exact repair
command. Do not pre-run every gate or replace the managed chain with a hand-written equivalent.

## When a gate blocks

1. Identify the exact gate and keep its full output. After `devkit ship`, use the gate-log path the
   command prints; a failed ship may include a remediation command that refers to that retained log.
2. Fix the reported cause, then retry with `devkit ship --resume <branch>` (in explicit-path mode, a
   fix that adds a NEW file rides along as a trailing path: `--resume <branch> -- <new-path>`;
   committed-branch mode freezes membership, refuses a resume whose fix committed a path outside it,
   and prints the fresh full `--from-branch` invocation to run instead); a plain commit re-runs the
   identical commit command. Ship checkpoints successful
   stages and `--resume` replays the
   recorded invocation byte-identically, so restarting with different flags or a re-typed body
   usually wastes work and can discard useful evidence.
   **Re-check a named deterministic failure before re-shipping.** The `✗ deterministic gates
   failed` block ends with the command that re-judges each failed gate (anti-slop's documented form
   is `devkit anti-slop check --staged`). Stage the fix and run that line — seconds, no judges.
   Under `devkit ship` those lines judge your checkout's index, not the briefed paths, so the ship
   block also prints the `devkit ship <branch> "<title>" --dry-gates …` invocation that re-runs the
   deterministic set on ship's exact staging. A blocking overlay lint step (eslint, biome, fallow)
   and devkit's own formatter print the same invocation under `devkit ship`. A hand-rolled substitute (`npx oxlint …` against the
   anti-slop config) ignores the baseline and cannot reproduce the new-versus-inherited verdict.
   This re-checks a gate that already named itself; it is not a licence to pre-run every gate.
3. **Check which files the gates actually had.** A ship's gate worktree is cut from the base, so
   every path NOT in the ship's brief is judged at its **base** content — that is how a clone gate
   reports a duplication against a symbol you already moved, or a drift in a file that verifies clean
   locally. A blocked ship prints the brief twice: in full under `Resuming recorded invocation …`
   before the gates run, and capped under the verdict (`ship: the gates judged N briefed path(s) …`).
   The record itself is `jq -r '.paths[]' .devkit/ship-intent-<branch>-<hash>.json` — one file per
   branch, so read YOUR branch's rather than globbing (parallel agents leave several). The effective
   set is that recorded list UNION any path the retry added, and patch anchoring shapes the content
   further. If a finding names a file absent from the brief, brief it on the retry
   (`--resume <branch> -- <path>`) instead of chasing the finding. Each briefed path is one literal file
   from the repo root; a glob is not expanded, so brief every file by name.
4. Treat a bypass as an explicit operator decision. Never use `--no-verify`, silently disable a
   selected guard, freeze a baseline to absorb new debt, or invent an environment variable. A
   `guard-review waive` backed by a reproduction (see the reviewer gates below) is a dispute, not a bypass.

## Managed gate families

- **Deterministic aggregation** runs the selected structure, size, fan-out, semantic-duplication,
  clone, coverage, anti-slop, and comment-budget checks and lists every failure in one block. Follow the printed repair. Existing ratchet debt may shrink; do not
  re-freeze it merely to admit a new violation. A missing or inherited coverage artifact may use the
  documented one-run `GUARD_COVERAGE_OK=1` assertion only when the change did not cause the shortfall.
- **Comment budget** (`guard-comments`) blocks any added or modified standalone comment paragraph
  with three or more text lines. Shorten it to at most two lines, or move the information into
  code, types, a test name/assertion, or a decision record (`guard-decisions`). There is no
  rationale, waiver, or reviewer; a paragraph-long explanation belongs in docs, not in code.
- **Local pre-ship loop.** Stage the paths (`git add <paths>`), then run `guard-deterministic`
  (in devkit itself: `node gate-engine/deterministic/run.mts`). It runs the same aggregated set
  a ship attempt runs, without the ship round. Single checks: `guard-comments gate` (reads the
  staged set) and `devkit anti-slop check --staged`.
- **Decision gate** requires an architectural target only when the change crosses that bar. Use the
  `decisions` skill for a real decision; do not create an ADR for a routine fix merely to clear the
  gate.
- **Reviewer and completeness gates** name a concrete defect or missing required work. Fix the
  finding and re-run. An unavailable judge and a confident rejection have different exit semantics;
  preserve that distinction instead of treating every nonzero result as a code defect. To dispute a
  finding, resolve it against the base sha `guard-review` printed (`reviewed against <sha>`), not
  against local `HEAD` — under `devkit ship` the reviewers judged a worktree cut from the remote
  base, so `git show HEAD:<file>`, `grep` and `git diff --stat` in your own checkout can all agree
  with each other and still describe a different tree. Waive on evidence read from the reviewed
  base, and pass the `--base` the block note prints so the record says which tree you checked.
  When a correctness or conventions finding names a concrete input and running that input against
  the reviewed code gives the correct result, waive it with the command and its output as the
  rationale. Do not add tests or edits only to change the diff and re-sample the judge: any real
  change voids the waiver and proves nothing. A race that did not reproduce is not disproved.
  A lens PASS is one sample from a nondeterministic judge, not a certificate that its concern is
  clean. A later attempt can fail the same lens on code you did not touch. Treat that as an
  ordinary finding and fix it: it was missed, not caused by your last edit.
  **Re-check one failed reviewer or lens before re-shipping.** Each FAIL block ends with
  `Re-check a fix locally … guard-review lens <reviewer>[:<lens>]`. Stage the fix and run it: it
  judges only that reviewer (or that one correctness lens) on your staged index, with the gate's
  prompt, model and cache key. Its PASS is cached, so the next `devkit ship --resume` skips that lens
  — but only when the same paths ship briefed are staged and the `GUARD_REVIEW_*` model env matches.
- **A counterexample stands for a class.** A correctness finding against a matcher, parser,
  predicate or validator names ONE input the check gets wrong. Before re-shipping, name the property
  that makes it wrong, list the other inputs that share it (every character that continues a path,
  not just the `.` quoted), and fix the class: an allowlist or grammar instead of a longer
  blocklist, or a narrower check on an exact token. Pin the fix with a table-driven test over that
  class. A second finding of the same shape means the first fix covered an instance, not the class.
- **A `↻ … not converging` line** under a blocked ship's digest means the same reviewer has blocked
  three or more rounds on this branch with no pass between, and its latest blocking-finding count is
  no better than its best earlier round. It says the count is not falling, not which findings recur.
  Stop re-shipping blind: fix the remaining findings as a class, waive any you judge not real with
  the `guard-review waive` line and a rationale, or ask the user for the reviewer skip the block note
  names. `--no-verify` is never the landing path.
- **Sentry gate** judges commit-message intent for newly introduced runtime error classes. Add the
  capture on the named surface, or surface a disputed verdict to the user before any bypass.
- **Qavis advisory** can recommend visual QA but does not turn a non-UI change into UI work. Ship
  first, QA second: on a ship every judge that can demand an edit runs before the advisory, so run
  `qavis qa` only when the advisory asks, or ship with `DEVKIT_SHIP_QA=1` to QA the gate tree in the
  same run. A QA pass taken before `devkit ship` is voided by any judge-forced fix.

## Comment budget

The gate is deterministic: it counts the added or modified text lines of each standalone comment
paragraph, treating comment groups separated only by blank lines as one paragraph. One- and
two-line changes, inline comments after code, untouched comments, deletions, and pure renames pass.
There is no bypass. Exit 4 (unreadable staged evidence or an unsupported language) is not a
rejection; follow the printed remedy for that outcome.

## Canonical one-run controls

Use these only for the named gate, when the user authorizes them or another Devkit skill states the
specific conditions under which that control is appropriate:

- `GUARD_NO_LOG=1` — bypass a decision judgment for a confirmed non-decision.
- `GUARD_NO_REVIEW=1` — skip the blocking domain reviewer gate.
- `GUARD_REVIEW_SKIP=<reviewer>` — skip only that named reviewer when the user has explicitly
  accepted a confirmed finding as a false positive or residual; every other reviewer still runs.
  Re-run normally after a fix so the reviewer verifies it.
- `GUARD_NO_COMPLETENESS=1` — skip completeness; `GUARD_COMPLETENESS_HARD=0` only softens it.
- `GUARD_NO_SENTRY_JUDGE=1` — skip the Sentry commit-message judge.
- `GUARD_COVERAGE_OK=1` — assert the base-branch coverage condition documented by `using-devkit`.
- `GUARD_MASS_DELETION_OK=1` — commit a deliberate deletion of half or more of the tracked tree.
  guard-review otherwise blocks it as a clobbered index. Check `git diff --cached --stat` first: an
  unexpected whole-repo deletion means the index was overwritten, so run `git reset` rather than
  bypass.
- `GUARD_QAVIS_OK=1` — ship this change without the advised visual QA. Prefer the audited path the
  advisory prints: `qavis qa`, then `qavis waive --staged --reason '…'` when the verdict is uncertain
  and the gap is accepted, so the reason is bound to the tree. `GUARD_NO_QAVIS_ADVISORY=1` disables
  the advisory entirely.
- `GUARD_SHIP_BASE_OK=1` — ship into a `--base` that does not contain this work's branch point.
  Prefer the base the refusal names: the gate worktree is cut from the base, so overriding makes
  guard-size, guard-clone and structure judge a tree your change was never written against, and
  their findings will look real. Use it only for a deliberate cross-line PR.
- `GUARD_HOOK_PARITY_OK=1` — assert that `.husky/pre-commit` drift predates your change (Devkit's
  own repo only; the gate is already advisory when no hook-generator input is staged).
- `GUARD_DECISIONS_INTEGRITY_OK=1` — assert that a NEW structural finding on a decision record in
  this change is wrong (Devkit's own repo only; findings already present at HEAD never block).

Anti-slop has no one-run control by design: CI's `anti-slop check --base` would still fail the PR,
so a bypass would only move the failure later. To accept a finding deliberately, add a path-scoped
`overrides` entry (or change the rule's severity) in the repository Oxlint config, where a reviewer
sees it in the diff. In an overlay install the baseline is per-clone, so `devkit anti-slop create
--force <paths>` adopts it locally. The FAIL output names the route for the mode it ran in.

## Judge outage: re-targeting, not bypassing

A judge that cannot run is not a finding. Under `devkit ship` a dark provider fails the gate closed
with exit 3, and the printed remedy names the CLI that went dark and why: missing, logged out, or a
usage limit with the wait it carries. Re-running clears none of those. Exit 3 with a
`<gate>: could not run — <error>` banner is not a judge outage: the gate itself failed (a git read,
say), so fix that error instead of re-targeting.

The lever is moving every judge away from the CLI the remedy names. It skips nothing — the same
reviewers still run, judged elsewhere — so it is not a `GUARD_NO_*` bypass and does not need the
authorization those require. Run it in the shell the ship runs in.

`codex` dark — all four knobs, never a subset, plus any sentry pin:

```
export GUARD_REVIEW_MODEL=haiku GUARD_REVIEW_ESCALATION_MODEL=opus \
  GUARD_CORRECTNESS_MODEL=sonnet GUARD_CORRECTNESS_CHUNK=off
unset GUARD_SENTRY_MODEL FRINK_SENTRY_MODEL
devkit ship --resume <branch>
```

`claude` dark — back to the packaged codex family (also the way back once a codex outage clears):

```
unset GUARD_REVIEW_MODEL FRINK_REVIEW_MODEL GUARD_REVIEW_ESCALATION_MODEL \
  GUARD_CORRECTNESS_MODEL GUARD_CORRECTNESS_CHUNK GUARD_SENTRY_MODEL FRINK_SENTRY_MODEL
```

If `guard.config.json` carries `review["//judgeFamily"]` equal to exactly this string, a doctor bind
is in force:

```
claude family bound by devkit doctor --fix (codex binary was unresolvable). Explicit edits and GUARD_* envs win; delete these four keys to return to package defaults.
```

Unsetting alone leaves that bind in place: delete that key plus `model`, `escalationModel`, `correctnessModel` and
`correctnessChunkLoc` by hand, commit, then `devkit ship --resume <branch>`. Any other value there is
an operator's note, and those keys are operator-owned — leave them.

A remedy naming both (`` `codex` or `claude` ``) means one judge spans both families and either may be
dark; find which with `devkit doctor` before moving anything.

- Export or unset; never prefix the command. A command-rewriting shell hook can strip an inline
  `VAR=x devkit ship`, the same rule that governs `SHIP_COMMIT_TIMEOUT`.
- All four, because the correctness chunk cap is benched for `gpt-5.6-sol` only; a three-knob move
  runs the correctness reviewer at a cap never measured for it.
- A sentry pin under either spelling stays where it points until cleared, so both blocks unset it;
  doctor will not bind while one pins codex.
- `devkit doctor --fix` writes the same four keys into `guard.config.json`, which a ship reads from
  the base commit — so that route needs the file committed first, and it only ever binds toward
  Claude. It binds only when no codex binary resolves: a codex that is installed but usage-limited
  or logged out makes `doctor --fix` a silent no-op, so use the exports above. The claude-dark step
  above says how to remove that bind by hand.
- Either route re-judges everything: a cached PASS is keyed on the model that earned it. Claude's
  remaining headroom cannot be queried, so nothing warns before it runs out.

Consumers may retain legacy aliases, but Devkit's printed `GUARD_*` spelling is canonical. A
consumer can also have hand-authored gates outside the `devkit-guards` block; use that repository's
own documentation for those rather than assuming a Devkit bypass applies.
