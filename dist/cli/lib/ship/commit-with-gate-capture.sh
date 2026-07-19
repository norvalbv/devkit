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
  . "$(dirname "${BASH_SOURCE[0]}")/run-gates-with-capture.sh"

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

  # Minimal JSON string-escaper for the shell-built telemetry lines below (the node gates already use
  # JSON.stringify): a repo/branch/path containing `"` or `\` must not produce a line the collector's
  # json.loads drops. These fields can't contain control chars, so escaping the two metacharacters is enough.
  json_escape() { local s=${1//\\/\\\\}; printf '%s' "${s//\"/\\\"}"; }
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
  printf '{"type":"ship_attempt","ship_id":"%s","repo":"%s","branch":"%s","mode":"%s","log_path":"%s","ts":"%s"}\n' \
    "$(json_escape "$DEVKIT_SHIP_ID")" "$(json_escape "$repo_name")" "$(json_escape "$br")" \
    "$(json_escape "${DEVKIT_SHIP_MODE:-ship}")" "$(json_escape "$ship_log")" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    >> "$DEVKIT_GATE_EVENTS" 2>/dev/null || true

  local rc=0
  DEVKIT_GATE_ARCHIVE_LOG="$ship_log" run_gates_with_capture "$wt" "$root" ship "$log" "$progress" -- \
    git -C "$wt" ${hookcfg[@]+"${hookcfg[@]}"} commit -m "$title" -m "$body" || rc=$?

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

  # Ship result telemetry — the outcome + a coarse blocked_gate tag derived from the captured log
  # (the per-gate/per-reviewer events carry the precise cause). Chain order is deterministic →
  # decisions → review, and each hook step is `|| exit`, so exactly one gate blocks; grep in that
  # order attributes it. qavis is advisory (never blocks a ship) so it is not a blocked_gate value.
  local blocked_json timed_out
  if [ "$rc" -eq 0 ]; then blocked_json=null; timed_out=false
  elif [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then blocked_json='"timeout"'; timed_out=true
  # NOT a blocked gate: every gate PASSED and `git commit` then died on its finalize ref-update
  # because something moved the ship worktree's HEAD mid-commit. Must be tested BEFORE the gate
  # greps below — a fail-OPEN gate line (`guard-review: … INCONCLUSIVE`, exit 2, chain continues)
  # can sit in the same log, and the review arm would otherwise claim a failure it did not cause.
  elif [ "$head_clobbered" -eq 1 ]; then blocked_json='"worktree_head_clobbered"'; timed_out=false
  elif grep -q '✗ deterministic gates failed' "$log" 2>/dev/null; then blocked_json='"deterministic"'; timed_out=false
  elif grep -q 'decision smells:' "$log" 2>/dev/null; then blocked_json='"decisions"'; timed_out=false
  elif grep -qE 'guard-review: .* (FAILED|INCONCLUSIVE)' "$log" 2>/dev/null; then blocked_json='"review"'; timed_out=false
  else blocked_json='"unknown"'; timed_out=false
  fi
  printf '{"type":"ship_result","ship_id":"%s","repo":"%s","branch":"%s","exit_code":%d,"timed_out":%s,"blocked_gate":%s,"duration_s":%d,"log_path":"%s","ts":"%s"}\n' \
    "$(json_escape "$DEVKIT_SHIP_ID")" "$(json_escape "$repo_name")" "$(json_escape "$br")" "$rc" "$timed_out" "$blocked_json" \
    "$(( $(date +%s) - dur_start ))" "$(json_escape "$ship_log")" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    >> "$DEVKIT_GATE_EVENTS" 2>/dev/null || true

  if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then
    : # run_gates_with_capture already emitted the attributed timeout + retry guidance
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
