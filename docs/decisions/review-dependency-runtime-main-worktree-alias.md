---
slug: review-dependency-runtime-main-worktree-alias
created: 2026-09-29
---

# review-dependency-runtime-main-worktree-alias

## Target · 2026-09-29 — Review copies a node_modules symlinked into the same repo's main worktree; every other escape still fails

**Context:** devkit review materializes the target checkout's node_modules into a private worktree and rejected any link whose realpath left the target root. A linked worktree whose node_modules is a symlink to the main checkout's (the common worktree setup, and exactly what ship itself links via gate_main_worktree) died at deps-final after ~190s with 'dependency link escapes the repository', leaving agents to rm the link and reinstall by hand. Separately, under the common 'node_modules/' gitignore (directories only) the untracked symlink was swept into the review snapshot and conflicted with the materialized directory.
**Ruling:** A surface symlink whose realpath is exactly the same surface path in the SAME repository's main worktree (git worktree list, first non-bare entry; GIT_* env stripped) is captured and copied as a real directory. Inner links re-root only when they resolve inside that aliased surface. The aliased install must satisfy the target package.json (ship's dependency preflight). Any other escaping surface link fails with the lockfile's install remedy. The review snapshot always excludes 'node_modules' (no trailing slash) because dependency surfaces are materialized, never snapshotted.
**Consequences:**
- Positive: Review runs in linked worktrees with a shared install, the same setup ship already accepts, without a manual reinstall. The private runtime stays self-contained (bytes are copied, links rebuilt inside the destination) and truly external or .git-targeting links still fail closed.
- Negative: The fail-closed boundary widens to one extra root: the main worktree's matching dependency surface. verify now reads the shared install, so a package install in the main checkout during a review aborts it (the error names the shared path). A stale main install is only caught at the declared-dependency level, not full lockfile fidelity.
**Vision-fit:** n/a — internal tooling (gate runs in consumer worktrees; W-3 portability)
**Researched:** prior-art subagent: no devkit branch/PR/record handled review; PR #167 fixed ship only; pnpm git-worktrees guide recommends per-worktree installs; loom #8944 and PortOS #9052 describe the cross-worktree symlink hazard. feature-critique: surfaced the node_modules/ gitignore snapshot leak (reproduced) and the narrow re-root.
**Rejected:** (a) Keep rejecting and only print a remedy — loses on the reported ask: the setup is standard and ship already accepts it. (b) Use the main worktree's node_modules as the whole source root (prior-art reframe) — loses on scope: the source root is the entire target checkout with nested surfaces, so resolution must be per surface. (c) Re-root any path under the main worktree — loses on trust: absolute links to main/src, main/.env or nested worktrees would be silently redirected instead of rejected.
**Anchored-bet:** [BET]
**Revisit-when:** devkit's own worktree tooling stops creating node_modules symlinks, or review stops copying node_modules (e.g. links a verified install like ship).
**Scope:** cli/lib/ship/review/dependency-runtime.mts,cli/lib/ship/review/repository/dependency-alias.mts,cli/lib/ship/review/snapshot.sh
**Source:** brainstorm
- 2026-09-29 — Real frink-oss run: verify aborted because another worktree wrote node_modules/.cache/jiti into the shared install mid-review. Capture now skips only known tool caches (.cache, .vite, .vite-temp) directly under a node_modules directory; package contents, including a .cache nested inside a package, still abort review.
