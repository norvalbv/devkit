/** Shell fragments shared by package, standalone, overlay, and self-host review hooks. */
import { GIT_ENV_VARS } from "../../../gate-engine/judge/judge-isolation.mjs";
// Run a gate with git's per-repository environment stripped. Git EXPORTS GIT_DIR/GIT_INDEX_FILE into
// every hook, and for a hook run in a LINKED WORKTREE — how `devkit ship` commits — those values are
// ABSOLUTE paths into the ship worktree's admin dir. They are inherited by every descendant, so any
// gate (or tool a gate spawns) that runs git against a DIFFERENT repository writes that repository's
// index over the ship's staged diff. See GIT_ENV_VARS for the incident this prevents.
//
// Scrubbed per-invocation with `env -u` rather than a block-level `unset`: the overlay hook `exec`s
// the consumer's own pre-commit afterwards, and that hook must still receive git's stock environment.
// Gates themselves lose nothing — they run at the worktree root, where ordinary git discovery
// resolves the same repository through the worktree's `.git` file.
export const DK_NO_GIT_ENV_HELPER = `__dk_no_git_env() {
    env ${GIT_ENV_VARS.map((name) => `-u ${name}`).join(' \\\n        ')} "$@"
}`;
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
// The helper pair every hook flavour (package, standalone, overlay, self-host) opens its gate region
// with, in emit order. Spread as one unit so a new shared helper reaches all four builders at once —
// and so none of them can drift into emitting a gate whose helper was never defined.
export const DK_HOOK_HELPERS = [DK_GATE_SELECTED_HELPER, DK_NO_GIT_ENV_HELPER];
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
