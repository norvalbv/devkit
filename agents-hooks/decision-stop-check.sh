#!/bin/bash
# Stop hook — automated decision-capture nudge. When the agent finishes a turn, nudge it to
# record the *why* of an architectural decision WHILE the conversation context (the why) is
# still live, instead of waiting for the commit gate (by which point the why may be gone).
#
# Soft + snoozable by design: the agent often records the decision at the END of its work,
# not the start, so this must not nag mid-task. It reminds ONCE per session, then stays quiet
# — the git pre-commit gate (guard-decisions detect --gate) is the hard backstop.
#
# ── Portability (W-3) ───────────────────────────────────────────────────────────────────
# The smell scan calls the devkit `guard-decisions detect scan --working` bin (not a
# consumer-local script). That bin resolves boundaries + the decisions dir from the
# consumer's guard.config.json relative to its cwd, so this hook carries no repo-specific
# paths. Self-skips cleanly when guard-decisions is unavailable (devkit not installed). A bin too OLD
# to emit file-scoped pairs is reported once per session instead of silently disabling the nudge
# (sc-1051) — only for a session with edits, since the ledger gate runs first. Not detectable here:
# a scan that errors (detect.mts swallows it) or a bin with no `scan` subcommand — both print nothing,
# which is indistinguishable from "no smells".

input=$(cat)

# Loop guard: never block a stop that we ourselves re-invoked.
echo "$input" | grep -q '"stop_hook_active":[[:space:]]*true' && exit 0

# Absolute hook dir BEFORE cd — a relative $0 would dangle after the chdir.
HOOK_DIR=$(cd "$(dirname "$0")" 2>/dev/null && pwd)
cd "${CLAUDE_PROJECT_DIR:-$HOOK_DIR/../..}" 2>/dev/null || exit 0

# GUARD_NO_LOG (FRINK_NO_LOG back-compat alias) bypasses the decision gate entirely.
[ -n "$GUARD_NO_LOG" ] && exit 0
[ -n "$FRINK_NO_LOG" ] && exit 0

# Session scoping — only nudge about smells in files THIS session edited (ledger written by
# format-after-edit.sh; see session-edits-lib.sh). Missing lib (sync-hooks --only) or no
# session edits → FAIL-OPEN: a session that edited nothing made no decision to record.
# The commit gate (guard-decisions detect --gate) stays working-tree-wide.
source "$HOOK_DIR/session-edits-lib.sh" 2>/dev/null || true
declare -F session_edits_file &>/dev/null || exit 0
LEDGER=$(clean_session_ledger "$(session_edits_file "$input")")
[ -n "$LEDGER" ] || exit 0
trap 'rm -f "$LEDGER"' EXIT

