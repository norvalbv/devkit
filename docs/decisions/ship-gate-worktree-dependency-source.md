---
slug: ship-gate-worktree-dependency-source
created: 2026-10-16
---

# ship-gate-worktree-dependency-source

## Target · 2026-10-16 — Ship installs the base lockfile in its gate worktree when no borrowed install satisfies the base

**Context:** devkit ship gates the ship base plus the patch in an ephemeral worktree but borrows node_modules from the caller checkout, then the main worktree, both of which can be pinned at an older fork point. When the base added a dependency (frink-oss: qrcode.react), every candidate failed the dependency preflight and ship told the caller to run the frozen install in the checkout, whose own lockfile cannot add that package. A headless agent following the remedy looped: the install succeeded and ship refused again. The only escape was a hand-reasoned mid-ship merge of the base into the checkout, which is unsafe when dirty paths overlap the base diff, and an install in a checkout whose node_modules is a symlink into the main checkout writes through to a shared install.
**Ruling:** gate_node_modules_source keeps the borrow-and-validate fast path (caller install, then main-worktree install, each checked against the BASE package.json). When every candidate is rejected and the worktree has a recognised lockfile, ship runs that lockfile's frozen install (the same command gate_dependency_install_remedy names, HUSKY=0, lifecycle scripts kept) inside the gate worktree, re-validates, and uses the worktree's own node_modules, which then also feeds the baseline-reader preflight. If that install fails, ship refuses and points at the install's own error rather than at the checkout; with no lockfile the old checkout remedy stays.
**Consequences:**
- Positive: Following ship's output once always clears a stale-dependency refusal: either ship fixes it itself, or the only remaining cause is the environment (network, registry, auth) that the printed install error names. The caller checkout and any shared install are never mutated by ship.
- Negative: The rare fallback ship pays a full frozen install in the ephemeral worktree (seconds from a warm bun or pnpm cache, minutes on a cold cache or large electron trees), runs outside the commit timeout, and leaves a real node_modules in a kept worktree. Presence-only validation still misses version-only drift where the base bumps an existing package.
**Vision-fit:** n/a — internal tooling
**Researched:** pnpm git-worktrees docs and workmux worktree caveats prescribe a per-worktree install; CI caches reuse an install only on an exact lockfile-hash match; bun global cache clones packages (clonefile/hardlink) so a warm frozen install is cheap; pnpm verifyDepsBeforeRun keeps staleness detection in the package manager.
**Rejected:** (a) Remedy-only: tell the caller to merge the base into the checkout, then install — loses on the acceptance bar: the merge is refused or conflicts with local commits or overlapping dirty paths, and a symlinked checkout install mutates the shared main install; review-dependency-runtime-main-worktree-alias rejected remedy-only for the same shape. (b) Always install in the gate worktree — loses on cost: the borrowed install satisfies the base on almost every ship. (c) Install with --ignore-scripts — loses on correctness: trusted binary fetchers such as electron's would leave an install that passes the name check and fails inside gates.
**Anchored-bet:** [BET]
**Revisit-when:** The dependency preflight gains lockfile-hash or version validation, or ship stops linking borrowed installs altogether.
**Scope:** cli/lib/ship/prepare-gate-worktree.sh,cli/lib/ship/dependency-preflight.mts
**Source:** shortcut · sc-4001
