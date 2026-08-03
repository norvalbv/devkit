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
set -u
PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export PATH

cd "$(dirname "$0")/.." || exit 1
LOG="${HOME}/.claude-usage/weekly-mining.log"

{
  echo "=== weekly mining sweep $(date -u '+%Y-%m-%dT%H:%MZ') ==="
  echo "--- mine-bots ---"
  bun mine-bots.mts 2>&1 | tail -6
  echo "--- mine-telemetry ---"
  bun mine-telemetry.mts 2>&1 | tail -8
  echo "--- propose (bot-mined, correctness) ---"
  bun propose/propose.mts --suite correctness --max 10 2>&1 | tail -4
  echo "--- propose (telemetry) ---"
  bun propose/propose-telemetry.mts --max 10 2>&1 | tail -4
  echo ""
} >>"$LOG" 2>&1

osascript -e 'display notification "Corpus sweep done — queues refreshed. See ~/.claude-usage/weekly-mining.log" with title "devkit weekly mining"' 2>/dev/null || true
