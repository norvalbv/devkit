#!/usr/bin/env bash
# Run a trusted checkout's configured pre-commit chain against an authenticated, detached snapshot.
# HEAD in the final worktree deliberately stays at merge-base so unchanged gates see the complete PR
# diff through `git diff --cached`. Nothing from the private worktrees is copied back to the target.
set -euo pipefail
umask 077

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
PACKAGE_ROOT_REQUESTED=${DEVKIT_REVIEW_PACKAGE_ROOT:-}
MANAGED_SIGNAL_ROOT=${DEVKIT_MANAGED_SIGNAL_ROOT:-}
unset DEVKIT_MANAGED_SIGNAL_ROOT
if [ -n "$MANAGED_SIGNAL_ROOT" ] && \
  { [ ! -d "$MANAGED_SIGNAL_ROOT" ] || [ -L "$MANAGED_SIGNAL_ROOT" ]; }; then
  MANAGED_SIGNAL_ROOT=
fi

TARGET=.
BASE_REF=
SEEN_TARGET=0
SEEN_BASE=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --target)
      [ "$SEEN_TARGET" -eq 0 ] && [ "$#" -ge 2 ] && [ -n "$2" ] || {
        echo 'devkit review: --target requires one value and may only be specified once' >&2
        exit 1
      }
      TARGET=$2
      SEEN_TARGET=1
      shift 2
      ;;
    --base)
      [ "$SEEN_BASE" -eq 0 ] && [ "$#" -ge 2 ] && [ -n "$2" ] || {
        echo 'devkit review: --base requires one value and may only be specified once' >&2
        exit 1
      }
      BASE_REF=$2
      SEEN_BASE=1
      shift 2
      ;;
    *)
      printf 'devkit review: unknown argument: %s\n' "$1" >&2
      exit 1
      ;;
  esac
done

# An invoking ship has ALREADY resolved the commit it cut from. Capture it before the scrub below
# unsets it (same read-then-unset shape as MANAGED_SIGNAL_ROOT): it is a topology hint used only to
# pick this run's base, never forwarded to a child, so the scrub's authority guarantee is unchanged.
SHIP_BASE_SHA=${DEVKIT_SHIP_BASE_SHA:-}

# Never inherit another ship/review's authority, private paths, or telemetry destination. The two
# topology hints, SHIP_COMMIT_TIMEOUT and DEVKIT_PREFLIGHT_TIMEOUT are intentional invocation inputs
# and remain untouched. DEVKIT_PREFLIGHT_TIMEOUT deliberately avoids the DEVKIT_REVIEW_ prefix:
# cli/commands/review.mts strips that whole namespace as inherited run context, so a knob named
# DEVKIT_REVIEW_* would be silently deleted before this script ever saw it.
for name in \
  DEVKIT_COMMIT_MSG_FILE \
  DEVKIT_GATE_ARCHIVE_LOG DEVKIT_GATE_EVENTS DEVKIT_REVIEW_ASSET_ROOT \
  DEVKIT_REVIEW_BASELINE_DIR DEVKIT_REVIEW_BRANCH DEVKIT_REVIEW_DATA_ROOT \
  DEVKIT_REVIEW_DEPENDENCY_MANIFEST DEVKIT_REVIEW_DEPENDENCY_TOOL DEVKIT_REVIEW_GUARDS \
  DEVKIT_REVIEW_ID DEVKIT_REVIEW_MERGE_BASE DEVKIT_REVIEW_PACKAGE_ROOT \
  DEVKIT_REVIEW_PROGRESS DEVKIT_REVIEW_PROJECTION_MANIFEST DEVKIT_REVIEW_PROJECTION_TOOL \
  DEVKIT_REVIEW_REPO DEVKIT_REVIEW_SUPERVISOR_OWNER_TOKEN DEVKIT_REVIEW_TEMP_ROOT \
  DEVKIT_REVIEW_RUNTIME_FINGERPRINT \
  DEVKIT_RUN_MODE DEVKIT_SHIP DEVKIT_SHIP_BASE_SHA DEVKIT_SHIP_ID DEVKIT_SHIP_MODE \
  GUARD_AI_STRICT GUARD_DECISIONS_DIR
do
  unset "$name"
done

. "$SCRIPT_DIR/review/worktrees.sh"
. "$SCRIPT_DIR/review/snapshot.sh"
. "$SCRIPT_DIR/review/submodules.sh"
. "$SCRIPT_DIR/review/process/gate-signal-handoff.sh"
. "$SCRIPT_DIR/prepare-gate-worktree.sh"
. "$SCRIPT_DIR/run-gates-with-capture.sh"
_review_worktree_clear_git_env
export GIT_NO_LAZY_FETCH=1 GIT_TERMINAL_PROMPT=0

