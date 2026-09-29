---
slug: review-authority-pins-snapshot-not-shared-refs
created: 2026-09-29
---

# review-authority-pins-snapshot-not-shared-refs

## Target · 2026-09-29 — Review authority pins the reviewed snapshot, not the shared ref namespace

**Context:** devkit review re-verifies the target repository before and after a multi-minute gate run. From ed8316f7 on, that check hashed every ref in the common .git and stat'd its refs/, packed-refs and reftable trees. In a clone shared by several agent sessions, any sibling's commit, fetch, tag or worktree add changed that fingerprint. Every review from a linked worktree then aborted with 'target repository metadata changed after capture; retry.', including a retry seconds later. That happened even though the reviewed HEAD, branch and trees never moved (autonomous report e0f6e9d9, sc-4159). High severity: devkit review becomes unusable in exactly the multi-agent setup devkit targets.
**Ruling:** The repository-state authority covers what defines the reviewed snapshot. That is the HEAD oid, the HEAD symref, the per-worktree ref namespaces git-worktree(1) names (refs/bisect, refs/worktree, refs/rewritten), and repository config. The merge-base is pinned as a commit by review-target.sh and the content by the staged/raw tree IDs. Shared refs (other branches, remote-tracking refs, tags, notes, packed-refs) are outside it, so the stat evidence is kept only for a linked worktree's own admin/refs trees, config and HEAD.
**Consequences:**
- Positive: A review started in a busy shared clone finishes, or fails only when the reviewed checkout itself changes. Its verdict still names one exact snapshot, because oids and tree IDs identify content independently of the ref store.
- Negative: Gates that read refs other than HEAD (tags, origin/*, notes) now see live values during a review rather than values frozen at capture, the same as they do at pre-commit. A ref created and deleted mid-capture in the shared namespace is no longer detected. A ref ABA in the main checkout's own refs/bisect is caught only by value, not by stat, because its storage is the shared refs/ tree. The shared config file is still frozen whole, so another session's 'git push -u' writing branch.* can still abort a review.
**Vision-fit:** n/a — internal tooling. It keeps devkit's review gate usable for concurrent autonomous agents sharing one clone.
**Researched:** git-worktree(1) REFS section: pseudo refs and refs/bisect, refs/worktree, refs/rewritten are per-worktree and everything else under refs/ is shared. gitrepository-layout(5). A prior-art pass returned DISSOLVE_FRAME: the snapshot is already pinned by oids and tree IDs, and no decision record justified freezing all refs (ed8316f7, #640). hasna/apps#2641 pins to caller-owned SHAs for the same reason.
**Rejected:** Isolating the review worktrees in a private repo that borrows objects via alternates and holds a ref copy taken at capture: it keeps frozen ref authority, but costs 1–2 days across worktree, submodule, dependency and projection setup for a guarantee no gate was shown to need. Fingerprinting the base ref by name: sibling sessions fetch origin/main constantly, so it would keep the abort alive, and the merge-base commit is what defines the diff. Stat'ing the loose file behind HEAD's branch for ABA: pack-refs/gc deletes it and reftable has none, so it adds false aborts while headOid already pins the value.
**Anchored-bet:** [BET]
**Revisit-when:** A gate's verdict is shown to depend on a shared ref other than HEAD or the pinned merge-base, or review worktrees move to an isolated ref store.
**Scope:** cli/lib/ship/review/repository/**
**Source:** shortcut · sc-4159
