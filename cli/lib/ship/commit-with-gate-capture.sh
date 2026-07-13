#!/usr/bin/env bash
# Shared by ship-branch.sh (new-ship) and reship.sh (--pr): run the worktree commit so the pre-commit
# gate output is BOTH streamed to the caller AND captured to a per-branch log, while preserving the
# commit's real exit code.
#
# Why: git routes every hook's stdout+stderr to the commit command's STDERR, interleaved with ship
# ceremony and easily truncated by an agent's tool output — so a shipping agent doesn't reliably see
# the gate verdicts a normal `git commit` shows. The log is the full, untruncated record; a compact
# status line points the agent at it.
#
# Mechanics: `2>&1 | tee "$log" >&2` — fold the gate output (which is on stderr) into the stream BEFORE
# tee, capture it to the log, and send tee's copy to STDERR (never stdout — the PR URL must stay the
# caller's last stdout line). `${PIPESTATUS[0]}` preserves the commit's real exit code under
# `set -euo pipefail`, guarded by a `set +e`/`set -e` island so a blocking gate doesn't abort before
# we read it; the non-zero return then lets the caller's `set -e` abort + its cleanup trap drop the
# empty branch (unchanged failure semantics, plus visibility).
#
# R2 (sc-1002): bound the commit so a HUNG gate can't wedge a shipping AGENT forever. A pre-commit gate
# that never returns (a wedged `claude -p` judge / `bunx` toolchain) — or any child it backgrounds that
# inherits git's stdout — would otherwise keep `git commit` AND the `tee` pipe blocked, with no human to
# Ctrl-C. We wrap the commit in coreutils `timeout`; on expiry its DEFAULT process-group kill reaps the
# hook AND its grandchildren, closing every copy of the pipe write-end so `tee` unblocks and the pipeline
# returns 124. The non-zero rc then flows through the caller's `set -e` + EXIT trap (unchanged failure path).
#
# NEVER add `timeout --foreground`: it signals only the leader (git), leaving a backgrounded pipe-holder
# alive → `tee` blocks forever → the timeout buys nothing. The default group-kill is the whole point.
#
# Portability: macOS ships no `timeout` (it's coreutils `gtimeout`, or absent). With neither on PATH we run
# bare (today's behaviour) and say so once — a silent no-op the operator THINKS protects them is worse.
#
# Usage:  commit_with_gate_capture <worktree> <root> <branch> <title> <body>
commit_with_gate_capture() {
  local wt="$1" root="$2" br="$3" title="$4" body="$5"
  local log="$root/.devkit/last-ship-gates-${br//\//-}.log"
  local progress="$root/.devkit/review-progress-${br//\//-}.json"
  # The progress READER lives beside gate-engine — resolve it relative to THIS script so it works in
  # every install mode (package node_modules, standalone, devkit's own repo) with no bunx/registry hit.
  local progress_reader="$(dirname "${BASH_SOURCE[0]}")/../../../gate-engine/review/progress.mts"
  [ -f "$progress_reader" ] || progress_reader="$(dirname "${BASH_SOURCE[0]}")/../../../gate-engine/review/progress.mjs"
  mkdir -p "$root/.devkit"
  rm -f "$progress"   # a stale file from a prior attempt must not mislead this run's timeout banner

  # Ship-mode gate contract, inherited by the hook chain through git → husky → node:
  #   DEVKIT_SHIP=1           arms the deterministic-prefix cache (guard-prefix check/record) — only a
  #                           ship worktree guarantees working tree ≡ index, the key's soundness bound.
  #   GUARD_AI_STRICT=1       AI judges retry once then FAIL CLOSED (exit 3) instead of skipping —
  #                           a ship never silently drops the checks it exists to run. Ad-hoc commits
  #                           outside ship keep their fail-open default.
  #   DEVKIT_REVIEW_PROGRESS  where guard-review records {running,completed} reviewer names, so a
  #                           timeout can name the ones left unfinished (structured, not stderr prose).
  export DEVKIT_SHIP=1 GUARD_AI_STRICT=1 DEVKIT_REVIEW_PROGRESS="$progress"

  # Gate telemetry (best-effort, ship-scoped). A shared append-only JSONL sink + one ship_id per
  # attempt, inherited by every in-chain gate the SAME way DEVKIT_REVIEW_PROGRESS is — so the
  # deterministic/decisions/review events (emitted from the node gates via gate-events.mts) and the
  # ship_attempt/ship_result lines below all carry the same ship_id and correlate. Off-ship the env
  # is unset and nothing is emitted. A downstream reader (the usage tracker's collector) tail-ingests
  # it; every write is `>> … || true` so telemetry can never fail the ship.
  export DEVKIT_GATE_EVENTS="${DEVKIT_GATE_EVENTS:-$HOME/.devkit/telemetry/gate-events.jsonl}"
  export DEVKIT_SHIP_ID="${DEVKIT_SHIP_ID:-$(uuidgen 2>/dev/null || echo "${br//\//-}-$$-$(date +%s)")}"
  mkdir -p "$(dirname "$DEVKIT_GATE_EVENTS")" 2>/dev/null || true
  local repo_name; repo_name="$(basename "$root")"

  # Realistic worst case (first ship, nothing cached): deterministic prefix ~240s + decisions detect
  # ≤60s + alignment cascade ≤480s (only when a scoped Target matches) + one review cascade whose
  # slow judge (correctness) can now run up to its 30-min cap (see run-review.mts) — but in practice
  # one slow wave + fast waves lands well under this 3600s ceiling. A kill here CONVERGES on re-run
  # (earned verdicts cached, reviewer PASSes checkpoint per-completion), not a restart. This is a hang
  # CEILING, not a per-gate budget — raise it (export SHIP_COMMIT_TIMEOUT) if a real ship needs more.
  local secs=${SHIP_COMMIT_TIMEOUT:-3600}
  local to_bin to=()
  to_bin=$(command -v timeout || command -v gtimeout || true)
  if [ -n "$to_bin" ]; then
    to=("$to_bin" -k 10 "$secs")           # -k 10: SIGKILL escalation for a gate that traps TERM
  else
    echo "ship: no timeout/gtimeout on PATH — gate-hang protection disabled (brew install coreutils to enable)" >&2
  fi

  # Overlay mode: force core.hooksPath at the .devkit overlay hook so the FULL gate chain runs in the
  # ship worktree in EVERY state. A plain `git commit` otherwise honours the husky-reclaimed
  # core.hooksPath=.husky/_ and runs only the team's committed hook — the overlay chain (devkit's
  # gates) silently no-ops (the bug this fixes). ship-branch/reship linked .devkit in, so the relative
  # path resolves to $wt/.devkit/hooks via the symlink; the overlay hook then execs the repo's own
  # committed hook too. Non-overlay repos have no such file → empty array → unchanged behaviour.
  local hookcfg=()
  [ -x "$root/.devkit/hooks/pre-commit" ] && hookcfg=(-c core.hooksPath=.devkit/hooks)

  # Ship attempt telemetry — one line per commit attempt; count-per-branch = the number of times the
  # root agent re-shipped after a gate blocked it. mode ('ship'|'reship') is set by the caller.
  local dur_start; dur_start=$(date +%s)
  printf '{"type":"ship_attempt","ship_id":"%s","repo":"%s","branch":"%s","mode":"%s","ts":"%s"}\n' \
    "$DEVKIT_SHIP_ID" "$repo_name" "$br" "${DEVKIT_SHIP_MODE:-ship}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    >> "$DEVKIT_GATE_EVENTS" 2>/dev/null || true

  set +e
  # ${to[@]+"${to[@]}"}: set -u-safe empty-array expansion (a bare "${to[@]}" aborts under stock-macOS
  # bash 3.2). Empty → bare git (degrade); non-empty → `timeout -k 10 <secs> git …`. PIPESTATUS[0] is the
  # timeout/git exit (124 on timeout) through both forms — never tee's. hookcfg expands the same way.
  ${to[@]+"${to[@]}"} git -C "$wt" ${hookcfg[@]+"${hookcfg[@]}"} commit -m "$title" -m "$body" 2>&1 | tee "$log" >&2
  local rc=${PIPESTATUS[0]}
  set -e

  # Ship result telemetry — the outcome + a coarse blocked_gate tag derived from the captured log
  # (the per-gate/per-reviewer events carry the precise cause). Chain order is deterministic →
  # decisions → review, and each hook step is `|| exit`, so exactly one gate blocks; grep in that
  # order attributes it. qavis is advisory (never blocks a ship) so it is not a blocked_gate value.
  local blocked_json timed_out
  if [ "$rc" -eq 0 ]; then blocked_json=null; timed_out=false
  elif [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then blocked_json='"timeout"'; timed_out=true
  elif grep -q '✗ deterministic gates failed' "$log" 2>/dev/null; then blocked_json='"deterministic"'; timed_out=false
  elif grep -q 'decision smells:' "$log" 2>/dev/null; then blocked_json='"decisions"'; timed_out=false
  elif grep -qE 'guard-review: .* (FAILED|INCONCLUSIVE)' "$log" 2>/dev/null; then blocked_json='"review"'; timed_out=false
  else blocked_json='"unknown"'; timed_out=false
  fi
  printf '{"type":"ship_result","ship_id":"%s","repo":"%s","branch":"%s","exit_code":%d,"timed_out":%s,"blocked_gate":%s,"duration_s":%d,"ts":"%s"}\n' \
    "$DEVKIT_SHIP_ID" "$repo_name" "$br" "$rc" "$timed_out" "$blocked_json" \
    "$(( $(date +%s) - dur_start ))" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    >> "$DEVKIT_GATE_EVENTS" 2>/dev/null || true

  if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then
    # Attribute the kill: the last stage banner in the log names the phase that was mid-flight; if the
    # reviewer gate was running, `progress.mjs unfinished` reads the {running,completed} progress JSON
    # guard-review wrote and names the reviewers a kill interrupted — a structured contract, no more
    # parsing stderr prose (which drifted whenever a heartbeat's wording changed on either side).
    # `|| true` on every substitution: this runs under the caller's `set -euo pipefail`, and a missing
    # log / progress file must degrade silently, never abort the banner.
    local last_stage unfinished
    last_stage=$(grep -E '^(🎨|📏|🗂|🔁|🧭|🔍|⚡|✗)|^guard-prefix:|[Gg]ate\.\.\.[[:space:]]*$' "$log" 2>/dev/null | tail -1 || true)
    {
      echo "⏱  ship: gate chain hit the ${secs}s ceiling (exit $rc) DURING: ${last_stage:-unknown stage}"
      unfinished=$(node "$progress_reader" unfinished "$progress" 2>/dev/null || true)
      if [ -n "$unfinished" ]; then
        echo "   Reviewers with no completion heartbeat (unfinished): $unfinished"
      fi
      echo "   This is usually BUDGET, not a hang — completed reviewer verdicts, cleared decisions"
      echo "   judgements and the deterministic prefix are all CACHED."
      echo "   Re-run the same devkit ship command to converge (only unfinished work re-runs)."
      echo "   More room per attempt: export SHIP_COMMIT_TIMEOUT (it must be EXPORTED — inline"
      echo "   env prefixes can be stripped by command-rewriting shell hooks). Full log: $log"
    } >&2
  elif [ "$rc" -eq 0 ]; then
    # Honest banner: a zero-exit commit is NOT proof the gates ran. In overlay mode the chain can
    # silently no-op (see the core.hooksPath forcing above); if that ever happens the log holds no
    # gate output and reporting "✓ gates ran" would be a lie. Gate enforcement on the overlay hook
    # FILE emitting the sentinel — `devkit update` re-pins the package but does NOT regenerate the
    # git-ignored on-disk hook, so a consumer on a new ship.sh + an old sentinel-less hook still
    # runs its gates correctly; holding it to a sentinel it can't emit would falsely abort a fully
    # gated ship. Only sentinel-emitting hooks are held to fail-closed enforcement.
    if [ -x "$root/.devkit/hooks/pre-commit" ] \
       && grep -q 'devkit-gates: chain start' "$root/.devkit/hooks/pre-commit" \
       && ! grep -q 'devkit-gates: chain start' "$log"; then
      # The commit already succeeded (rc=0) but the chain produced no sentinel → undo it so the
      # caller's cleanup reclaims the branch (else tip≠BASE keeps it, blocking a retry). HEAD~1==BASE
      # (branch created at BASE, exactly one commit); the worktree is discarded next, so --soft suffices.
      git -C "$wt" reset --soft HEAD~1 2>/dev/null || true
      {
        echo "⚠️  ship: NO gate output captured — overlay hook chain appears to have no-op'd"
        echo "    (expected .devkit/hooks/pre-commit to run). Ship aborted; nothing pushed. Log: $log"
      } >&2
      return 1
    fi
    {
      echo "✓ pre-commit gates ran in the ship worktree — full output: $log"
      echo "  Review it for any SKIP / ⚠️ lines (e.g. coverage is NOT gated in the ship worktree)."
    } >&2
  else
    # rc non-zero, not a hang (124/137): a gate or hook rejected the commit — its output is in $log
    # above. Surface ONE otherwise-cryptic failure: a repo path with a SPACE + a git hook (usually a
    # consumer commit-msg like `commitlint --edit $1`) that forwards the message-file path UNQUOTED.
    # git hands a LINKED-worktree hook the ABSOLUTE $GIT_DIR/COMMIT_EDITMSG path, so the space
    # word-splits inside that hook and its arg parser dumps "Unknown argument: <fragment>". Gate on BOTH
    # the space AND COMMIT_EDITMSG appearing in the captured log so a NORMAL gate rejection under a
    # spaced path (this repo self-dogfoods at one) does NOT misfire. The split is in that hook, not
    # devkit (every ship path is quoted) — we can only point at it.
    case "$root" in
      *" "*)
        if grep -q 'COMMIT_EDITMSG' "$log" 2>/dev/null; then
          {
            echo "ℹ️  ship: a git hook mishandled the commit-message file path, and your repo path has a space:"
            echo "   \"$root\"."
            echo "   git gives a worktree commit the ABSOLUTE COMMIT_EDITMSG path, so a hook that forwards it"
            echo "   UNQUOTED (e.g. commitlint --edit \$1) word-splits on the space and its parser rejects the"
            echo "   fragment. Fix: quote \"\$1\" in that commit-msg hook, or use a space-free repo path."
          } >&2
        fi ;;
    esac
  fi
  return "$rc"
}