review_module() {
  local stem=$1 candidate
  for candidate in "$SCRIPT_DIR/review/$stem.mts" "$SCRIPT_DIR/review/$stem.mjs"; do
    if [ -f "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  printf 'devkit review: packaged helper is missing: review/%s.{mts,mjs}\n' "$stem" >&2
  return 1
}

SETUP_MANIFEST_TOOL=$(review_module setup-manifest)
SETUP_RUNTIME_TOOL=$(review_module setup-runtime)
REPOSITORY_STATE_TOOL=$(review_module repository/state)
ASSET_RUNTIME_TOOL=$(review_module asset-runtime)
DEPENDENCY_RUNTIME_TOOL=$(review_module dependency-runtime)
PROJECTION_RUNTIME_TOOL=$(review_module projection/runtime)
CACHE_ROOT_TOOL=$(review_module cache/root)
CACHE_SESSION_TOOL=$(review_module cache/session)
RUN_RESULT_TOOL=$(review_module telemetry/run-result)

[ -n "$PACKAGE_ROOT_REQUESTED" ] && [ -d "$PACKAGE_ROOT_REQUESTED" ] || {
  echo 'devkit review: packaged reviewer root is missing; reinstall or rebuild Devkit.' >&2
  exit 1
}
PACKAGE_ROOT=$(cd -P "$PACKAGE_ROOT_REQUESTED" 2>/dev/null && pwd -P) || {
  echo 'devkit review: packaged reviewer root is not a physical directory.' >&2
  exit 1
}

TARGET_ROOT=$(cd -P "$TARGET" 2>/dev/null && pwd -P) || {
  printf 'devkit review: target is not an available directory: %s\n' "$TARGET" >&2
  exit 1
}
IFS= read -r -d '' GIT_ROOT < <(_review_worktree_repo_root "$TARGET_ROOT") || {
  printf 'devkit review: target is not inside a Git repository: %s\n' "$TARGET_ROOT" >&2
  exit 1
}
case "$TARGET_ROOT" in
  "$GIT_ROOT" | "$GIT_ROOT"/*) ;;
  *) echo 'devkit review: target checkout escapes its Git root.' >&2; exit 1 ;;
esac

git_line_into() {
  local variable=$1 root=$2 value
  shift 2
  IFS= read -r -d '' value < <(
    _review_worktree_git_line git -c core.hooksPath=/dev/null -C "$root" "$@"
  ) || return 1
  printf -v "$variable" '%s' "$value"
}

git_line_into TARGET_HEAD "$GIT_ROOT" rev-parse --verify --end-of-options 'HEAD^{commit}' || {
  echo 'devkit review: target has no committed HEAD; a merge base is required.' >&2
  exit 1
}
if [ -z "$BASE_REF" ]; then
  # A ship has ALREADY resolved the commit it cut from and exported it; prefer that over guessing.
  # The in-chain hook calls `guard-review --gate` with no --base, so without this the reviewers fall
  # through to origin/HEAD — which is only the right base when the integration branch happens to be
  # the default branch. Where it is not (a repo shipping onto a release branch well ahead of main),
  # every reviewer diffs the entire release instead of the commit, and blames that range's
  # deletions on it. Observed: a 3-file modification-only commit failed review for "deleting" two
  # files, out of 211 deletions in the 161 commits between the default and integration branches.
  if [ -n "$SHIP_BASE_SHA" ] && git -c core.hooksPath=/dev/null -C "$GIT_ROOT" \
    rev-parse --verify --quiet --end-of-options "${SHIP_BASE_SHA}^{commit}" >/dev/null 2>&1; then
    BASE_REF=$SHIP_BASE_SHA
  elif git -c core.hooksPath=/dev/null -C "$GIT_ROOT" rev-parse --verify --quiet \
    --end-of-options 'origin/HEAD^{commit}' >/dev/null 2>&1; then
    BASE_REF=origin/HEAD
  elif git -c core.hooksPath=/dev/null -C "$GIT_ROOT" rev-parse --verify --quiet \
    --end-of-options 'refs/heads/main^{commit}' >/dev/null 2>&1; then
    BASE_REF=main
  elif git -c core.hooksPath=/dev/null -C "$GIT_ROOT" rev-parse --verify --quiet \
    --end-of-options 'refs/heads/master^{commit}' >/dev/null 2>&1; then
    BASE_REF=master
  else
    echo 'devkit review: could not infer a local base (tried origin/HEAD, main, master); pass --base <ref>.' >&2
    exit 1
  fi
fi
git_line_into BASE_COMMIT "$GIT_ROOT" rev-parse --verify --end-of-options "$BASE_REF^{commit}" || {
  printf "devkit review: could not resolve base %q locally (review never fetches).\n" "$BASE_REF" >&2
  exit 1
}
git_line_into MERGE_BASE "$GIT_ROOT" merge-base "$BASE_COMMIT" "$TARGET_HEAD" || {
  printf "devkit review: base %q and target HEAD have no merge base.\n" "$BASE_REF" >&2
  exit 1
}
# Test seam: print the resolved base, then exit before any side effect (no snapshot, no state root,
# no judges). Mirrors ship-branch.sh's SHIP_RESOLVE_ONLY so base inference is testable hermetically.
# Never set in normal use.
[ -n "${DEVKIT_REVIEW_RESOLVE_ONLY:-}" ] && {
  printf 'BASE_REF=%s\nMERGE_BASE=%s\n' "$BASE_REF" "$MERGE_BASE"
  exit 0
}

git_line_into BASE_TREE "$GIT_ROOT" rev-parse --verify --end-of-options "$MERGE_BASE^{tree}" || exit 1

BRANCH=
git_line_into BRANCH "$GIT_ROOT" symbolic-ref --quiet --short HEAD 2>/dev/null || true
if [ -z "$BRANCH" ]; then
  git_line_into SHORT_HEAD "$GIT_ROOT" rev-parse --short HEAD || exit 1
  BRANCH=detached-$SHORT_HEAD
fi
REPO_NAME=${GIT_ROOT##*/}
TOKEN=$(printf '%s' "$BRANCH" | tr -c 'A-Za-z0-9._-' '-')
TOKEN=${TOKEN:0:64}
RUN_ID="${TOKEN}-$(date -u +%Y%m%dT%H%M%SZ)-$$-${RANDOM}"
export DEVKIT_REVIEW_ID="review-$RUN_ID"
export DEVKIT_REVIEW_REPO="$REPO_NAME"
export DEVKIT_REVIEW_BRANCH="$BRANCH"

IFS= read -r -d '' TEMP_BASE < <(_review_snapshot_temp_base "$GIT_ROOT") || exit 1
STATE_ROOT=
STATE_ROOT_CLEANUP_ARMED=0
cleanup_before_runtime_ready() {
  local status=$?
  # Teardown is the last authority boundary. Do not let a second signal interrupt removal once the
  # EXIT trap is disarmed; the managed CLI retains the requested signal status.
  trap '' HUP INT QUIT TERM
  trap - EXIT
  [ "$STATE_ROOT_CLEANUP_ARMED" -eq 0 ] || rm -rf -- "$STATE_ROOT" 2>/dev/null || true
  exit "$status"
}
trap cleanup_before_runtime_ready EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 131' QUIT
trap 'exit 143' TERM
# Assign the unique path before creating it. A signal cannot then strand a directory between an
# allocator creating it and command substitution returning the unknown name to this parent shell.
STATE_ROOT="$TEMP_BASE/devkit-review-$RUN_ID"
[ ! -e "$STATE_ROOT" ] && [ ! -L "$STATE_ROOT" ] || {
  echo 'devkit review: private runtime path already exists; retry.' >&2
  exit 1
}
STATE_ROOT_CLEANUP_ARMED=1
mkdir -- "$STATE_ROOT" || {
  STATE_ROOT_CLEANUP_ARMED=0
  echo 'devkit review: could not create a private runtime directory.' >&2
  exit 1
}
chmod 700 "$STATE_ROOT"
export DEVKIT_REVIEW_TEMP_ROOT="$STATE_ROOT"

FINAL_WT="$STATE_ROOT/final"
BASE_WT="$STATE_ROOT/base"
SETUP_MANIFEST="$STATE_ROOT/setup.json"
SETUP_RUNTIME_MANIFEST="$STATE_ROOT/setup-runtime.json"
REPOSITORY_MANIFEST="$STATE_ROOT/repository.json"
FINAL_DEPENDENCY_MANIFEST="$STATE_ROOT/final-dependencies.json"
BASE_DEPENDENCY_MANIFEST="$STATE_ROOT/base-dependencies.json"
FINAL_PROJECTION_MANIFEST="$STATE_ROOT/final-projections.json"
BASE_PROJECTION_MANIFEST="$STATE_ROOT/base-projections.json"
FINAL_SUBMODULE_MANIFEST="$STATE_ROOT/final-submodules.bin"
BASE_SUBMODULE_MANIFEST="$STATE_ROOT/base-submodules.bin"
FINAL_UNTRACKED_MANIFEST="$STATE_ROOT/final-untracked.bin"
BASE_UNTRACKED_MANIFEST="$STATE_ROOT/base-untracked.bin"
FINAL_EXCLUSIONS="$STATE_ROOT/final-exclusions.bin"
BASE_EXCLUSIONS="$STATE_ROOT/base-exclusions.bin"
ASSET_RUNTIME="$STATE_ROOT/assets"
BASELINE_RUNTIME="$STATE_ROOT/baselines"
PRIVATE_DATA_ROOT="$STATE_ROOT/cache-data"
SETUP_FIELDS_FILE="$STATE_ROOT/setup-fields.bin"
CACHE_FIELDS_FILE="$STATE_ROOT/cache-fields.bin"
PROGRESS="$STATE_ROOT/progress.json"
LOG="$TARGET_ROOT/.devkit/review-runs/$RUN_ID.log"
STARTED_AT=$(date +%s)
PREFLIGHT_STAGE_FILE="$STATE_ROOT/preflight-stage"
PREFLIGHT_TIMEOUT_SENTINEL="$STATE_ROOT/preflight-timeout"
PREFLIGHT_WATCHDOG_PID=
PREFLIGHT_TIMED_OUT=0

