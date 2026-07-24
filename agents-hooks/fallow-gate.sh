#!/usr/bin/env bash
set -euo pipefail

# Fallow commit gate, staged-scoped. Blocks a `git commit` (and `git push` unless
# FALLOW_GATE_COMMIT_ONLY=1) when `fallow audit` reports a verdict of fail AND at least one
# INTRODUCED finding is attributable to the staged diff.
#
# WHY THIS LIVES IN DEVKIT. `fallow hooks install` generates a stock gate that blocks on any
# introduced finding ANYWHERE in the worktree, which lets unrelated parallel work — or a stale
# baseline — block a clean commit and pressures contributors into --no-verify. The staged-diff
# re-scoping that fixes it is devkit's `gate-engine/fallow/staged-filter`. Before this hook
# existed devkit shipped that logic as a bin with nothing to invoke it, so each consumer
# hand-patched its own copy of the stock gate and the copies drifted (sc-1192). This gate calls
# devkit's module directly — there is no per-repo copy to drift.
#
# Fail-open on tooling absence (no fallow, no node, no config), fail-CLOSED on tooling failure:
# a gate that cannot attribute must never silently weaken itself.
#
# Exit 0 = allow, exit 2 = block. Exit 2 is both Claude Code's PreToolUse block signal and the
# code a husky pre-commit can test for, so one script serves the agent hook and the git hook.

ROOT="${CLAUDE_PROJECT_DIR:-}"
if [ -z "$ROOT" ]; then
  ROOT="$(cd "$(dirname "$0")/../.." 2>/dev/null && pwd)" || exit 0
fi
cd "$ROOT" 2>/dev/null || exit 0

# Self-skip when the consumer has not adopted fallow (the agent-hooks convention: a synced hook
# whose tool or config is absent must be inert, never noisy).
if [ ! -f .fallowrc.jsonc ] && [ ! -f .fallowrc.json ]; then
  exit 0
fi
if ! command -v node >/dev/null 2>&1; then
  echo "fallow-gate: node not on PATH, skipping audit." >&2
  exit 0
fi

# Claude Code sends the tool payload on stdin. node (already required for the filter) parses it,
# so this hook adds no jq dependency. A husky caller feeds the same shape synthetically.
INPUT="$(cat)"
CMD="$(printf '%s' "$INPUT" | node -e 'try{const j=JSON.parse(require("node:fs").readFileSync(0,"utf8"));process.stdout.write(String(j&&j.tool_input&&j.tool_input.command||""))}catch(e){}' 2>/dev/null || true)"

# Commit-only by DEFAULT; FALLOW_GATE_INCLUDE_PUSH=1 widens the trigger to `git push` too. By
# push time every commit already cleared this gate, so auditing again only taxes the caller.
#
# The knob is an opt-IN read inside the script rather than an env prefix on the registered
# command, because the Cursor mirror is derived by stripping a leading `node`/`bash` from that
# command (hook-settings.mts toCursorCommand) — a `VAR=1 bash …` prefix defeats that anchor and
# writes a broken .cursor/hooks.json entry. Every registration must stay a bare runner + path.
VERBS='commit'
if [ "${FALLOW_GATE_INCLUDE_PUSH:-}" = 1 ]; then
  VERBS='(commit|push)'
fi
if ! printf '%s\n' "$CMD" | grep -Eq "(^|[[:space:];|&()])git[[:space:]]+${VERBS}([[:space:]]|\$)"; then
  exit 0
fi

if command -v fallow >/dev/null 2>&1; then
  RUNNER=(fallow)
  BIN_DESC="$(command -v fallow)"
elif command -v npx >/dev/null 2>&1 && VER_PROBE="$(npx --no-install fallow --version 2>/dev/null || true)" && [ "${VER_PROBE#fallow}" != "$VER_PROBE" ]; then
  RUNNER=(npx --no-install fallow)
  BIN_DESC="npx --no-install fallow"
else
  echo "fallow-gate: fallow binary not found (tried PATH and npx --no-install), skipping audit." >&2
  exit 0
fi

