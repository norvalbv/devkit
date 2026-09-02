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
   committed-branch mode freezes membership and needs a fresh full `--from-branch` invocation for a
   new path set); a plain commit re-runs the identical commit command. Ship checkpoints successful
   stages and `--resume` replays the
   recorded invocation byte-identically, so restarting with different flags or a re-typed body
   usually wastes work and can discard useful evidence.
3. Treat a bypass as an explicit operator decision. Never use `--no-verify`, silently disable a
   selected guard, freeze a baseline to absorb new debt, or invent an environment variable.

## Managed gate families

- **Deterministic aggregation** runs the selected structure, size, fan-out, semantic-duplication,
  clone, and coverage checks. Follow the printed repair. Existing ratchet debt may shrink; do not
  re-freeze it merely to admit a new violation. A missing or inherited coverage artifact may use the
  documented one-run `GUARD_COVERAGE_OK=1` assertion only when the change did not cause the shortfall.
- **Comment firewall** (`guard-comments`) challenges added or modified supported-language comment
  paragraphs. Prefer removing workaround narration or expressing the constraint in code, types,
  assertions, or tests. If prose is genuinely necessary, run the exact printed
  `guard-comments justify <finding-id> "<specific rationale>"` command; an independent reviewer must
  still approve it.
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
- **Sentry gate** judges commit-message intent for newly introduced runtime error classes. Add the
  capture on the named surface, or surface a disputed verdict to the user before any bypass.
- **Qavis advisory** can recommend visual QA but does not turn a non-UI change into UI work.

## Comment-firewall evidence

The rationale store lives in Git-local metadata rather than the commit. Linked worktrees can read
shared evidence, while ownership metadata prevents one worktree from pruning another's entry. If a
ship worktree disappeared after reporting a finding, use the exact `--from-ship-log` command printed
by the failed ship; it validates the finding against the retained log and does not pre-approve it.

There is no blanket comment-firewall bypass. Reviewer outage, unreadable staged evidence, and an
unapproved rationale are separate outcomes; follow the gate's printed remediation for the actual
one.

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
- `GUARD_QAVIS_OK=1` — ship this change without the advised visual QA. Prefer the audited path the
  advisory prints: `qavis qa`, then `qavis waive --staged --reason '…'` when the verdict is uncertain
  and the gap is accepted, so the reason is bound to the tree. `GUARD_NO_QAVIS_ADVISORY=1` disables
  the advisory entirely.
- `GUARD_HOOK_PARITY_OK=1` — assert that `.husky/pre-commit` drift predates your change (Devkit's
  own repo only; the gate is already advisory when no hook-generator input is staged).
- `GUARD_DECISIONS_INTEGRITY_OK=1` — assert that a NEW structural finding on a decision record in
  this change is wrong (Devkit's own repo only; findings already present at HEAD never block).

Consumers may retain legacy aliases, but Devkit's printed `GUARD_*` spelling is canonical. A
consumer can also have hand-authored gates outside the `devkit-guards` block; use that repository's
own documentation for those rather than assuming a Devkit bypass applies.