# Ceiling for the setup/teardown hang guard below. DERIVES from SHIP_COMMIT_TIMEOUT so operators
# keep ONE knob — raise the reviewer budget and the setup guard follows. DEVKIT_PREFLIGHT_TIMEOUT
# exists so the two ceilings can be driven INDEPENDENTLY: any value low enough to exercise this
# guard would otherwise stop the run long before it reached the gate chain, leaving the two
# mutually untestable. Validated with gate-supervisor.mts's semantics (finite, > 0, within range)
# and rejected LOUDLY rather than defaulted: a silent fallback would diverge from the chain, which
# refuses to start on a bad value, and `0` / `.` / `1.2.3` all make /bin/sleep return or fail
# immediately — a spurious timeout on every single run.
PREFLIGHT_TIMEOUT=${DEVKIT_PREFLIGHT_TIMEOUT:-${SHIP_COMMIT_TIMEOUT:-3600}}
preflight_timeout_invalid() {
  printf 'devkit review: invalid timeout %s (expected a positive number of seconds).\n' \
    "$PREFLIGHT_TIMEOUT" >&2
  exit 1
}
case $PREFLIGHT_TIMEOUT in
  '' | . | *[!0-9.]* | *.*.*) preflight_timeout_invalid ;;
esac
# All-zero digits ("0", "0.0", ".0") is <= 0 and would fire the guard instantly.
[ -n "${PREFLIGHT_TIMEOUT//[0.]/}" ] || preflight_timeout_invalid
# Whole seconds, rounded UP, so a fractional ceiling never truncates to 0. The guard polls bash's
# SECONDS builtin, which counts whole seconds — no `date` subprocess per tick.
PREFLIGHT_TIMEOUT_SECS=${PREFLIGHT_TIMEOUT%%.*}
[ -n "$PREFLIGHT_TIMEOUT_SECS" ] || PREFLIGHT_TIMEOUT_SECS=0
PREFLIGHT_TIMEOUT_SECS=$((10#0$PREFLIGHT_TIMEOUT_SECS))
case $PREFLIGHT_TIMEOUT in
  *.*[1-9]*) PREFLIGHT_TIMEOUT_SECS=$((PREFLIGHT_TIMEOUT_SECS + 1)) ;;
esac
# gate-supervisor.mts caps at MAX_TIMEOUT_MS (2147483647ms); mirror it so one knob cannot be
# accepted here and rejected there.
[ "$PREFLIGHT_TIMEOUT_SECS" -ge 1 ] && [ "$PREFLIGHT_TIMEOUT_SECS" -le 2147483 ] ||
  preflight_timeout_invalid

FINAL_WT_CREATED=0
BASE_WT_CREATED=0
FINAL_SUBMODULES_CREATED=0
BASE_SUBMODULES_CREATED=0
# How far the run got. The EXIT trap stamps this into the log so an abort is distinguishable from a
# short successful run. Must stay bound before `trap on_exit EXIT` is armed below — under `set -u`
# an unbound read inside the trap would abort it and skip emit_terminal_result.
REVIEW_PHASE=preflight

cleanup_worktrees() {
  local status=0
  set +e
  if [ "$FINAL_SUBMODULES_CREATED" -eq 1 ]; then
    if [ ! -e "$FINAL_SUBMODULE_MANIFEST" ] && [ ! -L "$FINAL_SUBMODULE_MANIFEST" ]; then
      FINAL_SUBMODULES_CREATED=0
    elif review_cleanup_submodules "$FINAL_SUBMODULE_MANIFEST"; then
      FINAL_SUBMODULES_CREATED=0
    else
      status=1
    fi
  fi
  if [ "$BASE_SUBMODULES_CREATED" -eq 1 ]; then
    if [ ! -e "$BASE_SUBMODULE_MANIFEST" ] && [ ! -L "$BASE_SUBMODULE_MANIFEST" ]; then
      BASE_SUBMODULES_CREATED=0
    elif review_cleanup_submodules "$BASE_SUBMODULE_MANIFEST"; then
      BASE_SUBMODULES_CREATED=0
    else
      status=1
    fi
  fi
  if [ "$FINAL_WT_CREATED" -eq 1 ]; then
    if review_remove_worktree "$GIT_ROOT" "$FINAL_WT"; then
      FINAL_WT_CREATED=0
    else
      status=1
    fi
  fi
  if [ "$BASE_WT_CREATED" -eq 1 ]; then
    if review_remove_worktree "$GIT_ROOT" "$BASE_WT"; then
      BASE_WT_CREATED=0
    else
      status=1
    fi
  fi
  set -e
  return "$status"
}

emit_terminal_result() {
  local status=$1 duration timed_out=false
  [ -n "${LOG:-}" ] && [ -n "${RUN_RESULT_TOOL:-}" ] || return 0
  duration=$(( $(date +%s) - STARTED_AT ))
  [ "$status" -eq 124 ] && timed_out=true
  node "$RUN_RESULT_TOOL" emit "$status" "$duration" "$LOG" "$timed_out" \
    devkit-review-run-result-v1 >/dev/null 2>&1 || true
}

# Stamp how far the run got AND stream it. Until this existed $LOG got one header line and then
# nothing until the gate chain launched ~245 lines later, so a review wedged in setup was
# indistinguishable from one merely working hard — the only way to tell was an external `ps`.
# Elapsed seconds, not wall-clock: the question a stalled run asks is "how long has THIS step been
# going". Terminated with `|| :` deliberately — this is instrumentation, and a failed log write must
# never abort a run or change a verdict (same reasoning as the terminal trailer in on_exit). That
# matters more than usual here: `set -euo pipefail` is on, so an unguarded `tee` pipeline at every
# phase boundary would be a dozen new ways for a full disk to kill the run.
review_phase() {
  REVIEW_PHASE=$1
  printf '%s\n' "$REVIEW_PHASE" > "$PREFLIGHT_STAGE_FILE" 2>/dev/null || :
  printf 'devkit review: phase=%s t=%ss\n' "$REVIEW_PHASE" "$(( $(date +%s) - STARTED_AT ))" |
    tee -a "$LOG" >&2 || :
}

# ── Setup/teardown hang guard ────────────────────────────────────────────────────────────────────
# The gate chain has been bounded since sc-1199, but SHIP_COMMIT_TIMEOUT is read INSIDE
# run_gates_with_capture and wraps only the gate command. Everything around it — two `git worktree
# add` checkouts, submodule and dependency materialization twice over, the asset runtime, the
# baseline capture, and the teardown that removes the ephemeral worktrees — ran unbounded, and
# nothing bounds this script from outside either (cli/commands/review.mts spawns it with no
# timeout). A wedged setup step hung until a human noticed.
#
# Signals the process GROUP, not $$. Bash defers a trapped signal until the running FOREGROUND
# command returns, and never signals that child — so `kill -TERM $$` against a wedged `git worktree
# add` is a placebo: the trap would not run until the very command being interrupted finished on its
# own. run-packaged-script.mts spawns this script `detached` for precisely this reason ("a dedicated
# process group lets a signal interrupt foreground setup helpers too") and signals -pid; this is the
# same mechanism applied from the inside. When this shell is NOT a group leader (a test running the
# script directly under bash), `-$$` matches no group, ESRCH is tolerated, and the pid fallback runs
# in knowingly degraded form.
#
# Does NOT escalate to SIGKILL. on_exit's teardown deliberately runs in a signal-ignoring subshell so
# worktree removal cannot be interrupted; a KILL would defeat that and strand the ephemeral
# worktrees checked out — strictly worse than the hang it replaces. TERM to the group unwedges the
# foreground child, on_exit takes over, and a wedge that survives even that is reported rather than
# force-killed.
start_preflight_watchdog() {
  [ -z "$PREFLIGHT_WATCHDOG_PID" ] || return 0
  local main=$$
  (
    trap '' HUP INT QUIT TERM
    # Poll rather than one long sleep: this subshell inherits the caller's stderr (its banner has to
    # reach the console), so a single `sleep $PREFLIGHT_TIMEOUT` would hold that pipe open for the
    # whole ceiling if the shell were SIGKILLed — the pipe-holder wedge documented at the top of
    # run-gates-with-capture.sh. Noticing the parent is gone bounds that to one tick. SECONDS is a
    # bash builtin, so the loop costs no subprocess per tick.
    # `-le`, not `-lt`: SECONDS counts wall-clock second BOUNDARIES, so its first increment can land
    # a few milliseconds in. Waiting one boundary longer guarantees the guard never fires EARLY —
    # overshooting a hang ceiling by under a second costs nothing, undershooting it kills live runs.
    SECONDS=0
    while [ "$SECONDS" -le "$PREFLIGHT_TIMEOUT_SECS" ]; do
      /bin/sleep 0.25
      kill -0 "$main" 2>/dev/null || exit 0
    done
    stage=unknown
    [ ! -f "$PREFLIGHT_STAGE_FILE" ] || IFS= read -r stage < "$PREFLIGHT_STAGE_FILE" || stage=unknown
    # Written BEFORE the signal: on_exit reads this to tell a ceiling apart from a user's Ctrl-C.
    : > "$PREFLIGHT_TIMEOUT_SENTINEL" 2>/dev/null || :
    {
      printf '⏱  devkit review: setup/teardown hit the %ss ceiling DURING: %s\n' \
        "$PREFLIGHT_TIMEOUT" "$stage"
      printf '   No gate verdict was reached. Raise DEVKIT_PREFLIGHT_TIMEOUT, or investigate a wedged setup step. Full log: %s\n' \
        "$LOG"
    } | tee -a "$LOG" >&2 || :
    kill -TERM -"$main" 2>/dev/null || kill -TERM "$main" 2>/dev/null || :
    # Report an unkillable wedge instead of forcing it; teardown is mid-flight and must finish.
    SECONDS=0
    while kill -0 "$main" 2>/dev/null; do
      if [ "$SECONDS" -ge 60 ]; then
        printf '   devkit review: still running 60s after the ceiling; teardown may be wedged (pid %s).\n' \
          "$main" | tee -a "$LOG" >&2 || :
        break
      fi
      /bin/sleep 0.25
    done
  ) >/dev/null &
  PREFLIGHT_WATCHDOG_PID=$!
}

# KILL, not TERM. The watchdog IGNORES TERM by design — it sits in the process group it signals, and
# a self-inflicted TERM would kill it before it could report an unkillable wedge. That makes TERM
# useless for retiring it: the `wait` below would block until the ceiling elapsed on its own, hanging
# every single run at the pre-gate handover for up to an hour. Nothing in the watchdog needs an
# orderly shutdown — it owns no state and its only fd is the stderr it inherited — so an
# uncatchable signal is exactly right.
#
# Idempotent, and safe while `set -e` is armed: `wait` on a killed child returns non-zero and `kill`
# on an already-reaped pid fails, either of which would otherwise abort the script at the pre-gate
# stop point, which sits outside on_exit's `set +e`. Same shape as the tee teardown in
# run-gates-with-capture.sh.
stop_preflight_watchdog() {
  [ -n "$PREFLIGHT_WATCHDOG_PID" ] || return 0
  kill -KILL "$PREFLIGHT_WATCHDOG_PID" 2>/dev/null || :
  wait "$PREFLIGHT_WATCHDOG_PID" 2>/dev/null || :
  PREFLIGHT_WATCHDOG_PID=
}

finalize_signal_status() {
  local lock status_file managed_status
  [ -n "$MANAGED_SIGNAL_ROOT" ] || return 0
  lock=$MANAGED_SIGNAL_ROOT/signal.lock
  status_file=$MANAGED_SIGNAL_ROOT/status
  while ! mkdir "$lock" 2>/dev/null; do
    [ -d "$MANAGED_SIGNAL_ROOT" ] || { REQUESTED_SIGNAL_STATUS=1; return 0; }
    /bin/sleep 0.01
  done
  if [ -f "$status_file" ]; then
    IFS= read -r managed_status < "$status_file" || managed_status=
    case "$managed_status" in
      129 | 130 | 131 | 143) REQUESTED_SIGNAL_STATUS=$managed_status ;;
      *) REQUESTED_SIGNAL_STATUS=1 ;;
    esac
  fi
  # Keep the lock until process exit: the wrapper then treats later signals as arriving after the
  # terminal-result boundary instead of changing only the public exit status.
}

