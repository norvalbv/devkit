---
slug: ship-syncs-gate-rewrites-to-caller
created: 2026-10-15
---

# ship-syncs-gate-rewrites-to-caller

## Target · 2026-10-15 — ship copies gate-rewritten briefed files back into the caller's working copy under compare-and-swap

**Context:** devkit ship and ship --pr commit inside an ephemeral linked worktree, where the pre-commit format step rewrites and re-stages briefed files. The pushed commit held the formatted bytes, the caller's working copy kept the unformatted ones, and a successful ship said nothing. The agent's next edit or ship then started from bytes that differed from the PR, and after the merge reconcile saw the caller's file as foreign to both the shipped and the upstream blob, skipped it, and left git pull --ff-only blocked (sc-4577).
**Ruling:** Right after the gated commit and before the push, ship_sync_gate_rewrites (cli/lib/ship/assert-staged-set.sh) takes the briefed paths whose regular-file blob the gate chain changed (diff-tree of the pre-gate staged tree against the commit, limited to the staged path list) and writes the commit's version into the caller's working copy only while the caller's file still hashes to the blob ship staged. The write is git restore --source=<commit> --worktree with core.hooksPath=/dev/null, so the caller's index is never touched and no hook runs. A re-hash decides what is reported as synced. Every other rewritten path is named with a git diff hint and left as-is. --from-branch only prints the git restore command, because its next ship refuses worktree overlays. Dry runs, dry gates and resumes never write.
**Consequences:**
- Positive: The caller's checkout matches the PR after every ship, as it would after a plain git commit whose formatter rewrote the tree in place, so the next edit, the next ship --pr and reconcile's post-merge fast-forward all start from the published bytes. A file the caller or a peer agent changed while the gates ran is never clobbered.
- Negative: Ship now writes into the caller's checkout, which may be a shared checkout with live peer edits. The compare-and-swap leaves a window of milliseconds between the hash and the restore, accepted because reconcile already writes into the same tree under the same check. Paths that were 3-way or anchor merged never match the staged blob, so they always get the hint instead of a sync.
**Vision-fit:** n/a — internal dev tooling (safe shared-checkout PR publication)
**Researched:** sc-4577 and its autonomous report; format-fragment.mts format step; ship-branch.sh resume-refusal hint; reconcile.mts three-blob compare-and-swap; git builtin/checkout.c (restore never writes the index, fires post-checkout); lint-staged, pre-commit, jj fix and git-branchless test fix behaviour (all keep formatter output in the user's tree or fail the commit)
**Rejected:** (a) Only print the reformatted paths and a command — REJECTED: agents miss mid-log notices (the story's own failure) and reconcile stays blocked until someone runs it. (b) Format in the caller's tree before copying — REJECTED: it writes into the shared tree earlier and even on ships that fail. (c) Hand-rolled temp-file and rename write — REJECTED: git restore already applies smudge/eol filters and the exec bit. (d) Writing on --from-branch — REJECTED: the next --from-branch ship refuses the overlay it would create.
**Anchored-bet:** [BET]
**Revisit-when:** ship stops committing in an ephemeral worktree, or the format step moves out of the commit gate chain
**Scope:** cli/lib/ship/assert-staged-set.sh
**Source:** shortcut · sc-4577
