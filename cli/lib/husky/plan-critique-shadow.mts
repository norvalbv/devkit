import { quoteShellToken } from '../guard/protected-branch-guard.mts';

/** Internal gates-only exit used to propagate an observation attempt across the global shim child. */
export const PLAN_CRITIQUE_OBSERVED_EXIT = 88;

export const planCritiqueGatesOnlyFragment = `# Invoked by the global init.sh shim (husky reclaimed core.hooksPath on a plain \`git commit\`):
# run gates ONLY and stop — husky's _/h runs the repo's committed hook itself, so chaining here
# would run it twice. Reached only after the gates above PASSED (a failure already exited 1).
if [ -n "\${DEVKIT_VIA_HUSKY_INIT:-}" ]; then
    if [ -n "\${DEVKIT_PLAN_CRITIQUE_OBSERVED:-}" ]; then
        # The reserved status is an inter-process signal, not a commit failure. Settle telemetry as
        # success and disarm the EXIT trap before returning the signal to the sourced parent shim.
        command -v __dk_commit_result >/dev/null 2>&1 && { trap - EXIT; __dk_commit_result 0; }
        exit ${PLAN_CRITIQUE_OBSERVED_EXIT}
    fi
    exit 0
fi`;

const PACKAGE_RUNTIME = 'node_modules/@norvalbv/devkit/dist/gate-engine/critique/capture.mjs';
const SOURCE_RUNTIME = 'gate-engine/critique/capture.mts';

/**
 * Shadow-only commit observation for plan-critique evidence. It never enters reviewer prompts,
 * blocks a commit, or writes into the working tree. Package-local, hoisted, and self-host runtimes
 * are tried; standalone/global installs without one simply skip.
 *
 * The exported latch is set outside package subshells once a runtime is found. It prevents a
 * multi-package hook—or an overlay that chains the committed hook—from recording the same commit
 * more than once without suppressing a later package whose runtime is the first available one.
 */
export function planCritiqueShadowFragment(pkgRel = ''): string {
  const packageRuntime = pkgRel ? `${pkgRel}/${PACKAGE_RUNTIME}` : PACKAGE_RUNTIME;
  return `# devkit:plan-critique-shadow
if [ -z "\${DEVKIT_PLAN_CRITIQUE_OBSERVED:-}" ]; then
    __dk_pc_root="$(git rev-parse --show-toplevel 2>/dev/null)"
    [ -n "$__dk_pc_root" ] || __dk_pc_root="$PWD"
    __dk_pc_cwd="\${DEVKIT_PLAN_CRITIQUE_SOURCE_CWD:-$__dk_pc_root}"
    for __dk_pc in \
      ${quoteShellToken(packageRuntime)} \
      "$__dk_pc_root/${PACKAGE_RUNTIME}" \
      "$__dk_pc_root/${SOURCE_RUNTIME}"; do
        if [ -f "$__dk_pc" ]; then
            DEVKIT_PLAN_CRITIQUE_OBSERVED=1
            export DEVKIT_PLAN_CRITIQUE_OBSERVED
            node "$__dk_pc" commit-projection "$__dk_pc_cwd" >/dev/null 2>&1 || true
            break
        fi
    done
    unset __dk_pc __dk_pc_root __dk_pc_cwd
fi
# /devkit:plan-critique-shadow`;
}
