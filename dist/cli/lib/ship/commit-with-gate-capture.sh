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
# Mechanics: the commit runs under run_gates_with_capture, which folds the gate output (which is on
# stderr) into one stream, captures it to the log, and sends its copy to STDERR (never stdout — the PR
# URL must stay the caller's last stdout line). The commit's real exit code survives the capture; the
# non-zero return then lets the caller's `set -e` abort + its cleanup trap drop the empty branch
# (unchanged failure semantics, plus visibility).
#
# R2 (sc-1002): bound the commit so a HUNG gate can't wedge a shipping AGENT forever. A pre-commit gate
# that never returns (a wedged `claude -p` judge / `bunx` toolchain) — or any child it backgrounds that
# inherits git's stdout — would otherwise keep `git commit` AND the capture pipe blocked, with no human
# to Ctrl-C. The gate therefore runs under a supervisor that owns it as a process GROUP and kills the
# GROUP on expiry, reaping the hook AND its grandchildren so every copy of the pipe write-end closes,
# the reader unblocks, and the run returns 124.
#
# THE INVARIANT, restated for whatever replaces the mechanism: only ever signal the GROUP. Anything
# that signals the leader alone — `timeout --foreground`, `kill $git_pid` — leaves a backgrounded
# pipe-holder alive, the reader blocks forever, and the bound buys nothing. The supervisor goes one
# further and adopts processes that escaped into a group of their own, via an ownership token.
#
# R3 (sc-1199): expiry is not the only way a gate outlives its usefulness. A reviewer that REJECTS
# exits in seconds, so the ceiling never fires — and any child it leaked still holds the pipe, which
# used to hang the ship indefinitely with its ephemeral worktree checked out. So: a non-zero hook
# result does NOT end the gate's lifetime. Once the leader exits, a lingering group gets a short grace
# and is then reaped down the same group-kill path. The leader's status survives the reap — a rejection
# must always read as that reviewer's rejection, never as a timeout.
#
# Portability: hang protection is unconditional and needs no coreutils — node plus /bin/ps, both of
# which ship already requires. Exit codes the caller can now see: 124 (the ceiling, or a leaked group
# that outlived a CLEAN leader), 129/130/131/143 (a signal forwarded to the gate), 137 (the supervisor
# itself was SIGKILLed — NOT a ceiling).
#
# Usage:  commit_with_gate_capture <worktree> <root> <branch> <title> <body>
commit_with_gate_capture() {
  local wt="$1" root="$2" br="$3" title="$4" body="$5"
  local log="$root/.devkit/last-ship-gates-${br//\//-}.log"
  local progress="$root/.devkit/review-progress-${br//\//-}.json"
  . "$(dirname "${BASH_SOURCE[0]}")/run-gates-with-capture.sh"
  . "$(dirname "${BASH_SOURCE[0]}")/telemetry.sh"
  . "$(dirname "${BASH_SOURCE[0]}")/prepare-gate-worktree.sh"
  # Both callers already source this, but the object probe below is this function's own evidence —
  # don't inherit it by luck of call order.
  . "$(dirname "${BASH_SOURCE[0]}")/assert-staged-set.sh"

  # Gate telemetry (best-effort, ship-scoped). A shared append-only JSONL sink + one ship_id per
  # attempt, inherited by every in-chain gate the SAME way DEVKIT_REVIEW_PROGRESS is — so the
  # deterministic/decisions/review events (emitted from the node gates via gate-events.mts) and the
  # ship_attempt/ship_result lines below all carry the same ship_id and correlate. Off-ship the env
  # is unset and nothing is emitted. A downstream reader (the usage tracker's collector) tail-ingests
  # it; every write is `>> … || true` so telemetry can never fail the ship.
  export DEVKIT_GATE_EVENTS="${DEVKIT_GATE_EVENTS:-$HOME/.devkit/telemetry/gate-events.jsonl}"
  export DEVKIT_SHIP_ID="${DEVKIT_SHIP_ID:-$(uuidgen 2>/dev/null || echo "${br//\//-}-$$-$(date +%s)")}"
  mkdir -p "$(dirname "$DEVKIT_GATE_EVENTS")" 2>/dev/null || true
  . "$(dirname "${BASH_SOURCE[0]}")/repo-identity.sh"
  local repo_name; repo_name="$(devkit_repo_identity "$root")"
  # Also EXPORTED so the in-process gate envelope (judge/run-context.mts) can stamp repo/branch on
  # every event a ship emits. Without them a ship's gate events are repo-blind, and a shared
  # telemetry sink interleaves two repos' runs with no way to separate them (sc-1239).
  export DEVKIT_SHIP_REPO="$repo_name" DEVKIT_SHIP_BRANCH="$br"

  # Per-SHIP gate log the collector reads for the drill-down + fail-classification. The per-branch
  # $log (in the repo) is OVERWRITTEN by the next ship, so it can't back a historical drill-down; a
  # durable per-ship copy lives beside the sink and its path (log_path) rides both telemetry lines so
  # the reader can find it (an in-flight ship's row serves it once the file exists).
  local ship_logs_dir; ship_logs_dir="$(dirname "$DEVKIT_GATE_EVENTS")/logs"
  # Sanitise the id for the FILENAME ONLY — an env-supplied DEVKIT_SHIP_ID must never escape the dir
  # via `/` or `..` (a path traversal into `tee`). The JSON below keeps the ORIGINAL id for correlation.
  local ship_id_safe="${DEVKIT_SHIP_ID//[^A-Za-z0-9._-]/-}"
  ship_id_safe="${ship_id_safe:0:64}"          # bound the filename length (a uuid is 36; caps abuse)
  [ -n "$ship_id_safe" ] || ship_id_safe="ship"
  local ship_log="$ship_logs_dir/${ship_id_safe}.log"
  mkdir -p "$ship_logs_dir" 2>/dev/null || true

  # Start the attempt before hook resolution so a fail-closed setup error still has a terminal
  # ship_result row instead of disappearing from telemetry.
  local dur_start; dur_start=$(date +%s)
  printf '{"type":"ship_attempt","ship_id":"%s","repo":"%s","branch":"%s","devkit_version":"%s","mode":"%s","log_path":"%s","ts":"%s"}\n' \
    "$(devkit_json_escape "$DEVKIT_SHIP_ID")" "$(devkit_json_escape "$repo_name")" "$(devkit_json_escape "$br")" \
    "$(devkit_json_escape "$DEVKIT_TELEMETRY_VERSION")" \
    "$(devkit_json_escape "${DEVKIT_SHIP_MODE:-ship}")" "$(devkit_json_escape "$ship_log")" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    >> "$DEVKIT_GATE_EVENTS" 2>/dev/null || true

  # $log is a REUSED per-branch path ("last-ship-gates-*"), so this attempt starts from empty even
  # when hook setup fails before run_gates_with_capture gets a chance to own the log.
  mkdir -p "$(dirname "$log")" 2>/dev/null || true
  : > "$log" 2>/dev/null || true
  local rc=0 hook_setup_failed=0 hook_setup_error="" ship_hook_dir=""

  # Resolve the hook ship intends to run, then put ship-owned wrappers in front of the real hook
  # directory. The pre-commit wrapper emits an attempt-specific proof marker; every wrapper directly
  # execs its real counterpart with the original args/stdin. Direct execution is load-bearing for
  # Husky's generated shims: they locate `.husky/<hook>` from their own $0, so symlinking those shims
  # into the private directory would silently no-op sibling hooks such as commit-msg. This closes two
  # fail-open paths at once:
  #   - core.hooksPath is unset in a clean clone, even though prepare-gate-worktree projected the
  #     package-mode .husky/_ runner into the disposable worktree; and
  #   - git commit returns zero without proving that any hook actually ran.
  # Hook resolution is shared with prepare_gate_worktree so projection and execution cannot drift.
  local real_hooks_dir real_pre_commit
  real_pre_commit=$(gate_worktree_pre_commit "$wt" "$root")
  real_hooks_dir=${real_pre_commit%/pre-commit}
  if [ -z "$real_hooks_dir" ] || [ ! -x "$real_pre_commit" ]; then
    hook_setup_error="ship: no executable pre-commit hook for the ship worktree (resolved: ${real_pre_commit:-none}) — gates must not fail open"
    hook_setup_failed=1
    rc=1
  fi

  local ship_hook_rel="" ship_hook_marker source_hook source_name
  ship_hook_marker="devkit-ship-hook-start:$ship_id_safe"
  if [ "$hook_setup_failed" -eq 0 ]; then
    ship_hook_dir=$(mktemp -d "$wt/.devkit-ship-hooks.XXXXXX") || {
      hook_setup_error="ship: could not create the private hook wrapper — gates must not fail open"
      hook_setup_failed=1
      rc=1
    }
  fi
  if [ "$hook_setup_failed" -eq 0 ]; then
    ship_hook_rel=${ship_hook_dir#"$wt/"}
    for source_hook in "$real_hooks_dir"/*; do
      [ -x "$source_hook" ] || continue
      source_name=${source_hook##*/}
      if ! (umask 077; cat > "$ship_hook_dir/$source_name" <<'SHIP_HOOK_WRAPPER'
#!/bin/sh
hook_name=${0##*/}
if [ "$hook_name" = pre-commit ]; then
  printf '%s\n' "$DEVKIT_SHIP_HOOK_MARKER" >&2
fi
exec "$DEVKIT_SHIP_REAL_HOOKS_DIR/$hook_name" "$@"
SHIP_HOOK_WRAPPER
        chmod 700 "$ship_hook_dir/$source_name"); then
        hook_setup_error="ship: could not project the real hook chain into the private wrapper — gates must not fail open"
        hook_setup_failed=1
        rc=1
        break
      fi
    done
  fi
  if [ "$hook_setup_failed" -eq 0 ] && [ ! -x "$ship_hook_dir/pre-commit" ]; then
    hook_setup_error="ship: private hook projection omitted pre-commit — gates must not fail open"
    hook_setup_failed=1
    rc=1
  fi
  if [ "$hook_setup_failed" -eq 0 ]; then
    export DEVKIT_SHIP_HOOK_MARKER="$ship_hook_marker"
    export DEVKIT_SHIP_REAL_HOOKS_DIR="$real_hooks_dir"
  fi

  # gc.auto=0: this commit is the one ship-owned git call that can trip auto-gc, and it fires at the
  # END of a multi-minute gate chain in a repo that may hold dozens of worktrees. Auto-gc cannot
  # delete a minutes-old object under git's default pruneExpire, so this is hygiene rather than the
  # sc-1420 fix — it just keeps ship from starting repository maintenance at its most fragile moment.
  # APPEND the overlay flag below; assigning here would confine gc.auto=0 to overlay installs only.
  local hookcfg=(-c gc.auto=0 -c core.hooksPath="$ship_hook_rel")

  # sc-1442: the composed message exists BEFORE `git commit` runs — hand it to the pre-commit
  # reviewers as ADVISORY intent via a temp file (NEVER .git/COMMIT_EDITMSG: at pre-commit that
  # holds the PREVIOUS commit's message). Best-effort throughout: any failure degrades to the
  # gate's placeholder, never a blocked ship. The gate keeps the message OUT of every reviewer
  # cache key, so a reship retry with an amended message still reuses cached PASSes.
  local msgf=""
  msgf=$(mktemp "${TMPDIR:-/tmp}/devkit-ship-msg.XXXXXX" 2>/dev/null) || msgf=""
  if [ -n "$msgf" ]; then
    if printf '%s\n\n%s\n' "$title" "$body" > "$msgf" 2>/dev/null; then
      export DEVKIT_COMMIT_MSG_FILE="$msgf"
    else
      rm -f -- "$msgf" 2>/dev/null || true
      msgf=""
    fi
  fi

  if [ "$hook_setup_failed" -eq 1 ]; then
    printf '%s\n' "$hook_setup_error" | tee -a "$log" "$ship_log" >&2
  else
    # The comment firewall can find a remediation ID only in this isolated worktree. Hand its exact,
    # caller-root capture path to the gate so the printed justify command remains usable after the
    # failed empty worktree is reclaimed. The value is evidence location, never an approval token.
    unset DEVKIT_SHIP_GATE_LOG
    DEVKIT_SHIP_GATE_LOG="$log" DEVKIT_GATE_ARCHIVE_LOG="$ship_log" \
      run_gates_with_capture "$wt" "$root" ship "$log" "$progress" -- \
      git -C "$wt" ${hookcfg[@]+"${hookcfg[@]}"} commit -m "$title" -m "$body" || rc=$?
  fi

  local ship_hook_proved=0
  grep -qF "$ship_hook_marker" "$log" 2>/dev/null && ship_hook_proved=1
  [ -z "$ship_hook_dir" ] || rm -rf -- "$ship_hook_dir"
  unset DEVKIT_SHIP_HOOK_MARKER DEVKIT_SHIP_REAL_HOOKS_DIR

  # sc-1442 cleanup — sits ABOVE both return sites, so every exit path is already clean. A Ctrl-C
  # mid-gate can leak the mode-600 temp file; accepted — its content is the message the author is
  # about to publish anyway.
  if [ -n "$msgf" ]; then rm -f -- "$msgf" 2>/dev/null || true; fi
  unset DEVKIT_COMMIT_MSG_FILE

  # A zero-exit commit is provisional until ship proves its wrapper ran and, for sentinel-aware
  # overlays, that the real gate chain emitted output. Rewind before telemetry so the terminal row
  # records the actual failed ship rather than a success that callers will never publish.
  local ship_abort_reported=0 blocked_override=""
  if [ "$rc" -eq 0 ] && [ "$ship_hook_proved" -ne 1 ]; then
    git -C "$wt" reset --soft HEAD~1 2>/dev/null || true
    {
      echo "⚠️  ship: NO pre-commit execution proof was captured — ship aborted; nothing pushed"
      echo "    Expected marker: $ship_hook_marker. Full log: $log"
    } >&2
    rc=1
    blocked_override='"hook_proof"'
    ship_abort_reported=1
  elif [ "$rc" -eq 0 ] && [ -x "$root/.devkit/hooks/pre-commit" ] \
     && grep -q 'devkit-gates: chain start' "$root/.devkit/hooks/pre-commit" \
     && ! grep -q 'devkit-gates: chain start' "$log"; then
    git -C "$wt" reset --soft HEAD~1 2>/dev/null || true
    {
      echo "⚠️  ship: NO gate output captured — overlay hook chain appears to have no-op'd"
      echo "    (expected .devkit/hooks/pre-commit to run). Ship aborted; nothing pushed. Log: $log"
    } >&2
    rc=1
    blocked_override='"overlay_no_output"'
    ship_abort_reported=1
  fi

  # Did OUR outer `git commit` die on its own HEAD finalize, or did a GATE merely PRINT the same git
  # error? The captured log is a COMBINED stream (`2>&1 | tee` above folds hook output in), so the two
  # are textually indistinguishable — and devkit's own suite emits this string deliberately, so a gate
  # running it would forge the phrase. Decide on EVIDENCE instead: the ship worktree's HEAD must
  # actually have moved off the commit we cut it from. A gate that prints the error and exits non-zero
  # leaves HEAD at the base, so it stays attributed to that gate. No commit exists on the failure path,
  # so HEAD==base is the only honest "nothing moved" state. DEVKIT_SHIP_BASE_SHA is exported by BOTH
  # callers (ship-branch.sh / reship.sh); with it unset we can prove nothing, so we deliberately fall
  # through to the gate greps rather than claim every gate passed.
  local head_now="" head_clobbered=0
  if [ "$rc" -ne 0 ] && [ -n "${DEVKIT_SHIP_BASE_SHA:-}" ] \
     && grep -qF "cannot lock ref 'HEAD'" "$log" 2>/dev/null; then
    head_now=$(git -C "$wt" rev-parse HEAD 2>/dev/null || true)
    if [ -n "$head_now" ] && [ "$head_now" != "$DEVKIT_SHIP_BASE_SHA" ]; then head_clobbered=1; fi
  fi

  # sc-1420, same evidence-not-grep discipline as the block above. A gate dies on `fatal: unable to
  # read <oid>` when it cannot read a staged object, but the log alone cannot tell us WHY: the object
  # may genuinely be gone from the shared database, or ship and the gate may simply be looking at
  # DIFFERENT databases (ship inherits the caller's environment; gates are spawned through
  # __dk_no_git_env, which strips GIT_OBJECT_DIRECTORY / GIT_ALTERNATE_OBJECT_DIRECTORIES). So ask the
  # object database, from ship's own process, instead of grepping. Objects present here while the gate
  # reported them missing is the signature of the second cause, and the banner records both views.
  local staged_missing=0 staged_missing_list=""
  if [ "$rc" -ne 0 ]; then
    staged_missing_list=$(_ship_staged_missing_objects "$wt" 2>/dev/null || true)
    [ -n "$staged_missing_list" ] && staged_missing=1
  fi

  # Ship result telemetry — the outcome + a coarse blocked_gate tag derived from the captured log
  # (the per-gate/per-reviewer events carry the precise cause). Chain order is deterministic →
  # decisions → review, and each hook step is `|| exit`, so exactly one gate blocks; grep in that
  # order attributes it. qavis is advisory (never blocks a ship) so it is not a blocked_gate value.
  local blocked_json timed_out
  if [ -n "$blocked_override" ]; then blocked_json=$blocked_override; timed_out=false
  elif [ "$hook_setup_failed" -eq 1 ]; then blocked_json='"hook_setup"'; timed_out=false
  elif [ "$rc" -eq 0 ]; then blocked_json=null; timed_out=false
  elif [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then blocked_json='"timeout"'; timed_out=true
  # NOT a blocked gate: every gate PASSED and `git commit` then died on its finalize ref-update
  # because something moved the ship worktree's HEAD mid-commit. Must be tested BEFORE the gate
  # greps below — a fail-OPEN gate line (`guard-review: … INCONCLUSIVE`, exit 2, chain continues)
  # can sit in the same log, and the review arm would otherwise claim a failure it did not cause.
  elif [ "$head_clobbered" -eq 1 ]; then blocked_json='"worktree_head_clobbered"'; timed_out=false
  # NOT a blocked gate either: the gate chain could not read the staged content it was handed. Tested
  # before the greps below for the same reason — whichever gate happened to read the staged diff first
  # is the one that dies, so a grep would blame it for a failure it did not cause.
  elif [ "$staged_missing" -eq 1 ]; then blocked_json='"staged_objects_missing"'; timed_out=false
  elif grep -q '✗ deterministic gates failed' "$log" 2>/dev/null; then blocked_json='"deterministic"'; timed_out=false
  elif grep -q 'decision smells:' "$log" 2>/dev/null; then blocked_json='"decisions"'; timed_out=false
  elif grep -qE 'guard-review: .* (FAILED|INCONCLUSIVE)' "$log" 2>/dev/null; then blocked_json='"review"'; timed_out=false
  else blocked_json='"unknown"'; timed_out=false
  fi
  printf '{"type":"ship_result","ship_id":"%s","repo":"%s","branch":"%s","devkit_version":"%s","exit_code":%d,"timed_out":%s,"blocked_gate":%s,"duration_s":%d,"log_path":"%s","ts":"%s"}\n' \
    "$(devkit_json_escape "$DEVKIT_SHIP_ID")" "$(devkit_json_escape "$repo_name")" "$(devkit_json_escape "$br")" \
    "$(devkit_json_escape "$DEVKIT_TELEMETRY_VERSION")" "$rc" "$timed_out" "$blocked_json" \
    "$(( $(date +%s) - dur_start ))" "$(devkit_json_escape "$ship_log")" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    >> "$DEVKIT_GATE_EVENTS" 2>/dev/null || true

  if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then
    : # run_gates_with_capture already emitted the attributed timeout + retry guidance
  elif [ "$ship_abort_reported" -eq 1 ]; then
    : # Proof/sentinel failure was already reported before terminal telemetry was emitted.
  elif [ "$rc" -eq 0 ]; then
    {
      echo "✓ pre-commit gates ran in the ship worktree — full output: $log"
      # Was: "(e.g. coverage is NOT gated in the ship worktree)" — false since prepare-gate-worktree.sh
      # started linking coverage/ in, and it taught agents the exact opposite of the gate they were
      # fighting. Point at the real thing a reader must not miss: a gate that PASSED by bypass.
      echo "  Review it for any SKIP / BYPASSED / ⚠️ lines — a bypassed gate verified nothing."
    } >&2
  elif [ "$head_clobbered" -eq 1 ]; then
    # Reuses the SAME evidence-checked verdict as the telemetry above — never a second independent
    # grep, which could drift from it and let this banner claim "every gate PASSED" for a run the
    # telemetry attributed to a gate.
    # Every gate passed and the commit still died — another process moved this worktree's HEAD while
    # the gate chain was running (it runs for MINUTES, so the window is wide). Without this banner the
    # failure reads as a push problem: the git fatal is the log's last line, long after the PASS lines.
    # Known cause: fallow < 3.4.2 registered its audit base-snapshot as a git worktree and its cleanup
    # was not scoped to the entry it owned. devkit pins fallow >= 3.6.0 (see install-fallow.mts); a
    # consumer on an older global fallow still hits it. If this ever fires on a current fallow, the
    # upgrade path is re-pointing HEAD at the ship base and retrying the commit here — cheap, because
    # every earned verdict is already cached.
    {
      echo "🔀 ship: the ship worktree's HEAD was moved by ANOTHER process mid-commit, so git refused"
      echo "   to finalise (\"cannot lock ref 'HEAD'\"). Every gate PASSED — this is not a gate block,"
      echo "   and NOTHING was pushed. Re-running the same devkit ship command is safe and fast"
      echo "   (cleared judgements + reviewer verdicts are cached)."
      echo "   Most likely an outdated fallow: its audit base-snapshot cleanup could reach outside its"
      echo "   own worktree before 3.4.2. Check with: fallow --version  (devkit pins >= 3.6.0)."
      echo "   Full log: $log"
    } >&2
  elif [ "$staged_missing" -eq 1 ]; then
    # sc-1420. Reuses the SAME evidence the telemetry above used — never a second grep. The gate that
    # died is whichever one read the staged diff first; blaming it would send the operator to rerun a
    # reviewer that was never the problem.
    {
      echo "🛑 ship: the gate chain could not read the staged content — objects the index references"
      echo "   are missing from the object database. This is NOT a gate rejection, and nothing was"
      echo "   pushed. The gate that reported it is simply the first one that read the staged diff."
      printf '%s\n' "$staged_missing_list" | sed 's/^/     /'
      _ship_report_object_environment "$wt"
      echo "   Full log: $log"
      echo "   Please attach this block to sc-1420 — it is the evidence that names the cause."
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
