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
# paths. Self-skips cleanly when guard-decisions is unavailable (devkit not installed).

input=$(cat)

# Loop guard: never block a stop that we ourselves re-invoked.
echo "$input" | grep -q '"stop_hook_active":\s*true' && exit 0

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}" 2>/dev/null || exit 0

# GUARD_NO_LOG (FRINK_NO_LOG back-compat alias) bypasses the decision gate entirely.
[ -n "$GUARD_NO_LOG" ] && exit 0
[ -n "$FRINK_NO_LOG" ] && exit 0

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

# Resolve the decisions-CLI bin: prefer the devkit-installed bin, else a local node_modules bin, else
# skip silently (devkit not installed → this hook is a no-op). NO `bunx` fallback: on a machine without
# devkit, `bunx guard-decisions` would try to FETCH from the registry (a network stall/error, and
# @norvalbv/devkit isn't on npm anyway) — turning the intended silent no-op into a blocked stop.
if command -v guard-decisions &>/dev/null; then
  DECISIONS="guard-decisions"
elif [ -x "./node_modules/.bin/guard-decisions" ]; then
  DECISIONS="./node_modules/.bin/guard-decisions"
else
  exit 0
fi

# Cheap regex scan of the WHOLE working tree (staged + unstaged), emitting (label, contributing-file)
# pairs. No LLM here — the gate's claude -p judgment is for commit time; this turn-end check stays fast.
PAIRS=$($DECISIONS detect scan --working --files 2>/dev/null)
[ -z "$PAIRS" ] && exit 0

# A decision file is already being touched this session → it's being handled, don't nag. Resolve the
# decision-log dir the way guard-decisions does (DECISIONS_DIR env → guard.config.json → docs/decisions)
# so a consumer that RELOCATED it isn't nagged while editing its real record. Pure-bash extract (no
# node: type:module vs commonjs across consumers would break a `require`).
DECISIONS_DIR="${DECISIONS_DIR:-$(grep -oE '"decisionsDir"[[:space:]]*:[[:space:]]*"[^"]*"' guard.config.json 2>/dev/null | head -1 | sed -E 's/.*"([^"]+)"$/\1/')}"
git status --porcelain -- "${DECISIONS_DIR:-docs/decisions}/" 2>/dev/null | grep -q . && exit 0

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
