/** Shell block policy shared by every hook flavour: which modes defer a gate's block to the finalizer. */
// Commit/ship exit on a block. Review remembers both lanes and dry-gates the deterministic one, so
// every selected gate still reports before REVIEW_FAILURE_FINALIZER (safe under `sh -e`).
export const DK_GATE_BLOCK_HELPERS = `dk_review_failed=0
dk_review_failed_gates=""
__dk_block_deterministic() {
    case "\${DEVKIT_RUN_MODE:-}" in review|dry-gates) ;; *) exit 1 ;; esac
    dk_review_failed=1
    dk_review_failed_gates="$dk_review_failed_gates $1"
}
__dk_block_ai() {
    [ "\${DEVKIT_RUN_MODE:-}" = review ] || exit 1
    dk_review_failed=1
    dk_review_failed_gates="$dk_review_failed_gates $1"
}`;
export const DK_DETERMINISTIC_GATE_HELPER = `__dk_gate_deterministic() {
    dk_det_rc=0
    __dk_no_git_env "$@" || dk_det_rc=$?
    [ "$dk_det_rc" -eq 0 ] && return 0
    __dk_block_deterministic deterministic-gates
}`;
// Always the block's last gate line: a monorepo package subshell holds the flag, and overlay chains after it.
export const REVIEW_FAILURE_FINALIZER = `# devkit:review-failure-finalizer
if [ "\${dk_review_failed:-0}" -ne 0 ]; then
    echo "✗ \${DEVKIT_RUN_MODE:-}: failed gates:$dk_review_failed_gates (findings above)."
    exit 1
fi
# /devkit:review-failure-finalizer`;
// `__dk_gate_ai <lane> <bin> args…`: the lane is shifted off BEFORE the probe, because `command -v`
// also resolves functions. The AI lane defers only a confirmed finding (1); outages and 4 exit.
export const DK_GATE_AI_HELPER = `__dk_gate_ai() {
    dk_lane="$1"
    shift
    command -v "$1" >/dev/null 2>&1 || return 0
    rc=0
    __dk_no_git_env "$@" || rc=$?
    { [ "$rc" -eq 0 ] || [ "$rc" -eq 2 ]; } && return 0
    if [ "$rc" -eq 4 ]; then
        echo "   $1: NOT a gate rejection — the staged content itself is unreadable (evidence above)."
    elif [ "$rc" -eq 3 ]; then
        echo "   $1: judge unavailable — strict ship mode failed closed. Follow the judge CLI remedy printed above, then re-run devkit ship."
    fi
    if [ "$dk_lane" = deterministic ]; then
        __dk_block_deterministic "$1"
    elif [ "$rc" -eq 1 ]; then
        __dk_block_ai "$1"
    else
        exit 1
    fi
}`;
