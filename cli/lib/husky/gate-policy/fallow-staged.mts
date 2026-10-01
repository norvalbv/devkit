/** The staged fallow audit every devkit-owned pre-commit block runs ([[fallow-gate-owned-by-fallow]]). */

// Index-scoped (sc-1549, sc-2341), fail-open like agents-hooks/fallow-staged-gate.sh: no fallow, an
// empty, unsized or over-cap (10 MiB) diff, or a fallow older than --diff-stdin skips the audit.
export const FALLOW_STAGED = `if command -v fallow >/dev/null 2>&1; then
    # A relative GIT_INDEX_FILE names a path from the worktree top, not this package subshell.
    case "\${GIT_INDEX_FILE:-}" in
        ''|/*) ;;
        *) GIT_INDEX_FILE="$(git rev-parse --show-toplevel)/$GIT_INDEX_FILE" || exit 1 ;;
    esac
    DK_FALLOW_DIFF="$(mktemp)" || exit 1
    if ! git diff --cached --binary --full-index --find-renames --relative >"$DK_FALLOW_DIFF"; then
        rm -f "$DK_FALLOW_DIFF"
        exit 1
    fi
    DK_FALLOW_BYTES="$(wc -c <"$DK_FALLOW_DIFF" 2>/dev/null | tr -d '[:space:]')" || DK_FALLOW_BYTES=""
    DK_FALLOW_RC=0
    if [ ! -s "$DK_FALLOW_DIFF" ]; then
        :
    elif case "$DK_FALLOW_BYTES" in ''|*[!0-9]*) true ;; *) false ;; esac; then
        echo "devkit fallow gate: could not size the staged diff — skipping the audit (an unsized diff may exceed fallow's --diff-stdin cap)."
    elif [ "$DK_FALLOW_BYTES" -gt 10485760 ]; then
        echo "devkit fallow gate: staged diff is $DK_FALLOW_BYTES bytes (fallow's --diff-stdin cap is 10485760) — skipping the audit."
    elif DK_FALLOW_VERSION="$(fallow --version 2>/dev/null </dev/null | sed -n 's/^fallow \\([0-9][0-9]*\\)\\.\\([0-9][0-9]*\\).*/\\1 \\2/p')" &&
        [ -n "$DK_FALLOW_VERSION" ] &&
        { [ "\${DK_FALLOW_VERSION% *}" -lt 3 ] ||
          { [ "\${DK_FALLOW_VERSION% *}" -eq 3 ] && [ "\${DK_FALLOW_VERSION#* }" -lt 6 ]; }; }; then
        echo "devkit fallow gate: fallow \${DK_FALLOW_VERSION% *}.\${DK_FALLOW_VERSION#* } predates --diff-stdin (needs 3.6.0+) — skipping the audit; upgrade fallow."
    else
        # __dk_no_git_env: fallow's snapshot machinery has clobbered a ship worktree before. The
        # staged diff is already captured with the committing index's git environment intact.
        __dk_no_git_env fallow audit --diff-stdin <"$DK_FALLOW_DIFF" || DK_FALLOW_RC=$?
    fi
    rm -f "$DK_FALLOW_DIFF"
    [ "$DK_FALLOW_RC" -eq 0 ] || exit 1
fi`;

// Hoisted (perf: no per-call regex compile).
const LINE_START_RE = /^(?=.)/gm;

// Package/standalone: skipped in review mode, which is diagnostic and never ran a fallow audit.
export const FALLOW_STAGED_BLOCK = `# devkit:fallow
if [ "\${DEVKIT_RUN_MODE:-}" != "review" ]; then
${FALLOW_STAGED.replace(LINE_START_RE, '    ')}
fi
# /devkit:fallow`;