on_exit() {
  local status=$? cleanup_status=0 result_word=
  # FIRST, before anything else: disarm the hang guard and read its verdict. The sentinel lives under
  # $STATE_ROOT, which the cleanup subshell below REMOVES — reading it any later would always miss,
  # and every guard-fired ceiling would be misreported as `signaled` off the forwarded TERM. Stopping
  # the guard here also closes the window where a watchdog firing mid-teardown relabels an ordinary
  # preflight failure (there are ~20 `exit 1` paths above it) as a timeout.
  stop_preflight_watchdog
  [ ! -f "$PREFLIGHT_TIMEOUT_SENTINEL" ] || PREFLIGHT_TIMED_OUT=1
  # Then make the transition non-interruptible, disarm EXIT and install recording handlers.
  # Cleanup itself runs in a signal-ignoring subshell so its git/rm descendants cannot be killed;
  # Bash records a forwarded signal as soon as that foreground cleanup completes.
  trap '' HUP INT QUIT TERM
  trap - EXIT
  trap 'REQUESTED_SIGNAL_STATUS=129' HUP
  trap 'REQUESTED_SIGNAL_STATUS=130' INT
  trap 'REQUESTED_SIGNAL_STATUS=131' QUIT
  trap 'REQUESTED_SIGNAL_STATUS=143' TERM
  set +e
  (
    trap '' HUP INT QUIT TERM
    private_cleanup_status=0
    cleanup_worktrees || private_cleanup_status=$?
    rm -f -- "$PROGRESS" 2>/dev/null || private_cleanup_status=1
    if [ "$FINAL_WT_CREATED" -eq 0 ] && [ "$BASE_WT_CREATED" -eq 0 ]; then
      rm -rf -- "$STATE_ROOT" 2>/dev/null || private_cleanup_status=1
    else
      printf 'devkit review: cleanup incomplete; private runtime retained at %s\n' \
        "$STATE_ROOT" >&2
    fi
    exit "$private_cleanup_status"
  )
  cleanup_status=$?
  finalize_signal_status
  if [ "$REQUESTED_SIGNAL_STATUS" -ne 0 ]; then status=$REQUESTED_SIGNAL_STATUS; fi
  # The guard's TERM arrives here as an ordinary forwarded signal (143); its sentinel is the only
  # thing separating a ceiling from a user's Ctrl-C. Map it to the SAME 124 the gate chain's ceiling
  # uses so both report one timeout vocabulary, and emit_terminal_result's timed_out flag follows.
  # Ordered after the signal override so the ceiling wins over the signal it sent itself.
  if [ "$PREFLIGHT_TIMED_OUT" -eq 1 ]; then status=124; fi
  if [ "$status" -eq 0 ] && [ "$cleanup_status" -ne 0 ]; then status=1; fi
  # Make the log self-terminating: every exit past log creation leaves one machine-readable line, so
  # a preflight abort cannot read as a short pass. Only safe against double emission because
  # `trap - EXIT` above precedes the cleanup subshell. Deliberately best-effort — `set +e` is active
  # and a failed log write must never change a verdict that has already been decided. `>>` not
  # `tee`: the human ✓/✗ line already reached stderr and the trap must stay off the console.
  if [ -n "${LOG:-}" ] && [ -f "$LOG" ]; then
    case "$status" in
      0) result_word=passed; [ "${REVIEW_PHASE:-}" = nothing-to-review ] && result_word=skipped ;;
      124) result_word=timeout ;;
      129 | 130 | 131 | 143) result_word=signaled ;;
      *) result_word=failed ;;
    esac
    printf 'devkit review: result=%s exit=%s phase=%s\n' \
      "$result_word" "$status" "${REVIEW_PHASE:-unknown}" >> "$LOG"
  fi
  emit_terminal_result "$status"
  exit "$status"
}

