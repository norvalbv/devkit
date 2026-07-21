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

# Never inherit another ship/review's authority, private paths, or telemetry destination. The two
# topology hints and SHIP_COMMIT_TIMEOUT are intentional invocation inputs and remain untouched.
for name in \
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
  if git -c core.hooksPath=/dev/null -C "$GIT_ROOT" rev-parse --verify --quiet \
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

FINAL_WT_CREATED=0
BASE_WT_CREATED=0
FINAL_SUBMODULES_CREATED=0
BASE_SUBMODULES_CREATED=0
ACTIVE_GATE_PID=
GATE_LAUNCHING=0
REQUESTED_SIGNAL_STATUS=0
REQUESTED_SIGNAL=

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
  local status=$? cleanup_status=0
  # First make the transition non-interruptible, then disarm EXIT and install recording handlers.
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
  if [ "$status" -eq 0 ] && [ "$cleanup_status" -ne 0 ]; then status=1; fi
  emit_terminal_result "$status"
  exit "$status"
}

forward_signal() {
  local status=$1 signal=$2
  REQUESTED_SIGNAL_STATUS=$status
  REQUESTED_SIGNAL=$signal
  if [ -n "$ACTIVE_GATE_PID" ]; then
    kill -s "$signal" "$ACTIVE_GATE_PID" 2>/dev/null || true
    return 0
  fi
  [ "$GATE_LAUNCHING" -eq 0 ] || return 0
  exit "$status"
}
review_gate_launching() { GATE_LAUNCHING=1; }
review_gate_started() {
  ACTIVE_GATE_PID=$1
  GATE_LAUNCHING=0
  if [ "$REQUESTED_SIGNAL_STATUS" -ne 0 ]; then
    kill -s "$REQUESTED_SIGNAL" "$ACTIVE_GATE_PID" 2>/dev/null || true
  fi
}
review_gate_reaped() { ACTIVE_GATE_PID=; }
review_gate_finished() { ACTIVE_GATE_PID=; }
trap on_exit EXIT
trap 'forward_signal 129 HUP' HUP
trap 'forward_signal 130 INT' INT
trap 'forward_signal 131 QUIT' QUIT
trap 'forward_signal 143 TERM' TERM

mkdir -p "$(dirname "$LOG")"
(set -C; : > "$LOG") || {
  echo 'devkit review: could not create a unique review log.' >&2
  exit 1
}
printf 'devkit review: target=%s base=%s merge-base=%s\n' \
  "$TARGET_ROOT" "$BASE_REF" "$MERGE_BASE" | tee -a "$LOG" >&2

node "$SETUP_MANIFEST_TOOL" capture "$TARGET_ROOT" "$SETUP_MANIFEST"
node "$REPOSITORY_STATE_TOOL" capture "$TARGET_ROOT" "$REPOSITORY_MANIFEST"
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
  printf '✓ devkit review: nothing to review against %s (%s). full output: %s\n' \
    "$BASE_REF" "$MERGE_BASE" "$LOG" | tee -a "$LOG" >&2
  exit 0
fi

FINAL_WT_CREATED=1
review_create_worktree "$GIT_ROOT" "$FINAL_WT" "$MERGE_BASE"
review_materialize_tree "$FINAL_WT" "$STAGED_TREE" "$RAW_TREE"
review_snapshot_trees_match "$TARGET_ROOT" "$TARGET_HEAD" "$STAGED_TREE" "$RAW_TREE" || {
  echo 'devkit review: target changed while the final snapshot was materialized; retry.' >&2
  exit 1
}
FINAL_SUBMODULES_CREATED=1
review_materialize_submodules "$FINAL_WT" "$GIT_ROOT" "$FINAL_SUBMODULE_MANIFEST"

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

export DEVKIT_REVIEW_DEPENDENCY_MANIFEST="$FINAL_DEPENDENCY_MANIFEST"
prepare_gate_worktree "$FINAL_TARGET" "$TARGET_ROOT" review
unset DEVKIT_REVIEW_DEPENDENCY_MANIFEST
export DEVKIT_REVIEW_PROJECTION_MANIFEST="$FINAL_PROJECTION_MANIFEST"
link_untracked_gate_configs "$FINAL_TARGET" "$TARGET_ROOT" review
unset DEVKIT_REVIEW_PROJECTION_MANIFEST

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
BASE_SUBMODULES_CREATED=1
review_materialize_submodules "$BASE_WT" "$GIT_ROOT" "$BASE_SUBMODULE_MANIFEST"
export DEVKIT_REVIEW_DEPENDENCY_MANIFEST="$BASE_DEPENDENCY_MANIFEST"
prepare_gate_worktree "$BASE_TARGET" "$TARGET_ROOT" review-baseline
unset DEVKIT_REVIEW_DEPENDENCY_MANIFEST
export DEVKIT_REVIEW_PROJECTION_MANIFEST="$BASE_PROJECTION_MANIFEST"
link_untracked_gate_configs "$BASE_TARGET" "$TARGET_ROOT" review-baseline
unset DEVKIT_REVIEW_PROJECTION_MANIFEST

BASELINE_GATE="$ASSET_RUNTIME/gate-engine/review/baseline-gate.mjs"
[ -f "$BASELINE_GATE" ] || BASELINE_GATE="$ASSET_RUNTIME/gate-engine/review/baseline-gate.mts"
[ -f "$BASELINE_GATE" ] || {
  echo 'devkit review: private merge-base helper is unavailable.' >&2
  exit 1
}
node "$BASELINE_GATE" capture "$BASE_WT" "$FINAL_WT" "$BASELINE_RUNTIME"

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
[ "${#CACHE_FIELDS[@]}" -eq 8 ] && \
  [ "${CACHE_FIELDS[0]}" = devkit-review-cache-session-v1 ] && \
  [ "${CACHE_FIELDS[1]}" = 3 ] || {
  echo 'devkit review: cache session returned a malformed protocol.' >&2
  exit 1
}
CACHE_NAMES=("${CACHE_FIELDS[2]}" "${CACHE_FIELDS[4]}" "${CACHE_FIELDS[6]}")
CACHE_GENERATIONS=("${CACHE_FIELDS[3]}" "${CACHE_FIELDS[5]}" "${CACHE_FIELDS[7]}")

export DEVKIT_RUN_MODE=review
export DEVKIT_REVIEW_GUARDS="$GUARDS"
export GUARD_DECISIONS_DIR="$DECISIONS_DIR"
export DEVKIT_REVIEW_PACKAGE_ROOT="$ASSET_RUNTIME"
export DEVKIT_REVIEW_ASSET_ROOT="$ASSET_RUNTIME"
export DEVKIT_REVIEW_DATA_ROOT="$PRIVATE_DATA_ROOT"
export DEVKIT_REVIEW_BASELINE_DIR="$BASELINE_RUNTIME"
export DEVKIT_REVIEW_MERGE_BASE="$MERGE_BASE"

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

cleanup_worktrees || AUTHORITY_OK=0
verify_target_capture || AUTHORITY_OK=0

CACHE_RESET=0
if [ "$AUTHORITY_OK" -eq 1 ]; then
  index=0
  while [ "$index" -lt 3 ]; do
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
