import { buildCommitTerminalFragment } from '../commit-terminal.mts';

/** A plain commit's gate output → .devkit/last-commit-gates-<branch>.log (sc-2755); ship and review
 *  keep their own. A file sink that fails open: every redirect runs under `command exec`. */

/** The consumer gitignore pattern, shared with gitignore-cache.mts. */
export const COMMIT_GATE_LOG_GLOB = '.devkit/last-commit-gates-*.log';

/**
 * The trap every devkit hook installs. Each named function runs only when defined, so a fragment
 * that skipped itself (telemetry off, capture off) simply drops out.
 */
export function exitDispatchTrap(fns: string[]): string {
  const calls = fns
    .map((fn) => `command -v ${fn} >/dev/null 2>&1 && { ${fn} "$__dk_x" || :; }`)
    .join('; ');
  return `trap '__dk_x=$?; __dk_gl_rc=$__dk_x; ${calls}; :' EXIT`;
}

/** pre-commit truncates the log and leaves a git-dir handoff; commit-msg appends to the log it names,
 *  then clears it — one log per attempt. */
export function buildCommitGateLogFragment(hook: 'pre-commit' | 'commit-msg'): string {
  const append = hook === 'commit-msg';
  return `# devkit:gate-log
# Full gate output → .devkit/last-commit-gates-<branch>.log; off under ship/review and DEVKIT_GATE_LOG=0.
__dk_gate_log=""
__dk_gate_log_open() {
    case "\${DEVKIT_GATE_LOG:-1}" in 0|off|false|no) return 0 ;; esac
    [ -z "\${DEVKIT_SHIP_ID:-}" ] && [ -z "\${DEVKIT_REVIEW_ID:-}" ] && [ -z "\${DEVKIT_RUN_MODE:-}" ] || return 0
    __dk_gl_top="$(git rev-parse --show-toplevel 2>/dev/null)" || return 0
    [ -n "$__dk_gl_top" ] || return 0
    __dk_gl_br="$(git symbolic-ref --short -q HEAD 2>/dev/null || git rev-parse --short HEAD 2>/dev/null || echo detached)"
    __dk_gl_path="$__dk_gl_top/.devkit/last-commit-gates-$(printf '%s' "$__dk_gl_br" | tr '/' '-').log"
    __dk_gl_hand="$(git rev-parse --path-format=absolute --git-path devkit-gate-log 2>/dev/null || true)"
    __dk_gl_mode=fresh
${
  append
    ? `    if [ -n "$__dk_gl_hand" ] && [ -f "$__dk_gl_path" ] && [ "$(cat "$__dk_gl_hand" 2>/dev/null)" = "$__dk_gl_path" ]; then
        __dk_gl_mode=append
    fi
`
    : ''
}    if [ "$__dk_gl_mode" = append ]; then
        ( umask 077; : >> "$__dk_gl_path" ) 2>/dev/null || __dk_gl_mode=failed
    else
        ( umask 077; mkdir -p "$__dk_gl_top/.devkit" && : > "$__dk_gl_path" ) 2>/dev/null || __dk_gl_mode=failed
    fi
    # Self-ignoring, so neither a stale .gitignore nor a pruned overlay exclude offers the log to git add.
    if [ "$__dk_gl_mode" = fresh ] && [ ! -e "$__dk_gl_top/.devkit/.gitignore" ]; then
        printf '%s\\n' '# devkit (sc-2755): local gate output, never committed.' \\
            '/last-commit-gates-*.log' '/.gitignore' > "$__dk_gl_top/.devkit/.gitignore" 2>/dev/null || true
    fi
    if [ "$__dk_gl_mode" = failed ]; then
        echo "⚠️  devkit: could not write the gate log $__dk_gl_path — gates still run, output is not persisted." >&2
        return 0
    fi
    __dk_gl_off="$(wc -c < "$__dk_gl_path" 2>/dev/null | tr -d ' ')"
    printf '=== devkit ${hook} gates · %s · attempt %s · %s\\n' \\
        "$__dk_gl_br" "\${DEVKIT_COMMIT_ID:-none}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$__dk_gl_path" 2>/dev/null || true
    command exec 8>&1 9>&2 || return 0
    if ! command exec >>"$__dk_gl_path" 2>&1; then
        command exec 2>&9 || true
        echo "⚠️  devkit: could not redirect into the gate log $__dk_gl_path — output is not persisted." >&2
        return 0
    fi
    __dk_gate_log="$__dk_gl_path"
${
  append
    ? ''
    : `    [ -n "$__dk_gl_hand" ] && { printf '%s\\n' "$__dk_gate_log" > "$__dk_gl_hand"; } 2>/dev/null || true
`
}    # A terminal watches live; a pipe (agent, GUI client, CI) gets the same bytes replayed at exit.
    __dk_gl_follow=""
    if [ -t 9 ]; then
        tail -c "+$(( \${__dk_gl_off:-0} + 1 ))" -f "$__dk_gate_log" >&9 2>/dev/null </dev/null &
        __dk_gl_follow=$!
    fi
}
__dk_gate_log_finish() {
    [ -n "$__dk_gate_log" ] || return 0
    __dk_gl_x="\${__dk_gl_rc:-0}"
    command exec 1>&8 2>&9 || return 0
    if [ -n "$__dk_gl_follow" ]; then
        sleep 1 2>/dev/null || true
        kill "$__dk_gl_follow" 2>/dev/null || true
        wait "$__dk_gl_follow" 2>/dev/null || true
    else
        tail -c "+$(( \${__dk_gl_off:-0} + 1 ))" "$__dk_gate_log" 2>/dev/null || true
    fi
${
  append
    ? `    rm -f "$__dk_gl_hand" 2>/dev/null || true
`
    : `    [ "$__dk_gl_x" -eq 0 ] || rm -f "$__dk_gl_hand" 2>/dev/null || true
`
}    if [ "$__dk_gl_x" -eq 0 ]; then
        echo "✓ ${hook} gates ran — full output: $__dk_gate_log"
        echo "  Review it for any SKIP / BYPASSED / DEGRADED / ⚠️ lines — a bypassed gate verified nothing."
    else
        echo "🛑 ${hook} blocked. Full log: $__dk_gate_log"
        echo "   It holds every gate's output, including non-blocking findings above the blocking one."
    fi
    __dk_gate_log=""
}
__dk_gate_log_open "$@" || true
# /devkit:gate-log`;
}

// bash leaks a redirect-only `exec`'s function args into the CALLER, so both functions take the
// caller's "$@" and the status rides in $__dk_gl_rc (pinned by the overlay ARGC=0 test).
export const GATE_LOG_FINISH_PASS =
  'command -v __dk_gate_log_finish >/dev/null 2>&1 && { __dk_gl_rc=0; __dk_gate_log_finish "$@" || :; }';

/** pre-commit: the telemetry terminal, then the capture, then the one EXIT trap they share. */
export function buildPreCommitExit(handoff: boolean): string {
  return `${buildCommitTerminalFragment(handoff)}\n${buildCommitGateLogFragment('pre-commit')}\n${exitDispatchTrap(['__dk_commit_result', '__dk_gate_log_finish'])}`;
}

/** The overlay's pass path runs the exit work itself: \`exec\` into the repo's hook drops the trap. */
export const PRE_COMMIT_PASS_EXIT = `trap - EXIT
command -v __dk_commit_result >/dev/null 2>&1 && { __dk_commit_result 0 || :; }
${GATE_LOG_FINISH_PASS}`;
