/** The staged fallow audit every consumer pre-commit block runs when fallow is selected. */

import { shipRehearsalHint } from './block-helpers.mts';

// Scoped to the index: a ref range cannot express the staged set. Blocks on a fail verdict or on
// introduced duplication; an absent fallow, an empty or over-cap diff, and a fallow error skip it.
export const FALLOW_STAGED = `if command -v fallow >/dev/null 2>&1; then
    DK_FALLOW_DIFF="$(mktemp 2>/dev/null)" || DK_FALLOW_DIFF=""
    DK_FALLOW_RC=0
    DK_FALLOW_DUP=0
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
        # fallow rejects a map holding a negative hit and looks only under its cwd, so it is handed
        # a clamped copy of the repo's artifact. Ship's own FALLOW_COVERAGE is left in place.
        DK_FALLOW_COV=""
        if [ -z "\${FALLOW_COVERAGE:-}" ] && [ -x "\${__dk_package_bin_dir:-}/guard-coverage" ]; then
            DK_FALLOW_COV="$(__dk_no_git_env "$__dk_package_bin_dir/guard-coverage" fallow-copy)" ||
                echo "devkit fallow gate: no measured coverage for this audit — CRAP is estimated here and measured at ship."
        fi
        # __dk_no_git_env: fallow's snapshot machinery has clobbered a ship worktree before.
        DK_FALLOW_JSON="$(__dk_no_git_env env \${DK_FALLOW_COV:+"FALLOW_COVERAGE=$DK_FALLOW_COV"} \\
            fallow audit --diff-stdin --format json --quiet <"$DK_FALLOW_DIFF")" || DK_FALLOW_RC=$?
        # Introduced duplication alone is verdict warn, exit 0. Fallow's JSON is one line with escaped
        # fragments, so only its attribution counter can match this pattern.
        [ "$DK_FALLOW_RC" -ne 0 ] || case "$DK_FALLOW_JSON" in
            *'"duplication_introduced":'[1-9]*) DK_FALLOW_DUP=1 ;;
        esac
        # The JSON carries no prose, so anything but a clean pass re-runs for fallow's own report.
        if [ "$DK_FALLOW_RC" -ne 0 ] || [ "$DK_FALLOW_DUP" -eq 1 ] ||
            case "$DK_FALLOW_JSON" in *'"verdict":"pass"'*) false ;; *) true ;; esac; then
            __dk_no_git_env env \${DK_FALLOW_COV:+"FALLOW_COVERAGE=$DK_FALLOW_COV"} \\
                fallow audit --diff-stdin <"$DK_FALLOW_DIFF" || true
        else
            echo "devkit fallow gate: fallow passed the staged diff (verdict pass)."
        fi
        [ -z "$DK_FALLOW_COV" ] || rm -f "$DK_FALLOW_COV"
    fi
    [ -z "$DK_FALLOW_DIFF" ] || rm -f "$DK_FALLOW_DIFF"
    if [ "$DK_FALLOW_RC" -eq 1 ] || [ "$DK_FALLOW_DUP" -eq 1 ]; then
        [ "$DK_FALLOW_DUP" -eq 0 ] ||
            echo "devkit fallow gate: the staged diff introduces duplication — fallow rates it warn, this gate blocks it. Extract the shared code, or suppress it with // fallow-ignore-next-line code-duplication."
${shipRehearsalHint('        ')}
        __dk_block_deterministic fallow
    elif [ "$DK_FALLOW_RC" -ne 0 ]; then
        # Exit 2+ is a fallow error (no detectable base branch, bad config), never a finding.
        echo "devkit fallow gate: fallow exited $DK_FALLOW_RC without a verdict (its message is above) — audit skipped, commit not blocked."
    fi
fi`;

// Hoisted (perf: no per-call regex compile).
const LINE_START_RE = /^(?=.)/gm;
export const indent = (body: string) => body.replace(LINE_START_RE, '    ');

// Package and standalone hooks. Review mode is diagnostic and runs no staged audit.
export const FALLOW_STAGED_BLOCK = `# devkit:fallow
if [ "\${DEVKIT_RUN_MODE:-}" != "review" ]; then
${indent(FALLOW_STAGED)}
fi
# /devkit:fallow`;

/** The init progress line saying where fallow gates commits for this install shape. */
export function fallowGateLine(husky: boolean, selfHost: boolean): string {
  if (!husky) return '! fallow gate not wired: no pre-commit hook is selected (re-run with husky)';
  return selfHost
    ? '✓ fallow: advisory audit runs in the self-host hook (never blocks)'
    : '✓ fallow gate: staged audit runs in the devkit block of .husky/pre-commit';
}