# Per-session SEEN-SET: a file listing the `<smell-label>\t<contributing-file>` pairs already
# nudged this session. The hook re-arms only on a pair NOT yet in the set — so the SAME pending
# decision (its pairs are already recorded) stays silent across every later edit turn, while a
# genuinely NEW decision (a never-seen pair) nudges exactly once. Replaces the old binary latch
# (remind-once-then-silent-forever), which suppressed every distinct decision after the first.
#
# Keyed by session_id so parallel sessions don't share state; NOT cleared by commits. Ephemeral
# session DATA → lives in $TMPDIR, never in the repo, matching $TMPDIR/devkit-search-state/.
# $TMPDIR is machine-global but real session_ids are globally-unique UUIDs, so two repos never
# collide; namespace by repo root too so the empty-id fallback ('unknown') can't cross repos.
SID=$(echo "$input" | grep -o '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
REPO_KEY=$(pwd -P | cksum | cut -d' ' -f1)
SNOOZE_DIR="${TMPDIR:-/tmp}/devkit-decision-snooze"
SEEN="$SNOOZE_DIR/${REPO_KEY}-${SID:-unknown}"

# Resolve the decisions-CLI bin: prefer the repo-local pinned bin (a consumer that vendors devkit as a
# dependency), else the global on PATH (a consumer that pins via a global install + config devkitRef),
# else skip silently (devkit not installed → this hook is a no-op). LOCAL-FIRST so a stale global bin
# can't shadow a repo's pinned copy — an older global missing the `--files` flag would emit nothing and
# silently suppress every nudge. NO `bunx` fallback: on a machine without devkit, `bunx guard-decisions`
# would try to FETCH from the registry (a network stall/error, and @norvalbv/devkit isn't on npm anyway)
# — turning the intended silent no-op into a blocked stop.
if [ -x "./node_modules/.bin/guard-decisions" ]; then
  DECISIONS="./node_modules/.bin/guard-decisions"
  BIN_KIND=local
  BIN_PATH="$(pwd -P)/node_modules/.bin/guard-decisions"
elif command -v guard-decisions &>/dev/null; then
  DECISIONS="guard-decisions"
  BIN_KIND=global
  BIN_PATH=$(command -v guard-decisions)
else
  exit 0
fi

# Cheap regex scan of the WHOLE working tree (staged + unstaged), emitting (label, contributing-file)
# pairs. No LLM here — the gate's claude -p judgment is for commit time; this turn-end check stays fast.
# Fingerprint the bin BEFORE it runs, and run exactly that path, so an upgrade landing mid-scan is not
# snoozed under the old bin's stale-bin notice (sc-1051, below).
STAMP=$({ ls -lLd "$BIN_PATH"; cksum <"$BIN_PATH"; } 2>/dev/null | cksum | cut -d' ' -f1)
PAIRS=$("$BIN_PATH" detect scan --working --files 2>/dev/null)
[ -z "$PAIRS" ] && exit 0

# sc-1051 — a bin that predates `--files` (c72dc608, 2026-06-30) IGNORES the flag and prints bare
# labels; the ledger filter below keys on a tab-separated file column, so it would drop every line
# and the nudge would go dark with no signal. Every current-bin line carries a tab and no smell label
# does, so "non-empty, no tab anywhere" is exactly "stale bin". Report it once per session per bin
# fingerprint (Stop hooks within a session are serial, so no locking): the marker is written only
# AFTER the notice is delivered, so a kill or EPIPE just repeats it next stop, and a marker that
# cannot be written exits 0 rather than blocking every stop.
if ! printf '%s\n' "$PAIRS" | grep -q "$(printf '\t')"; then
  STALE_MARK="$SEEN.stale-bin-${STAMP}"
  [ -e "$STALE_MARK" ] && exit 0
  PIN=$(grep -oE '"devkitRef"[[:space:]]*:[[:space:]]*"[^"]*"' .devkit/config.json 2>/dev/null | head -1 | sed -E 's/.*"([^"]+)"$/\1/')
  {
    echo "🧭 Decision-capture nudges are OFF in this repo: $BIN_PATH predates"
    echo "'guard-decisions detect scan --files', so it cannot say which file each smell came from."
    if [ "$BIN_KIND" = local ]; then
      echo "Fix: bump this repo's @norvalbv/devkit dependency${PIN:+ to $PIN}, then reinstall."
    else
      echo "Fix: upgrade the global devkit on PATH${PIN:+ to $PIN, the devkitRef this repo pins}."
    fi
    echo "(shown once per session until that bin changes)"
  } >&2 || exit 0
  { mkdir -p "$SNOOZE_DIR" && : >"$STALE_MARK"; } 2>/dev/null || exit 0
  exit 2
fi

# Keep only pairs whose contributing file is in this session's edits ledger — a smell in a
# file a PARALLEL session is working on is that session's nudge, not this one's.
PAIRS=$(printf '%s\n' "$PAIRS" | awk -F'\t' 'NR==FNR { if ($0 != "") e[$0] = 1; next } $2 in e' "$LEDGER" -)
[ -z "$PAIRS" ] && exit 0

# A decision file is already being touched this session → it's being handled, don't nag. Resolve the
# decision-log dir the way guard-decisions does (DECISIONS_DIR env → guard.config.json → docs/decisions)
# so a consumer that RELOCATED it isn't nagged while editing its real record. Pure-bash extract (no
# node: type:module vs commonjs across consumers would break a `require`).
DECISIONS_DIR="${DECISIONS_DIR:-$(grep -oE '"decisionsDir"[[:space:]]*:[[:space:]]*"[^"]*"' guard.config.json 2>/dev/null | head -1 | sed -E 's/.*"([^"]+)"$/\1/')}"
git status --porcelain -- ":(literal)${DECISIONS_DIR:-docs/decisions}/" 2>/dev/null | grep -q . && exit 0

# Which smelled pairs are NEW this session? (grep -vxF against the seen-set; missing file → all new.)
mkdir -p "$SNOOZE_DIR"
if [ -f "$SEEN" ]; then
  NEW=$(printf '%s\n' "$PAIRS" | grep -vxF -f "$SEEN" 2>/dev/null)
else
  NEW="$PAIRS"
fi
[ -z "$NEW" ] && exit 0 # every smelled pair already nudged this session → stay silent

# Record the new pairs (so they don't re-nag), then nudge once with their distinct smell labels.
printf '%s\n' "$NEW" >> "$SEEN"
LABELS=$(printf '%s\n' "$NEW" | cut -f1 | sort -u | paste -sd, -)
{
  echo "🧭 New architectural decision smelled in your working tree: $LABELS."
  echo ""
  echo "If this turn settled a road-not-taken choice (a viable alternative was rejected and the"
  echo "rationale will matter in 6 months), record the WHY now while it's fresh:"
  echo "  $DECISIONS add <slug> --target --new --context \"...\" --ruling \"...\" \\"
  echo "    --consequences \"...\" --tradeoff \"...\" --vision-fit \"...\""
  echo "First: $DECISIONS list  (reuse an existing axis; surface its prior ruling)."
  echo ""
  echo "Still mid-task, or not a decision? Ignore this — the commit gate enforces it later."
  echo "(these smells won't nag again this session)"
} >&2
exit 2
