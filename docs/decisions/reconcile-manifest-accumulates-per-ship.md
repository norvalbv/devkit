---
slug: reconcile-manifest-accumulates-per-ship
created: 2026-06-28
---

# reconcile-manifest-accumulates-per-ship

## Target · 2026-06-28 — Reconcile manifest accumulates across every ship event on a branch

**Context:** devkit ship --pr re-pushed commits to an open PR but never updated .devkit/reconcile-manifest.json — only the initial devkit ship wrote it. A multi-commit PR therefore recorded only the first commit's paths; after merge, devkit reconcile --apply cleaned only those and git pull --ff-only then ABORTED on every path the --pr commits added or renamed (local changes would be overwritten), stranding shipped files dirty in the shared parallel-agent tree until a manual git restore.
**Ruling:** Every ship event on a branch — the initial devkit ship AND each devkit ship --pr re-push — records into the SAME branch entry. A re-push MERGES its paths keyed by path: replace a re-shipped path with its branch-TIP blob, add new paths, and supersede a renamed-away path's stale modify with its delete, keeping the PR metadata. Renames stay delete-old + add-new (the existing reconcile contract), never a new op:rename. No prior entry means an honest best-effort miss, never a partial reconstruct.
**Consequences:**
- Positive: A multi-commit PR's manifest holds every final shipped path at its tip blob, so after merge reconcile --apply restores or stages all of them and the shared tree is fully ff-pullable — zero stranded files, no manual git restore.
- Negative: A rename's old path must be passed to ship --pr for its deletion to be recorded — the same contract as the initial ship, and safe because reship only commits the passed paths so the record cannot desync from what shipped. A lost best-effort INITIAL write leaves the whole branch entry unrecorded; accepted, because reconstructing from a re-push could know only that commit's paths and would prune then falsely report 'all clean' while earlier paths still block ff.
**Vision-fit:** n/a — internal dev tooling (the parallel-agent shared-tree ship and reconcile workflow).
**Researched:** frink manual-lane reconcile spec (workflow-reconcile), whose own 'sub-threshold rename emits add+delete = two independent entries, still correct' sanctions delete+add; git-spice forge-MERGED detection plus git-town per-path empty-diff gate the contract builds on; verified against the shipped reader cli/lib/reconcile.mjs, which has no rename branch (handles only add/modify/delete).
**Rejected:** (a) op:rename + renamedFrom schema, as the spec literally listed — INFEASIBLE without also building an unbuilt rename case in the reconcile reader (reconcile.mjs handles only add|modify|delete), and the spec itself proves delete+add reconciles identically, so the extra schema buys nothing. (b) reconstruct a fresh entry when no prior entry exists — LOSES correctness: a re-push knows only its own commit's paths, so reconcile would clean those, prune, and falsely report success while the unrecorded earlier paths still block git pull --ff-only.
**Anchored-bet:** [VALIDATED]
**Scope:** cli/lib/ship/**,cli/lib/reconcile.mjs
**Source:** collab · workflow-reconcile
