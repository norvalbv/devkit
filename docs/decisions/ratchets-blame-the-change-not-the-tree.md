---
slug: ratchets-blame-the-change-not-the-tree
created: 2026-08-10
---

# ratchets-blame-the-change-not-the-tree

## Target · 2026-08-10 — Ratchets blame the change, not the working tree

**Context:** guard-fanout judged the whole working tree against its frozen baseline. Existing main-branch drift or untracked files from parallel work could therefore block an unrelated commit and prescribe a large directory split for debt that commit did not create.
**Ruling:** During a commit, aggregate ratchets judge tracked state and require growth: compare the pending Git index with HEAD. Existing over-cap state at HEAD is reported as non-blocking drift with a baseline-refresh remedy; a clean-index CI or manual run still enforces the whole tree. Use direct index and tree readers rather than per-file staged scoping so merges remain aggregate-safe.
**Consequences:**
- Positive: The gate blocks the commit that grows a folder and no longer blames unrelated work. Untracked files cannot inflate the judged snapshot, merge-created piles remain visible, and drift is reported with the remedy that matches its cause.
- Negative: Existing drift becomes advisory on the commit path and relies on clean-index CI as the blocking backstop. A drift refresh remains all-or-nothing, so freeze must name any newly grandfathered growth.
**Vision-fit:** n/a — internal tooling
**Researched:** Frink native fan-out index semantics; devkit guard-fanout, git-index helpers, ship/review HEAD invariants; reproduced in real temporary repositories for unrelated drift, genuine growth, untracked files, merge aggregation, package-directory installs, clean-index CI and unborn HEAD.
**Rejected:** Working-tree counting — rejected because untracked and unstaged state is not the pending commit. Staged-file directory scoping — rejected because aggregate merge counts can exceed the cap even when neither parent does. origin/main comparison — rejected because it can be absent or stale offline and HEAD is already the validated base in commit, review and ship contexts.
**Anchored-bet:** [VALIDATED]
**Revisit-when:** Drift advisories accumulate without CI catching them, or consumers require per-directory baseline refresh.
**Scope:** gate-engine/ratchets/**
**Source:** collab · frink#220
- 2026-08-22 — Ratchet storage is now ownership-based: guard-size and guard-fanout persist their engine-neutral size.json, size-lines.json, and fanout.json ceilings under .devkit/baselines, while eslint/baselines retains only the structure/import policy modules consumed by ESLint. Package-mode init/upgrade performs a one-way, byte-preserving migration and stages both sides of each tracked move; it restores narrowly scoped `.devkit/baselines` ignore exceptions before moving while preserving tracked manifests and standalone assets. Package-mode gate/freeze writes apply the same trackability preflight, overlay writes remain deliberately local, and ship worktree baseline symlinks remain writable. The canonical addition is verified in Git before the legacy deletion is staged, so an interrupted index update preserves debt. Concurrent migrations and writers converge when either side completes the move first. Equal duplicates collapse to the canonical copy and differing live copies stop before any write. Until migration runs, mixed-version readers accept an existing legacy path and retry canonical after a disappearing legacy read; the next gate tightening or explicit freeze writes canonical state and removes both storage generations when debt clears. This preserves shrink-only history without creating divergent copies or false missing-debt windows. Ship/review projection and deterministic-prefix fingerprinting carry both directories because both affect gate verdicts. This changes storage, not the Target’s staged/index attribution semantics.
