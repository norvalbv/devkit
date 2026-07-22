#!/usr/bin/env node
// Shared git-index helpers for the ratchet gates (folder-fanout / size-disable). Both gates
// auto-lower a baseline during a commit and need the same two primitives, so they live here as
// ONE code path rather than duplicated per ratchet.
import { execFileSync } from 'node:child_process';
// Best-effort `git add` for a baseline the gate rewrote OR deleted, so the change rides the same
// commit. `git add -- <rel>` stages a modification AND a deletion (git records the removal), so the
// one call covers auto-lower and heal-delete alike. Never throws: a shrink must not block the gate,
// and non-git contexts (temp-dir tests, a bare checkout) simply leave the change on disk for a later
// commit/freeze.
export function stageBaseline(root, rel) {
    try {
        execFileSync('git', ['add', '--', rel], { cwd: root, stdio: 'pipe' });
    }
    catch {
        // not a git repo / git absent — the change is still on disk; picked up on the next commit.
        // ponytail: also swallows the ship worktree's `fatal: pathspec ... is beyond a symbolic link`
        // (exit 128) when eslint/baselines is symlinked in for an OVERLAY repo. Load-bearing: the write
        // itself lands on the real root file (the source of truth there, since overlay never commits
        // baselines) and staying unstaged is what keeps overlay git-invisible. So the recorded
        // "self-deletes & stages" contract (overlay-self-heal Ruling 2) degrades to "self-deletes" only
        // in that context. Do NOT realpath-resolve to force the add — that commits baselines into a repo
        // that deliberately never adopted them.
    }
}
// True iff a commit is in progress (anything staged, ANY status incl. deletions/renames). Used to
// gate the heal-delete: a folder pile heals by DELETING files, so an ACMR-only check (stagedSet)
// would miss a pure-deletion commit and never fire. Non-git / no staged changes → false (CI, a
// manual gate run — never mutate the tree there).
export function hasStagedFiles(root) {
    try {
        const out = execFileSync('git', ['diff', '--cached', '--name-only'], {
            cwd: root,
            encoding: 'utf8',
        });
        return out.split('\n').some((l) => l.trim().length > 0);
    }
    catch {
        return false;
    }
}
// The repo-root-relative paths ADDED/COPIED/MODIFIED/RENAMED in the pending commit (the git index).
// Returns null when git is unavailable (temp-dir tests, a non-git checkout) so the caller falls back
// to whole-tree. Excludes deletions by design — callers scope per-file work (an oversized file to
// re-check) to files that still exist. For "is a commit in progress?" use hasStagedFiles instead.
export function stagedSet(root) {
    try {
        const out = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], {
            cwd: root,
            encoding: 'utf8',
        });
        return new Set(out
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean));
    }
    catch {
        return null;
    }
}