trap on_exit EXIT
gate_signal_handoff_init

mkdir -p "$(dirname "$LOG")"
(set -C; : > "$LOG") || {
  echo 'devkit review: could not create a unique review log.' >&2
  exit 1
}
printf 'devkit review: target=%s base=%s merge-base=%s\n' \
  "$TARGET_ROOT" "$BASE_REF" "$MERGE_BASE" | tee -a "$LOG" >&2

# Armed as early as the log allows — it covers every node/git call from here to the gate chain.
# Work ABOVE this point stays deliberately unguarded: $LOG does not exist yet, so a ceiling banner
# would have nowhere to go, and that stretch is argument parsing plus a handful of rev-parses.
start_preflight_watchdog
review_phase setup-capture
node "$SETUP_MANIFEST_TOOL" capture "$TARGET_ROOT" "$SETUP_MANIFEST"
# Fail closed on a helper that exited 0 without doing its job. runDirectReviewCli returns silently
# (exit 0) when its realpath entrypoint guard does not match, which would let the whole setup
# authority — core.hooksPath included — go unchecked while looking exactly like success.
[ -s "$SETUP_MANIFEST" ] || {
  echo 'devkit review: setup capture produced no manifest.' >&2
  exit 1
}
node "$REPOSITORY_STATE_TOOL" capture "$TARGET_ROOT" "$REPOSITORY_MANIFEST"
[ -s "$REPOSITORY_MANIFEST" ] || {
  echo 'devkit review: repository state capture produced no manifest.' >&2
  exit 1
}
git_line_into CAPTURED_TARGET_HEAD "$GIT_ROOT" rev-parse --verify --end-of-options 'HEAD^{commit}' || exit 1
git_line_into CAPTURED_BASE_COMMIT "$GIT_ROOT" rev-parse --verify --end-of-options \
  "$BASE_REF^{commit}" || exit 1
git_line_into CAPTURED_MERGE_BASE "$GIT_ROOT" merge-base \
  "$CAPTURED_BASE_COMMIT" "$CAPTURED_TARGET_HEAD" || exit 1
CAPTURED_BRANCH=
git_line_into CAPTURED_BRANCH "$GIT_ROOT" symbolic-ref --quiet --short HEAD 2>/dev/null || true
if [ -z "$CAPTURED_BRANCH" ]; then
  git_line_into CAPTURED_SHORT_HEAD "$GIT_ROOT" rev-parse --short HEAD || exit 1
  CAPTURED_BRANCH=detached-$CAPTURED_SHORT_HEAD
fi
if [ "$CAPTURED_TARGET_HEAD:$CAPTURED_BASE_COMMIT:$CAPTURED_MERGE_BASE" != \
  "$TARGET_HEAD:$BASE_COMMIT:$MERGE_BASE" ] || [ "$CAPTURED_BRANCH" != "$BRANCH" ]; then
  echo 'devkit review: target HEAD, branch, or base changed during preflight; retry.' \
    | tee -a "$LOG" >&2
  exit 1
fi
review_phase snapshot
SNAPSHOT_PAIR=$(review_snapshot_capture_trees "$TARGET_ROOT" "$TARGET_HEAD") || exit $?
read -r STAGED_TREE RAW_TREE <<< "$SNAPSHOT_PAIR"
case "$STAGED_TREE:$RAW_TREE" in
  *[!0-9a-f:]* | :* | *:) echo 'devkit review: snapshot helper returned invalid tree IDs.' >&2; exit 1 ;;
esac
review_warn_dirty_source_submodules "$GIT_ROOT"

verify_target_capture() {
  node "$SETUP_MANIFEST_TOOL" verify "$TARGET_ROOT" "$SETUP_MANIFEST" &&
    node "$SETUP_RUNTIME_TOOL" source "$SETUP_MANIFEST" "$TARGET_ROOT" &&
    node "$REPOSITORY_STATE_TOOL" verify "$TARGET_ROOT" "$REPOSITORY_MANIFEST" &&
    review_snapshot_trees_match "$TARGET_ROOT" "$TARGET_HEAD" "$STAGED_TREE" "$RAW_TREE"
}

verify_target_capture || {
  echo 'devkit review: target changed after capture; retry.' | tee -a "$LOG" >&2
  exit 1
}

if [ "$STAGED_TREE" = "$BASE_TREE" ]; then
  review_phase nothing-to-review
  printf '✓ devkit review: nothing to review against %s (%s). full output: %s\n' \
    "$BASE_REF" "$MERGE_BASE" "$LOG" | tee -a "$LOG" >&2
  exit 0
fi

review_phase worktree-final
FINAL_WT_CREATED=1
review_create_worktree "$GIT_ROOT" "$FINAL_WT" "$MERGE_BASE"
review_materialize_tree "$FINAL_WT" "$STAGED_TREE" "$RAW_TREE"
review_snapshot_trees_match "$TARGET_ROOT" "$TARGET_HEAD" "$STAGED_TREE" "$RAW_TREE" || {
  echo 'devkit review: target changed while the final snapshot was materialized; retry.' >&2
  exit 1
}
review_phase submodules-final
FINAL_SUBMODULES_CREATED=1
review_materialize_submodules "$FINAL_WT" "$GIT_ROOT" "$FINAL_SUBMODULE_MANIFEST"

