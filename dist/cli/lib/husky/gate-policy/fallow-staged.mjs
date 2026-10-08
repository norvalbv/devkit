/** The staged fallow audit every consumer pre-commit block runs when fallow is selected. */
import { shipRehearsalHint } from './block-helpers.mjs';
// Scoped to the index: a ref range cannot express the staged set. Blocks on fallow's fail verdict
// (exit 1) only; an absent fallow, an empty or over-cap diff, and a fallow error all skip the audit.
export const FALLOW_STAGED = `if command -v fallow >/dev/null 2>&1; then
    DK_FALLOW_DIFF="$(mktemp 2>/dev/null)" || DK_FALLOW_DIFF=""
    DK_FALLOW_RC=0
    # Git's relative GIT_DIR/GIT_INDEX_FILE break after a package cd, so the repo is rediscovered
    # from here; an alternate commit index arrives through the absolute devkit carrier.
    if [ -z "$DK_FALLOW_DIFF" ] || ! __dk_no_git_env env \${DEVKIT_COMMIT_INDEX_FILE:+"GIT_INDEX_FILE=$DEVKIT_COMMIT_INDEX_FILE"} \\
        git diff --cached --binary --full-index --find-renames --relative >"$DK_FALLOW_DIFF"; then
        echo "devkit fallow gate: could not capture the staged diff — audit skipped."
    elif [ ! -s "$DK_FALLOW_DIFF" ]; then
        :
    elif [ "$(($(wc -c <"$DK_FALLOW_DIFF")))" -gt 10485760 ]; then
        # Above its --diff-stdin cap fallow drops the line filter and reports the whole project.
        echo "devkit fallow gate: staged diff exceeds fallow's 10 MiB --diff-stdin cap — audit skipped."
    else
        # __dk_no_git_env: fallow's snapshot machinery has clobbered a ship worktree before.
        __dk_no_git_env fallow audit --diff-stdin <"$DK_FALLOW_DIFF" || DK_FALLOW_RC=$?
    fi
    [ -z "$DK_FALLOW_DIFF" ] || rm -f "$DK_FALLOW_DIFF"
    if [ "$DK_FALLOW_RC" -eq 1 ]; then
${shipRehearsalHint('        ')}
        exit 1
    elif [ "$DK_FALLOW_RC" -ne 0 ]; then
        # Exit 2+ is a fallow error (no detectable base branch, bad config), never a finding.
        echo "devkit fallow gate: fallow exited $DK_FALLOW_RC without a verdict (its message is above) — audit skipped, commit not blocked."
    fi
fi`;
// Hoisted (perf: no per-call regex compile).
const LINE_START_RE = /^(?=.)/gm;
export const indent = (body) => body.replace(LINE_START_RE, '    ');
// Package and standalone hooks. Review mode is diagnostic and runs no staged audit.
export const FALLOW_STAGED_BLOCK = `# devkit:fallow
if [ "\${DEVKIT_RUN_MODE:-}" != "review" ]; then
${indent(FALLOW_STAGED)}
fi
# /devkit:fallow`;
/** The init progress line saying where fallow gates commits for this install shape. */
export function fallowGateLine(husky, selfHost) {
    if (!husky)
        return '! fallow gate not wired: no pre-commit hook is selected (re-run with husky)';
    return selfHost
        ? '✓ fallow: advisory audit runs in the self-host hook (never blocks)'
        : '✓ fallow gate: staged audit runs in the devkit block of .husky/pre-commit';
}
