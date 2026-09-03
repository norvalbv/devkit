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
#
# Full stage output is kept under ~/.claude-usage/weekly-mining/<sweep>/ (8 weeks) and a failed
# stage logs its last 20 lines (sc-2492: a 6-line tail cut the error above bun's hint twice).
set -u
PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export PATH

# bun prints its ulimit hint for ANY root error while the soft fd limit is under 16384, and cron's
# is 256, so a low limit hides the real error; lift it first (every miner passed a 256-fd replica).
raise_fd_limit() {
  fd_hard="$(ulimit -Hn 2>/dev/null || echo unlimited)"
  fd_want=65536
  if [ "$fd_hard" != unlimited ] && [ "$fd_hard" -lt "$fd_want" ] 2>/dev/null; then fd_want="$fd_hard"; fi
  ulimit -Sn "$fd_want" 2>/dev/null || true
}
raise_fd_limit

cd "$(dirname "$0")/.." || exit 1
LOG="${HOME}/.claude-usage/weekly-mining.log"
SWEEP="$(date -u '+%Y-%m-%dT%H:%MZ')"
RUNS="${HOME}/.claude-usage/weekly-mining"
mkdir -p "$RUNS" || exit 1
# Unique per invocation: two overlapping sweeps must never write into the same stage files.
RUN_DIR="$(mktemp -d "${RUNS}/${SWEEP}.XXXXXX")" || exit 1
FAILED=""

# run_stage <label> <tail-lines> <command...> — captures the command's own exit status, keeps its
# full output in RUN_DIR, logs the tail (20 lines on failure, enough to clear bun's 8-line hint).
run_stage() {
  stage_label="$1"
  stage_lines="$2"
  shift 2
  stage_out="${RUN_DIR}/${stage_label}.log"
  echo "--- ${stage_label} ---" >>"$LOG"
  "$@" >"$stage_out" 2>&1
  stage_status=$?
  [ "$stage_status" -ne 0 ] && stage_lines=20
  tail -n "$stage_lines" "$stage_out" >>"$LOG"
  if [ "$stage_status" -ne 0 ]; then
    echo "!!! ${stage_label} FAILED (exit ${stage_status}) — full output: ${stage_out}" >>"$LOG"
    FAILED="${FAILED} ${stage_label}"
  fi
  return "$stage_status"
}

echo "=== weekly mining sweep ${SWEEP} (fd soft=$(ulimit -Sn) hard=$(ulimit -Hn)) ===" >>"$LOG"
run_stage mine-bots 6 bun mine-bots.mts
if run_stage mine-telemetry 8 bun mine-telemetry.mts; then
  run_stage propose-telemetry 4 bun propose/propose-telemetry.mts --max 10
else
  echo "--- propose-telemetry skipped (mine-telemetry failed) ---" >>"$LOG"
fi
run_stage mine-ghsa 4 bun mine-ghsa.mts
run_stage propose-bots 4 bun propose/propose.mts --suite correctness --max 10
echo "" >>"$LOG"
# Prune by AGE (8 weekly sweeps), never by count: a concurrent sweep's directory is always fresh.
find "$RUNS" -mindepth 1 -maxdepth 1 -type d -mtime +56 -exec rm -rf {} + 2>/dev/null || true

if [ -n "$FAILED" ]; then
  osascript -e "display notification \"Sweep FAILED:${FAILED} — see ~/.claude-usage/weekly-mining.log\" with title \"devkit weekly mining\"" 2>/dev/null || true
  exit 1
fi
osascript -e 'display notification "Corpus sweep done — queues refreshed. See ~/.claude-usage/weekly-mining.log" with title "devkit weekly mining"' 2>/dev/null || true
