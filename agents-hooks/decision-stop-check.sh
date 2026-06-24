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

# Per-session snooze: a marker file keyed by session_id; its existence = "already reminded
# this session". Sessions don't share one file (no concurrent-session ping-pong) and it is
# NOT cleared by commits — so a PARALLEL session's commit can't un-snooze us. Empty id →
# re-nag (safe direction). The marker is ephemeral session DATA, so it lives in $TMPDIR —
# never in the repo (no .claude/ clutter, nothing for git or agent context to pick up),
# matching the search-tool counter's $TMPDIR/devkit-search-state/ pattern.
#
# $TMPDIR is machine-global (shared across repos), but real session_ids are globally-unique
# UUIDs so two repos never collide. The one shared key is the empty-id fallback ('unknown'),
# so namespace by repo root too: a parse-miss in repo A then can't snooze repo B.
SID=$(echo "$input" | grep -o '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
REPO_KEY=$(pwd -P | cksum | cut -d' ' -f1)
SNOOZE_DIR="${TMPDIR:-/tmp}/devkit-decision-snooze"
SNOOZE="$SNOOZE_DIR/${REPO_KEY}-${SID:-unknown}"
[ -f "$SNOOZE" ] && exit 0 # already reminded this session

# Resolve the decisions-CLI bin: prefer the devkit-installed bin, else a local node_modules
# bin, else skip silently (devkit not installed → this hook is a no-op).
if command -v guard-decisions &>/dev/null; then
  DECISIONS="guard-decisions"
elif [ -x "./node_modules/.bin/guard-decisions" ]; then
  DECISIONS="./node_modules/.bin/guard-decisions"
elif command -v bunx &>/dev/null; then
  DECISIONS="bunx guard-decisions"
else
  exit 0
fi

# Cheap regex scan of the WHOLE working tree (staged + unstaged). No LLM here — the gate's
# claude -p judgment is for commit time; this turn-end check must stay fast.
SMELLS=$($DECISIONS detect scan --working 2>/dev/null)
[ -z "$SMELLS" ] && exit 0

# A decision file is already being touched this session → it's being handled, don't nag.
# The decisions dir defaults to docs/decisions; a consumer relocating it via guard.config
# only changes WHERE the records land, not this best-effort heuristic.
git status --porcelain -- docs/decisions/ 2>/dev/null | grep -q . && exit 0

# Remind once: snooze this session first so a re-invoke (or the next turn) doesn't repeat.
mkdir -p "$SNOOZE_DIR" && touch "$SNOOZE"
{
  echo "🧭 Architectural decision smelled in your working tree: $(echo "$SMELLS" | paste -sd, -)."
  echo ""
  echo "If this turn settled a road-not-taken choice (a viable alternative was rejected and the"
  echo "rationale will matter in 6 months), record the WHY now while it's fresh:"
  echo "  $DECISIONS add <slug> --target --ruling \"...\" --vision \"...\""
  echo "First: $DECISIONS list  (reuse an existing axis; surface its prior ruling)."
  echo ""
  echo "Still mid-task, or not a decision? Ignore this — the commit gate enforces it later."
  echo "(reminder snoozed for this session)"
} >&2
exit 2
