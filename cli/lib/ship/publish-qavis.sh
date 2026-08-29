#!/usr/bin/env bash
# Qavis owns receipt validation, upload policy, and PR rendering. devkit supplies the shipped range.
#
# The probe exists because devkit and qavis version independently. PR #417 landed this call against a
# companion that was never pushed, so every ship carrying a pass receipt printed `unknown command
# 'publish'` AND a retry line naming that same impossible command (sc-2028). qavis #85 has since added
# `publish`, but an installed qavis older than it still cannot, and always will be able to lag — so
# probe before invoking, and when publication is unavailable say so ONCE, with a runnable remedy.
#
# The remedy is deliberately NOT run for you. `qavis qa --pr` re-provisions a base worktree, boots the
# app and re-judges it — minutes plus model spend on EVERY ship, and its fresh verdict can contradict
# the staged pass the receipt already recorded. The receipt exists precisely to avoid re-paying that.

# Does the installed qavis register a `publish` subcommand?
#
# Parses the `--help` Commands block and matches the WHOLE command word: "publish" also occurs in
# qavis's descriptive prose, so a substring grep false-positives. `qavis publish --help` is NOT a
# usable probe — commander answers `--help` before it errors on the unknown operand, so it exits 0
# and would march us straight back into the bug this fixes.
#
# Every failure arm resolves to "absent": not invoking is the safe direction, since invoking is what
# broke. Callers run under `set -euo pipefail`, so this is only ever evaluated as an `if` CONDITION —
# which suppresses errexit for the whole body. A publication probe must never be able to kill a ship
# that has already pushed (see docs/decisions/fail-open-needs-an-errexit-safe-call.md) — and, for the
# same reason, must never be able to HANG one either. `</dev/null` stops a qavis that reads stdin from
# swallowing the operator's piped body, but a qavis that simply never returns would still wedge the
# ship after the push landed and before the reconcile-manifest write, with nothing watching to
# interrupt it. So the probe runs under a deadline, hand-rolled because `timeout(1)` is not on macOS
# and this file has to work wherever a consumer ships from. SIGKILL, not SIGTERM: a process ignoring
# TERM would leave us waiting exactly as long as no deadline at all (measured on the doctor twin —
# a 1s timeout took 30s).
#
# The awk splits each term on `|` because commander renders an aliased subcommand as `publish|pub`
# (its help.js builds the term that way), and matching the rendered term literally would report
# absent for a publish that exists — a false negative nothing else in the system would contradict.
# It also stops at the next UNINDENTED line, because anything a help text appends after the Commands
# block (`Examples:` and friends) is prose: reading `Examples:\n  publish --pr 1` as a registered
# command is a false POSITIVE, which sends ship back to invoking a subcommand that does not exist.
# Seconds the help probe may take. Overridable so a test can assert the deadline without waiting it out.
QAVIS_HELP_TIMEOUT_S=${QAVIS_HELP_TIMEOUT_S:-5}

qavis_supports_publish() {
  local out pid waited=0 status
  out=$(mktemp) || return 1
  qavis --help >"$out" 2>/dev/null </dev/null &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge "$QAVIS_HELP_TIMEOUT_S" ]; then
      kill -9 "$pid" 2>/dev/null
      wait "$pid" 2>/dev/null
      rm -f "$out"
      return 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
  wait "$pid"
  status=$?
  if [ "$status" -ne 0 ]; then
    rm -f "$out"
    return 1
  fi
  awk '/^Commands:/ { c = 1; next }
       c && /^[^[:space:]]/ { c = 0 }
       c && /^  [a-z]/ { n = split($1, names, "|"); for (i = 1; i <= n; i++) print names[i] }' "$out" \
    | grep -qx publish
  status=$?
  rm -f "$out"
  return "$status"
}

# ONE stderr line naming WHY, then the remedy that IS supported today. The advisory gate's standing
# rule (docs/decisions/qavis-advisory-gate.md, 2026-07-22): fail-open stays exit 0, but it says why —
# silence made a dead path indistinguishable from a healthy one. Never print a `qavis publish` retry
# here: on this arm that command cannot run, and an impossible remedy is worse than none.
warn_qavis_publication_unavailable() {
  local root=$1 pr=$2 why=$3
  echo "qavis publish: pass receipt exists, but $why — PR evidence was not published." >&2
  echo "  Attach it from the receipt's PR head instead:" >&2
  printf '  qavis qa --pr %q --repo %q --annotate description\n' "$pr" "$root" >&2
}

publish_qavis_receipt() {
  local root=$1 pr=$2 base=$3 head=$4 output=''
  # Ahead of every probe, so a consumer that has never run qavis pays zero process spawns.
  [ -f "$root/.qavis/receipt.json" ] || return 0

  if ! command -v qavis >/dev/null 2>&1; then
    warn_qavis_publication_unavailable "$root" "$pr" 'qavis is not on PATH'
    return 0
  fi

  if ! qavis_supports_publish; then
    warn_qavis_publication_unavailable "$root" "$pr" \
      'the installed qavis predates its publish subcommand — upgrade it'
    return 0
  fi

  if output=$(qavis publish --pr "$pr" --repo "$root" --base "$base" --head "$head" 2>&1); then
    [ -n "$output" ] && echo "qavis publish: $output" >&2
    return 0
  fi
  # Reached only when `publish` EXISTS and failed, so this retry line is one the operator can run.
  echo "qavis publish: PR opened/pushed, but evidence publication failed." >&2
  [ -n "$output" ] && echo "  $output" >&2
  echo "  Retry only the publication step:" >&2
  printf '  qavis publish --pr %q --repo %q --base %q --head %q\n' \
    "$pr" "$root" "$base" "$head" >&2
  return 0
}