# Version floor. Older binaries miss fallow's uncommitted-changes inclusion fix and can silently
# pass audits that should fail. Set FALLOW_GATE_MIN_VERSION= (empty) to disable.
VERSION_RAW="$("${RUNNER[@]}" --version 2>/dev/null || true)"
VERSION="${VERSION_RAW#fallow }"
VERSION="${VERSION%% *}"
MIN_VERSION="${FALLOW_GATE_MIN_VERSION-2.46.0}"
if [ -n "$MIN_VERSION" ] && [ -n "$VERSION" ]; then
  LOWER="$(printf '%s\n%s\n' "$MIN_VERSION" "$VERSION" | sort -V | head -n1)"
  if [ "$LOWER" != "$MIN_VERSION" ]; then
    echo "fallow-gate: blocked: $BIN_DESC is fallow $VERSION, below required $MIN_VERSION." >&2
    echo "fallow-gate: upgrade fallow, or set FALLOW_GATE_MIN_VERSION= to disable this floor." >&2
    exit 2
  fi
fi

# devkit's staged-diff re-scoper. Resolved by REAL PATH, never through node_modules/.bin: a bin
# shim is a symlink, and a devkit older than the run-as-main fix (sc-1178) would not dispatch
# through one — it would exit 0 having done nothing, which reads as "no blockers" and passes
# every commit. The direct module path dispatches on every version.
FILTER=""
for candidate in \
  "$ROOT/node_modules/@norvalbv/devkit/dist/gate-engine/fallow/staged-filter.mjs" \
  "$ROOT/dist/gate-engine/fallow/staged-filter.mjs" \
  "$ROOT/gate-engine/fallow/staged-filter.mts"; do
  if [ -f "$candidate" ]; then
    FILTER="$candidate"
    break
  fi
done

TMP_JSON="$(mktemp)"
TMP_ERR="$(mktemp)"
FILTER_ERR="$(mktemp)"
cleanup() {
  rm -f "$TMP_JSON" "$TMP_ERR" "$FILTER_ERR"
}
trap cleanup EXIT

if "${RUNNER[@]}" audit --format json --quiet --explain >"$TMP_JSON" 2>"$TMP_ERR"; then
  STATUS=0
else
  STATUS=$?
fi
VERDICT="$(node -e 'try{const j=JSON.parse(require("node:fs").readFileSync(0,"utf8"));process.stdout.write(String(j&&j.verdict||""))}catch(e){}' <"$TMP_JSON" 2>/dev/null || true)"

# This stays FIRST, ahead of the STATUS fail-opens: `fallow audit` exits non-zero on a fail
# verdict, so a STATUS check before it would swallow the exact case we want to scope.
if [ "$VERDICT" = "fail" ]; then
  if [ -n "$FILTER" ]; then
    BLOCKERS="$(node "$FILTER" <"$TMP_JSON" 2>"$FILTER_ERR")" && frc=0 || frc=$?
    if [ "${frc:-2}" -eq 1 ]; then
      echo "fallow-gate: blocked by fallow ${VERSION:-unknown} — introduced finding(s) overlap the staged diff:" >&2
      echo "$BLOCKERS" >&2
      exit 2
    fi
    if [ "${frc:-2}" -eq 0 ]; then
      echo "fallow-gate: worktree verdict=fail, but no introduced finding overlaps the staged diff — passing (staged-scoped)." >&2
      exit 0
    fi
    # rc not in {0,1}: attribution failed. Never weaken the gate on tooling failure — fall back
    # to the unscoped worktree verdict, but SAY WHY. The filter writes one bounded line naming
    # the cause; discarding it is what made sc-1192 undiagnosable.
    echo "fallow-gate: staged-diff filter unavailable (rc=${frc:-?}); falling back to full-worktree verdict." >&2
    sed -n '1,3p' "$FILTER_ERR" >&2 2>/dev/null || true
  else
    echo "fallow-gate: devkit staged-diff filter not found under $ROOT; falling back to full-worktree verdict." >&2
  fi
  # NEVER echo the audit payload: it reaches hundreds of KB and this stderr is surfaced to the
  # agent, which would blow its context window.
  echo "fallow-gate: blocked by fallow ${VERSION:-unknown} at $BIN_DESC." >&2
  echo "fallow-gate: staged-scoping unavailable — the worktree has NEW fallow findings (dead-code / duplication / complexity). Resolve them, then retry. Payload suppressed." >&2
  exit 2
fi

# Past here the verdict is not fail. Fail open on runtime errors, keeping the skip visible.
if [ "$STATUS" -ne 0 ]; then
  ERR_LINE="$(sed -n '1p' "$TMP_ERR" 2>/dev/null || true)"
  echo "fallow-gate: fallow audit exited $STATUS${ERR_LINE:+ ($ERR_LINE)}, skipping." >&2
  exit 0
fi

exit 0