review_phase setup-runtime
node "$SETUP_RUNTIME_TOOL" materialize "$SETUP_MANIFEST" "$FINAL_WT" \
  "$SETUP_RUNTIME_MANIFEST" > "$SETUP_FIELDS_FILE"
SETUP_FIELDS=()
while IFS= read -r -d '' field; do SETUP_FIELDS+=("$field"); done < "$SETUP_FIELDS_FILE"
[ "${#SETUP_FIELDS[@]}" -ge 8 ] && \
  [ "${SETUP_FIELDS[0]}" = devkit-review-setup-v1 ] || {
  echo 'devkit review: setup runtime returned a malformed protocol.' >&2
  exit 1
}
TARGET_RELATIVE=${SETUP_FIELDS[1]}
HOOKS_PATH=${SETUP_FIELDS[2]}
OVERLAY=${SETUP_FIELDS[3]}
REVIEW_ENABLED=${SETUP_FIELDS[4]}
DECISIONS_DIR=${SETUP_FIELDS[5]}
CHAIN_HOOK=${SETUP_FIELDS[6]}
GUARD_COUNT=${SETUP_FIELDS[7]}
case "$GUARD_COUNT" in
  '' | *[!0-9]*) echo 'devkit review: setup runtime fields are invalid.' >&2; exit 1 ;;
esac
case "$OVERLAY:$REVIEW_ENABLED:$HOOKS_PATH" in
  0:1:.husky/_ | 1:1:.devkit/hooks) ;;
  *) echo 'devkit review: setup runtime fields are invalid.' >&2; exit 1 ;;
esac
[ "${#SETUP_FIELDS[@]}" -eq "$((8 + GUARD_COUNT))" ] || {
  echo 'devkit review: setup runtime guard list is truncated.' >&2
  exit 1
}
if [ "$TARGET_RELATIVE" = . ]; then
  FINAL_TARGET=$FINAL_WT
else
  FINAL_TARGET=$FINAL_WT/$TARGET_RELATIVE
fi
[ -d "$FINAL_TARGET" ] && [ ! -L "$FINAL_TARGET" ] || {
  echo 'devkit review: private target scope is unavailable.' >&2
  exit 1
}
GUARDS=
index=0
while [ "$index" -lt "$GUARD_COUNT" ]; do
  guard=${SETUP_FIELDS[$((8 + index))]}
  if [ -n "$GUARDS" ]; then GUARDS=$GUARDS,$guard; else GUARDS=$guard; fi
  index=$((index + 1))
done

review_phase deps-final
export DEVKIT_REVIEW_DEPENDENCY_MANIFEST="$FINAL_DEPENDENCY_MANIFEST"
prepare_gate_worktree "$FINAL_TARGET" "$TARGET_ROOT" review
unset DEVKIT_REVIEW_DEPENDENCY_MANIFEST
export DEVKIT_REVIEW_PROJECTION_MANIFEST="$FINAL_PROJECTION_MANIFEST"
link_untracked_gate_configs "$FINAL_TARGET" "$TARGET_ROOT" review
unset DEVKIT_REVIEW_PROJECTION_MANIFEST

review_phase assets
ASSET_FINGERPRINT=$(node "$ASSET_RUNTIME_TOOL" materialize "$PACKAGE_ROOT" "$ASSET_RUNTIME")
[ -n "$ASSET_FINGERPRINT" ] || {
  echo 'devkit review: reviewer asset runtime returned no fingerprint.' >&2
  exit 1
}
DEPENDENCY_FINGERPRINT=$(node "$DEPENDENCY_RUNTIME_TOOL" fingerprint \
  "$FINAL_DEPENDENCY_MANIFEST")
case "$ASSET_FINGERPRINT:$DEPENDENCY_FINGERPRINT" in
  *[!0-9a-f:]* | :* | *:) echo 'devkit review: runtime fingerprint is invalid.' >&2; exit 1 ;;
esac
DEVKIT_REVIEW_RUNTIME_FINGERPRINT=$(printf '%s\0%s' \
  "$ASSET_FINGERPRINT" "$DEPENDENCY_FINGERPRINT" | \
  git -c core.hooksPath=/dev/null -C "$GIT_ROOT" hash-object --stdin) || exit 1
export DEVKIT_REVIEW_RUNTIME_FINGERPRINT

review_phase worktree-base
BASE_WT_CREATED=1
review_create_worktree "$GIT_ROOT" "$BASE_WT" "$MERGE_BASE"
if [ "$TARGET_RELATIVE" = . ]; then
  BASE_TARGET=$BASE_WT
else
  BASE_TARGET=$BASE_WT/$TARGET_RELATIVE
fi
[ -d "$BASE_TARGET" ] && [ ! -L "$BASE_TARGET" ] || {
  echo 'devkit review: target scope does not exist at the resolved merge base.' >&2
  exit 1
}
BASE_SNAPSHOT_PAIR=$(review_snapshot_capture_trees "$BASE_TARGET" "$MERGE_BASE") || exit $?
read -r BASE_CAPTURED_STAGED BASE_RAW_TREE <<< "$BASE_SNAPSHOT_PAIR"
[ "$BASE_CAPTURED_STAGED" = "$BASE_TREE" ] && [ -n "$BASE_RAW_TREE" ] || {
  echo 'devkit review: merge-base worktree did not materialize the resolved base tree.' >&2
  exit 1
}
review_phase submodules-base
BASE_SUBMODULES_CREATED=1
review_materialize_submodules "$BASE_WT" "$GIT_ROOT" "$BASE_SUBMODULE_MANIFEST"
review_phase deps-base
export DEVKIT_REVIEW_DEPENDENCY_MANIFEST="$BASE_DEPENDENCY_MANIFEST"
prepare_gate_worktree "$BASE_TARGET" "$TARGET_ROOT" review-baseline
unset DEVKIT_REVIEW_DEPENDENCY_MANIFEST
export DEVKIT_REVIEW_PROJECTION_MANIFEST="$BASE_PROJECTION_MANIFEST"
link_untracked_gate_configs "$BASE_TARGET" "$TARGET_ROOT" review-baseline
unset DEVKIT_REVIEW_PROJECTION_MANIFEST

review_phase baseline-capture
BASELINE_GATE="$ASSET_RUNTIME/gate-engine/review/baseline-gate.mjs"
[ -f "$BASELINE_GATE" ] || BASELINE_GATE="$ASSET_RUNTIME/gate-engine/review/baseline-gate.mts"
[ -f "$BASELINE_GATE" ] || {
  echo 'devkit review: private merge-base helper is unavailable.' >&2
  exit 1
}
node "$BASELINE_GATE" capture "$BASE_WT" "$FINAL_WT" "$BASELINE_RUNTIME"

review_phase cache-session
mkdir "$PRIVATE_DATA_ROOT"
IFS= read -r -d '' PERSISTENT_CACHE_ROOT < <(
  node "$CACHE_ROOT_TOOL" "$TARGET_ROOT" "$STATE_ROOT"
) || {
  echo 'devkit review: could not resolve the persistent review cache.' >&2
  exit 1
}
node "$CACHE_SESSION_TOOL" prepare "$PERSISTENT_CACHE_ROOT" "$PRIVATE_DATA_ROOT" \
  > "$CACHE_FIELDS_FILE"
