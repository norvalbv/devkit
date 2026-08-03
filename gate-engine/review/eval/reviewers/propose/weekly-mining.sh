#!/bin/sh
# Weekly corpus-growth sweep (sc-1415, epic 1399): run both miners + both propose stages,
# append the funnel summaries to a log, and pop a notification. NOTIFY-ONLY by design — the
# adapt stage (fixture authoring) is the judgment step and stays a human/agent session; this
# script never writes to cases-*.jsonl and never commits.
#
# Installed into the owner's crontab (Mondays 09:00 local):
#   0 9 * * 1 "<checkout>/gate-engine/review/eval/reviewers/propose/weekly-mining.sh"
# cron ships a minimal environment, so PATH is set explicitly (bun + homebrew + gh).
# mine-telemetry needs THIS machine's ~/.claude-usage db + diff archive — that is why this is a
# local cron job and not a cloud routine (recorded on the sc-1415 ticket).
#
# Each stage's EXIT STATUS is captured before its output is tailed into the log (a plain
# `cmd | tail` pipeline would report tail's status and mask miner failures — review finding on
# #321). A failed stage marks the sweep failed: propose-telemetry is skipped when its miner
# failed, the notification says FAILED naming the stages, and the script exits non-zero so cron
# records the failure instead of a false "refreshed".
set -u
PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export PATH

cd "$(dirname "$0")/.." || exit 1
LOG="${HOME}/.claude-usage/weekly-mining.log"
TMP="$(mktemp)" || exit 1
trap 'rm -f "$TMP"' EXIT
FAILED=""

# run_stage <label> <tail-lines> <command...> — captures the command's own exit status, logs the
# tail of its output either way, and accumulates failures. Returns the command's status.
run_stage() {
  stage_label="$1"
  stage_lines="$2"
  shift 2
  echo "--- ${stage_label} ---" >>"$LOG"
  "$@" >"$TMP" 2>&1
  stage_status=$?
  tail -n "$stage_lines" "$TMP" >>"$LOG"
  if [ "$stage_status" -ne 0 ]; then
    echo "!!! ${stage_label} FAILED (exit ${stage_status})" >>"$LOG"
    FAILED="${FAILED} ${stage_label}"
  fi
  return "$stage_status"
}

echo "=== weekly mining sweep $(date -u '+%Y-%m-%dT%H:%MZ') ===" >>"$LOG"
run_stage mine-bots 6 bun mine-bots.mts
if run_stage mine-telemetry 8 bun mine-telemetry.mts; then
  run_stage propose-telemetry 4 bun propose/propose-telemetry.mts --max 10
else
  echo "--- propose-telemetry skipped (mine-telemetry failed) ---" >>"$LOG"
fi
run_stage propose-bots 4 bun propose/propose.mts --suite correctness --max 10
echo "" >>"$LOG"

if [ -n "$FAILED" ]; then
  osascript -e "display notification \"Sweep FAILED:${FAILED} — see ~/.claude-usage/weekly-mining.log\" with title \"devkit weekly mining\"" 2>/dev/null || true
  exit 1
fi
osascript -e 'display notification "Corpus sweep done — queues refreshed. See ~/.claude-usage/weekly-mining.log" with title "devkit weekly mining"' 2>/dev/null || true
