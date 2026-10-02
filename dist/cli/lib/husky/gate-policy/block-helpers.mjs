/** Shell block policy shared by every hook flavour: which modes defer a gate's block to the finalizer,
 *  and where the gates find devkit's bins. */
import { SHIP_REHEARSAL_LEAD } from '../../../../gate-engine/deterministic/recheck.mjs';
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
// Where a hook's gates find devkit's bins, what a missing one prints, and where the consumer's own
// formatter lives. Every gate reads the one variable, so the three modes render the same gate body.
const GLOBAL_MISSING = (bin) => `${bin} is missing from devkit's install — reinstall devkit`;
// A global devkit's bin dir holds only devkit's bins; the consumer's formatter is in its own.
const CONSUMER_BIN = 'node_modules/.bin';
export const BIN_DIRS = {
    // Package mode: the version pinned in the consumer's own dependencies.
    package: {
        open: '__dk_package_bin_dir="$(bun pm bin)"',
        close: '',
        missing: (bin) => `pinned ${bin} is missing — run bun install`,
        // `bun pm bin` is the consumer's own bin dir, so its formatter sits beside devkit's bins.
        formatter: '$__dk_package_bin_dir',
    },
    // Overlay: nothing is committed, so the global CLI is the only runtime and every commit needs it.
    global: {
        open: `__dk_package_bin_dir=$(command -v guard-deterministic) || {
    echo "devkit: not installed on PATH, and every commit here runs devkit's gates — install devkit, then commit again" >&2
    exit 1
}
__dk_package_bin_dir=\${__dk_package_bin_dir%/*}`,
        close: '',
        missing: GLOBAL_MISSING,
        formatter: CONSUMER_BIN,
    },
    // Standalone: a committed hook in a shared repo whose teammates may not install devkit, so the
    // whole block is skipped without it (its documented fail-open contract).
    'global-optional': {
        open: `# devkit standalone gates — global CLI, fail-open (skipped if devkit is not installed).
if __dk_package_bin_dir=$(command -v guard-deterministic); then
__dk_package_bin_dir=\${__dk_package_bin_dir%/*}`,
        close: 'fi',
        missing: GLOBAL_MISSING,
        formatter: CONSUMER_BIN,
    },
};
/**
 * A hook gate's own `|| { …; exit 1; }` arm: ship's exact --dry-gates command, only when a new ship
 * exported one (sc-2695). Printed quoted, never evaluated — the title in it is user text.
 */
export function shipRehearsalHint(indent) {
    return [
        'if [ -n "${DEVKIT_SHIP_DRY_GATES_CMD:-}" ]; then',
        `    echo "   ${SHIP_REHEARSAL_LEAD}" >&2`,
        '    printf \'     %s\\n\' "$DEVKIT_SHIP_DRY_GATES_CMD" >&2',
        'fi',
    ]
        .map((line) => `${indent}${line}`)
        .join('\n');
}