CACHE_FIELDS=()
while IFS= read -r -d '' field; do CACHE_FIELDS+=("$field"); done < "$CACHE_FIELDS_FILE"
case "${CACHE_FIELDS[1]:-}" in
  ''|*[!0-9]*) CACHE_COUNT=-1 ;;
  *) CACHE_COUNT=${CACHE_FIELDS[1]} ;;
esac
[ "${CACHE_FIELDS[0]:-}" = devkit-review-cache-session-v1 ] && \
  [ "$CACHE_COUNT" -ge 0 ] && \
  [ "${#CACHE_FIELDS[@]}" -eq "$((2 + (CACHE_COUNT * 2)))" ] || {
  echo 'devkit review: cache session returned a malformed protocol.' >&2
  exit 1
}
CACHE_NAMES=()
CACHE_GENERATIONS=()
for ((i = 0; i < CACHE_COUNT; i += 1)); do
  CACHE_NAMES+=("${CACHE_FIELDS[2 + (i * 2)]}")
  CACHE_GENERATIONS+=("${CACHE_FIELDS[3 + (i * 2)]}")
done

export DEVKIT_RUN_MODE=review
export DEVKIT_REVIEW_GUARDS="$GUARDS"
export GUARD_DECISIONS_DIR="$DECISIONS_DIR"
export DEVKIT_REVIEW_PACKAGE_ROOT="$ASSET_RUNTIME"
export DEVKIT_REVIEW_ASSET_ROOT="$ASSET_RUNTIME"
export DEVKIT_REVIEW_DATA_ROOT="$PRIVATE_DATA_ROOT"
export DEVKIT_REVIEW_BASELINE_DIR="$BASELINE_RUNTIME"
export DEVKIT_REVIEW_MERGE_BASE="$MERGE_BASE"

# sc-1442: no commit message exists for a review run — synthesize advisory intent from the
# reviewed range's subjects, oldest first (line 1 = the branch's founding intent, which becomes
# the reviewers' semantic-Target query). MUST run against the TARGET repo: the snapshot
# worktrees' HEAD is pinned at the merge base, so `git log` there sees nothing. Best-effort under
# set -e: any git failure or an empty range leaves the var unset → the gate's placeholder path.
INTENT_FILE="$STATE_ROOT/commit-intent.txt"
git -c core.hooksPath=/dev/null -C "$GIT_ROOT" log --reverse --format=%s \
  "$MERGE_BASE..$TARGET_HEAD" > "$INTENT_FILE" 2>/dev/null || :
if [ -s "$INTENT_FILE" ]; then
  export DEVKIT_COMMIT_MSG_FILE="$INTENT_FILE"
else
  rm -f -- "$INTENT_FILE" 2>/dev/null || :
fi

write_mutable_exclusions() {
  local manifest=$1 destination=$2 raw=$STATE_ROOT/mutable-$$.bin root scoped last_byte
  node "$PROJECTION_RUNTIME_TOOL" mutable "$manifest" > "$raw" || return 1
  : > "$destination"
  while IFS= read -r -d '' root; do
    scoped=$root
    [ "$TARGET_RELATIVE" = . ] || scoped=$TARGET_RELATIVE/$root
    printf '%s\0' "$scoped" >> "$destination" || return 1
  done < "$raw"
  if [ -s "$raw" ]; then
    last_byte=$(tail -c 1 "$raw" | od -An -tu1 | tr -d '[:space:]') || return 1
    [ "$last_byte" = 0 ] || return 1
  fi
  rm -f "$raw"
}

write_mutable_exclusions "$FINAL_PROJECTION_MANIFEST" "$FINAL_EXCLUSIONS"
write_mutable_exclusions "$BASE_PROJECTION_MANIFEST" "$BASE_EXCLUSIONS"
review_capture_untracked "$FINAL_WT" "$FINAL_UNTRACKED_MANIFEST" "$FINAL_EXCLUSIONS"
review_capture_untracked "$BASE_WT" "$BASE_UNTRACKED_MANIFEST" "$BASE_EXCLUSIONS"

FINAL_BEFORE_STAGED=$(review_staged_tree "$FINAL_WT")
BASE_BEFORE_STAGED=$(review_staged_tree "$BASE_WT")
[ "$FINAL_BEFORE_STAGED" = "$STAGED_TREE" ] && [ "$BASE_BEFORE_STAGED" = "$BASE_TREE" ] || {
  echo 'devkit review: private index changed before the hook started.' >&2
  exit 1
}
git_line_into FINAL_BEFORE_HEAD "$FINAL_WT" rev-parse --verify HEAD || exit 1
git_line_into BASE_BEFORE_HEAD "$BASE_WT" rev-parse --verify HEAD || exit 1
[ "$FINAL_BEFORE_HEAD" = "$MERGE_BASE" ] && [ "$BASE_BEFORE_HEAD" = "$MERGE_BASE" ] || {
  echo 'devkit review: private worktree HEAD moved before the hook started.' >&2
  exit 1
}
review_phase preflight-verify
review_worktree_matches_tree "$FINAL_WT" "$RAW_TREE" "$STAGED_TREE"
review_worktree_matches_tree "$BASE_WT" "$BASE_RAW_TREE" "$BASE_TREE"
review_verify_submodules "$FINAL_SUBMODULE_MANIFEST"
review_verify_submodules "$BASE_SUBMODULE_MANIFEST"
node "$SETUP_RUNTIME_TOOL" verify "$SETUP_MANIFEST" "$SETUP_RUNTIME_MANIFEST"
node "$DEPENDENCY_RUNTIME_TOOL" verify "$TARGET_ROOT" "$FINAL_DEPENDENCY_MANIFEST"
node "$DEPENDENCY_RUNTIME_TOOL" verify "$TARGET_ROOT" "$BASE_DEPENDENCY_MANIFEST"
node "$PROJECTION_RUNTIME_TOOL" verify "$TARGET_ROOT" "$FINAL_TARGET" \
  "$FINAL_PROJECTION_MANIFEST"
node "$PROJECTION_RUNTIME_TOOL" verify "$TARGET_ROOT" "$BASE_TARGET" \
  "$BASE_PROJECTION_MANIFEST"
node "$ASSET_RUNTIME_TOOL" verify "$PACKAGE_ROOT" "$ASSET_RUNTIME" "$ASSET_FINGERPRINT"
verify_target_capture

# Hand the ceiling over to the gate chain, which has owned its own since sc-1199. Two guards must
# never be armed at once: this one signals the whole process group, which would tear the supervised
# gate tree out from under the supervisor that is already reaping it.
stop_preflight_watchdog
review_phase gates
GATE_RAW_STATUS=0
if [ "$OVERLAY" -eq 1 ]; then
  run_gates_with_capture "$FINAL_TARGET" "$TARGET_ROOT" 'devkit review' "$LOG" "$PROGRESS" -- \
    bash -c '
      set -e
      target=$1
      chain=$2
      root=$3
      DEVKIT_VIA_HUSKY_INIT=1 git -C "$target" -c core.hooksPath=.devkit/hooks hook run pre-commit
      [ -z "$chain" ] || git -C "$root" -c core.hooksPath="$(dirname "$chain")" hook run pre-commit
    ' devkit-review-overlay "$FINAL_TARGET" "$CHAIN_HOOK" "$FINAL_WT" || GATE_RAW_STATUS=$?
