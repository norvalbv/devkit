---
slug: move-preserves-index-and-destination-ownership
created: 2026-08-31
---

# move-preserves-index-and-destination-ownership

## Target · 2026-08-31 — Move preserves index and destination ownership

**Context:** devkit move delegated every relocation to git mv, so newly authored untracked source directories failed before their first commit. The obvious filesystem-rename fallback would silently overwrite a destination created after preflight and would ignore paths or ancestors owned only by the Git index, exposing consumer code and index state to data loss.
**Ruling:** Treat preflight index state only as a dispatch hint. Keep normal git mv semantics for tracked candidates, which makes Git revalidate and serialize their index ownership; represent untracked candidates containing files only in an isolated temporary index, revalidate their source identity and source/destination index ownership while holding the real index lock, and abort before import or baseline rewrites when filesystem boundaries change.
**Consequences:**
- Positive: Agents can relocate pre-first-commit source trees containing files without staging them, tracked moves retain Git history, the caller's real index remains byte-for-byte unchanged, and races fail without silently rewriting imports toward the wrong location.
- Negative: An untracked move briefly owns the repository-wide index lock, creates a temporary index, and pays extra Git processes. Empty untracked directories are rejected because Git cannot represent them without creating race-prone filesystem state. Signal handlers must remove lock state; an adversarial destination race can leave the source at a precisely reported Git-created path for manual recovery rather than risk a second destructive move.
**Vision-fit:** n/a — internal developer tooling reliability
**Researched:** Git git-mv documentation and builtin/mv.c behavior; Story SC-2383 autonomous evidence; local prior-art and feature-critique reviews; focused race and index-state integration tests.
**Rejected:** Raw filesystem rename — rejected because POSIX rename can overwrite a concurrently created target and cannot see index-only ownership. Mutating the real index with intent-to-add then resetting — rejected because interruption exposes transient staged state. Recursive copy/delete — rejected because it weakens source-level move semantics and increases partial-failure surface.
**Anchored-bet:** [VALIDATED]
**Revisit-when:** Git provides an untracked exact-target move that leaves the real index untouched, or Node exposes a portable atomic no-replace directory rename.
**Scope:** cli/commands/move.mts,cli/lib/git-tracked.mts,cli/lib/git-tracked.test.mts,cli/__tests__/move.test.mts
**Source:** shortcut · SC-2383
