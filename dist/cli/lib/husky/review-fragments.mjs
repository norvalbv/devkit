/** Shell fragments shared by package, standalone, overlay, and self-host review hooks. */
// Review mode has its own positive guard allowlist. Normal commit/ship runs select everything in
// the generated hook; review runs only ids named by DEVKIT_REVIEW_GUARDS.
export const DK_GATE_SELECTED_HELPER = `__dk_gate_selected() {
    [ "\${DEVKIT_RUN_MODE:-}" != "review" ] && return 0
    __dk_review_guards=$(printf '%s' "\${DEVKIT_REVIEW_GUARDS:-}" | sed \
        -e 's/[[:space:]]*,[[:space:]]*/,/g' \
        -e 's/^[[:space:]]*//' \
        -e 's/[[:space:]]*$//')
    case ",\${__dk_review_guards}," in
        *,"$1",*) return 0 ;;
        *) return 1 ;;
    esac
}`;
export function selectedFragment(id, fragment) {
    return `if __dk_gate_selected ${id}; then
${fragment}
fi`;
}
// Review snapshots need a fresh merge-base comparison rather than the consumer's potentially stale
// persisted baselines. The driver exports the current package root + an invocation-unique runtime;
// a missing helper is setup drift and must block rather than silently falling back to raw lint.
export const DK_REVIEW_BASELINE_HELPER = `__dk_review_baseline_gate() {
    [ -n "\${DEVKIT_REVIEW_BASELINE_DIR:-}" ] || {
        echo "devkit review: merge-base baseline runtime is missing — reinstall/rebuild Devkit." >&2
        return 1
    }
    __dk_baseline_gate=
    for __dk_candidate in "\${DEVKIT_REVIEW_PACKAGE_ROOT:-}/gate-engine/review/baseline-gate.mjs" "\${DEVKIT_REVIEW_PACKAGE_ROOT:-}/gate-engine/review/baseline-gate.mts"; do
        if [ -f "$__dk_candidate" ]; then __dk_baseline_gate=$__dk_candidate; break; fi
    done
    [ -n "$__dk_baseline_gate" ] || {
        echo "devkit review: baseline helper is missing — reinstall/rebuild Devkit." >&2
        return 1
    }
    node "$__dk_baseline_gate" "$1" "$DEVKIT_REVIEW_BASELINE_DIR"
}`;