else
  run_gates_with_capture "$FINAL_TARGET" "$TARGET_ROOT" 'devkit review' "$LOG" "$PROGRESS" -- \
    git -C "$FINAL_TARGET" -c core.hooksPath="$HOOKS_PATH" hook run pre-commit || GATE_RAW_STATUS=$?
fi
if [ "$REQUESTED_SIGNAL_STATUS" -ne 0 ]; then GATE_RAW_STATUS=$REQUESTED_SIGNAL_STATUS; fi
rm -f "$PROGRESS"

# Re-arm for teardown. This stretch is a second unbounded region for exactly the reasons the setup
# was — a dozen verify passes plus cleanup_worktrees, whose `git worktree remove` can wedge just as
# readily as the `git worktree add` that created it. Without this the run would hang here with a
# stale phase=gates, which is the very symptom this work exists to remove.
start_preflight_watchdog
review_phase postflight-verify
AUTHORITY_OK=1
FORMAT_CHANGED=0
FINAL_AFTER_STAGED=$(review_staged_tree "$FINAL_WT" 2>/dev/null) || AUTHORITY_OK=0
if [ "$FINAL_AFTER_STAGED" != "$FINAL_BEFORE_STAGED" ]; then FORMAT_CHANGED=1; AUTHORITY_OK=0; fi
BASE_AFTER_STAGED=$(review_staged_tree "$BASE_WT" 2>/dev/null) || AUTHORITY_OK=0
[ "$BASE_AFTER_STAGED" = "$BASE_BEFORE_STAGED" ] || AUTHORITY_OK=0
git_line_into FINAL_AFTER_HEAD "$FINAL_WT" rev-parse --verify HEAD 2>/dev/null || AUTHORITY_OK=0
git_line_into BASE_AFTER_HEAD "$BASE_WT" rev-parse --verify HEAD 2>/dev/null || AUTHORITY_OK=0
[ "${FINAL_AFTER_HEAD:-}" = "$MERGE_BASE" ] || AUTHORITY_OK=0
[ "${BASE_AFTER_HEAD:-}" = "$MERGE_BASE" ] || AUTHORITY_OK=0
if ! review_worktree_matches_tree "$FINAL_WT" "$RAW_TREE" "$STAGED_TREE"; then
  FORMAT_CHANGED=1
  AUTHORITY_OK=0
fi
review_worktree_matches_tree "$BASE_WT" "$BASE_RAW_TREE" "$BASE_TREE" || AUTHORITY_OK=0
review_assert_untracked_unchanged "$FINAL_WT" "$FINAL_UNTRACKED_MANIFEST" \
  "$FINAL_EXCLUSIONS" || AUTHORITY_OK=0
review_assert_untracked_unchanged "$BASE_WT" "$BASE_UNTRACKED_MANIFEST" \
  "$BASE_EXCLUSIONS" || AUTHORITY_OK=0
review_verify_submodules "$FINAL_SUBMODULE_MANIFEST" || AUTHORITY_OK=0
review_verify_submodules "$BASE_SUBMODULE_MANIFEST" || AUTHORITY_OK=0
node "$SETUP_RUNTIME_TOOL" verify "$SETUP_MANIFEST" "$SETUP_RUNTIME_MANIFEST" || AUTHORITY_OK=0
node "$DEPENDENCY_RUNTIME_TOOL" verify "$TARGET_ROOT" "$FINAL_DEPENDENCY_MANIFEST" || AUTHORITY_OK=0
node "$DEPENDENCY_RUNTIME_TOOL" verify "$TARGET_ROOT" "$BASE_DEPENDENCY_MANIFEST" || AUTHORITY_OK=0
node "$PROJECTION_RUNTIME_TOOL" verify "$TARGET_ROOT" "$FINAL_TARGET" \
  "$FINAL_PROJECTION_MANIFEST" || AUTHORITY_OK=0
node "$PROJECTION_RUNTIME_TOOL" verify "$TARGET_ROOT" "$BASE_TARGET" \
  "$BASE_PROJECTION_MANIFEST" || AUTHORITY_OK=0
node "$ASSET_RUNTIME_TOOL" verify "$PACKAGE_ROOT" "$ASSET_RUNTIME" \
  "$ASSET_FINGERPRINT" || AUTHORITY_OK=0
verify_target_capture || AUTHORITY_OK=0

review_phase cleanup
cleanup_worktrees || AUTHORITY_OK=0
verify_target_capture || AUTHORITY_OK=0

review_phase cache-promote
CACHE_RESET=0
if [ "$AUTHORITY_OK" -eq 1 ]; then
  index=0
  while [ "$index" -lt "${#CACHE_NAMES[@]}" ]; do
    promotion_status=0
    node "$CACHE_SESSION_TOOL" promote "$PERSISTENT_CACHE_ROOT" "$PRIVATE_DATA_ROOT" \
      "${CACHE_NAMES[$index]}" "${CACHE_GENERATIONS[$index]}" >/dev/null || promotion_status=$?
    case "$promotion_status" in
      0) ;;
      2)
        CACHE_RESET=1
        printf 'devkit review: %s was reset concurrently; rerun before accepting green.\n' \
          "${CACHE_NAMES[$index]}" >&2
        ;;
      *)
        printf 'devkit review: warning: could not persist %s checkpoint; this run remains authoritative.\n' \
          "${CACHE_NAMES[$index]}" >&2
        ;;
    esac
    index=$((index + 1))
  done
fi

case "$GATE_RAW_STATUS" in
  0) FINAL_STATUS=0 ;;
  124 | 129 | 130 | 131 | 143) FINAL_STATUS=$GATE_RAW_STATUS ;;
  *) FINAL_STATUS=1 ;;
esac
if [ "$FINAL_STATUS" -eq 0 ] && { [ "$AUTHORITY_OK" -ne 1 ] || [ "$CACHE_RESET" -eq 1 ]; }; then
  FINAL_STATUS=1
fi
review_phase verdict

if [ "$FORMAT_CHANGED" -eq 1 ]; then
  {
    echo '✗ devkit review: the pre-commit hook changed the ephemeral snapshot.'
    echo "   Format/update the target and rerun; no ephemeral changes were copied back. Full output: $LOG"
  } | tee -a "$LOG" >&2
elif [ "$AUTHORITY_OK" -ne 1 ]; then
  printf '✗ devkit review: snapshot/runtime integrity changed during review; verdict discarded. Full output: %s\n' \
    "$LOG" | tee -a "$LOG" >&2
elif [ "$GATE_RAW_STATUS" -ne 0 ]; then
  printf '✗ devkit review: gate chain blocked (gate exit %s; command exit %s). Full output: %s\n' \
    "$GATE_RAW_STATUS" "$FINAL_STATUS" "$LOG" | tee -a "$LOG" >&2
elif [ "$CACHE_RESET" -eq 1 ]; then
  printf '✗ devkit review: a cache reset raced this run; rerun before accepting green. Full output: %s\n' \
    "$LOG" | tee -a "$LOG" >&2
else
  printf '✓ devkit review: configured pre-commit gates passed. full output: %s\n' "$LOG" \
    | tee -a "$LOG" >&2
fi
exit "$FINAL_STATUS"
