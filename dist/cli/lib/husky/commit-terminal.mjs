/**
 * Build the ordinary-commit telemetry prologue/terminal owned by devkit's pre-commit hook.
 *
 * A unique id is exported before gates start so every child process correlates to one attempt.
 * When commit-message judges are installed, a tree-bound handoff bridges Git's separate hook
 * processes; commit-msg validates and clears it. The terminal keeps the final staged tree as
 * metadata because formatting or another gate may restage content during the attempt.
 */
export function buildCommitTerminalFragment(handoffToCommitMsg) {
    return `# devkit:commit-terminal
if [ -z "\${DEVKIT_SHIP_ID:-}" ] && [ -z "\${DEVKIT_REVIEW_ID:-}" ] && [ -z "\${DEVKIT_NO_TELEMETRY:-}" ]; then
    __dk_nonce="$(uuidgen 2>/dev/null || true)"
    if [ -z "$__dk_nonce" ] && [ -r /dev/urandom ]; then
        __dk_nonce="$(od -An -N16 -tx1 /dev/urandom 2>/dev/null | tr -d ' \\n')" || __dk_nonce=""
    fi
    [ -n "$__dk_nonce" ] || __dk_nonce="$$-$(date +%s)"
    DEVKIT_COMMIT_ID="commit-run-$__dk_nonce"
    export DEVKIT_COMMIT_ID
${handoffToCommitMsg
        ? `    __dk_tree="$(git write-tree 2>/dev/null || true)"
    __dk_commit_state="$(git rev-parse --git-path devkit-commit-attempt 2>/dev/null || true)"
    if [ -n "$__dk_tree" ] && [ -n "$__dk_commit_state" ]; then
        printf '%s\\n%s\\n' "$DEVKIT_COMMIT_ID" "$__dk_tree" > "$__dk_commit_state" 2>/dev/null || true
    fi`
        : ''}
    __dk_t0="$(date +%s)"
    __dk_esc() { printf '%s' "$1" | sed -e 's/\\\\/\\\\\\\\/g' -e 's/"/\\\\"/g'; }
    __dk_repo() {
        # Repo identity = origin remote name, else main checkout dirname, else basename — a commit
        # run inside a temp worktree must not stamp the worktree's meaningless basename (sc-2000).
        __dk_r="$(git remote get-url origin 2>/dev/null | sed -E 's#/+$##; s#\\.git$##; s#.*[/:]##')"
        if [ -z "$__dk_r" ]; then
            __dk_c="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"
            [ -n "$__dk_c" ] && __dk_r="$(basename "$(dirname "$__dk_c")")"
        fi
        [ -n "$__dk_r" ] || __dk_r="$(basename "$(git rev-parse --show-toplevel 2>/dev/null)")"
        printf '%s' "$__dk_r"
    }
    __dk_commit_result() {
        [ -n "\${__dk_done:-}" ] && return 0
        __dk_done=1
        __dk_tree="$(git write-tree 2>/dev/null)" || return 0
        [ -n "$__dk_tree" ] || return 0
        if [ "\${1:-0}" -eq 0 ] && [ -n "\${__dk_commit_state:-}" ]; then
            printf '%s\\n%s\\n' "$DEVKIT_COMMIT_ID" "$__dk_tree" > "$__dk_commit_state" 2>/dev/null || true
        fi
        __dk_events="\${DEVKIT_GATE_EVENTS:-$HOME/.devkit/telemetry/gate-events.jsonl}"
        mkdir -p "$(dirname "$__dk_events")" 2>/dev/null || return 0
        printf '{"type":"commit_result","ship_id":"%s","commit_tree":"%s","run_mode":"commit","repo":"%s","branch":"%s","exit_code":%d,"duration_s":%d,"ts":"%s"}\\n' \\
            "$(__dk_esc "$DEVKIT_COMMIT_ID")" "$__dk_tree" \\
            "$(__dk_esc "$(__dk_repo)")" \\
            "$(__dk_esc "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)")" \\
            "\${1:-0}" "$(( $(date +%s) - __dk_t0 ))" \\
            "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$__dk_events" 2>/dev/null || true
        if [ "\${1:-0}" -ne 0 ] && [ -n "\${__dk_commit_state:-}" ]; then
            rm -f "$__dk_commit_state" 2>/dev/null || true
        fi
    }
    trap '__dk_commit_result "$?"' EXIT
fi
# /devkit:commit-terminal`;
}
