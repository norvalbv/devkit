#!/bin/bash
# Stop hook QA — run knip (unused files/exports/deps) when the agent stops; block the stop
# (exit 2 + stderr) on findings so the agent cleans up before finishing. Fires once per
# conversation (stop_hook_active loop guard). SESSION-SCOPED: only findings in files this
# session edited are reported (see session-edits-lib.sh) — a parallel session's breakage
# never blocks this one.
#
# Portable (W-3): knip is NOT a devkit dependency. This hook DEGRADE-SKIPS unless the consumer
# has a knip config (any of knip's config forms) AND a `knip` script — so a repo without knip is
# never blocked. Runs the consumer's own knip via its npm-script, under the consumer's own package
# manager (resolve_pm — sc-1054), so npm/pnpm/yarn repos without bun are gated too.
# No frink-specific paths.

input=$(cat)

# Loop guard: don't block a stop we ourselves re-invoked.
echo "$input" | grep -q '"stop_hook_active":[[:space:]]*true' && exit 0

# Absolute hook dir BEFORE cd — a relative $0 would dangle after the chdir.
HOOK_DIR=$(cd "$(dirname "$0")" 2>/dev/null && pwd)
cd "${CLAUDE_PROJECT_DIR:-$HOOK_DIR/../..}" 2>/dev/null || exit 0

# Session scoping — only report knip findings for files THIS session edited (ledger written
# by format-after-edit.sh; see session-edits-lib.sh). Missing lib (sync-hooks --only) or no
# session edits → FAIL-OPEN: a session that edited nothing is never blocked at stop.
source "$HOOK_DIR/session-edits-lib.sh" 2>/dev/null || true
declare -F session_edits_file &>/dev/null || exit 0
LEDGER=$(clean_session_ledger "$(session_edits_file "$input")")
[ -n "$LEDGER" ] || exit 0
trap 'rm -f "$LEDGER"' EXIT

# A lib older than the runner helpers (sync-hooks --only refreshes this hook, not the lib) keeps
# the pre-sc-1054 behaviour: bun or nothing.
declare -F js_eval &>/dev/null || js_eval() { command -v bun &>/dev/null && bun -e "$1"; }
declare -F resolve_pm &>/dev/null || resolve_pm() { command -v bun &>/dev/null && echo bun; }
declare -F pm_run &>/dev/null || pm_run() { "$1" run "$2"; }

[ -f "package.json" ] || exit 0
PM=$(resolve_pm)
[ -n "$PM" ] || exit 0

# DEGRADE-SKIP: no knip config in the consumer repo → knip isn't set up here, do nothing.
# Match every config form knip resolves (knip.dev/overview/configuration).
have_config=""
for f in knip.json knip.jsonc .knip.json .knip.jsonc knip.ts knip.js knip.config.ts knip.config.js; do
  [ -f "$f" ] && { have_config=1; break; }
done
# 9th form: a `knip` key in package.json. js_eval, never a bare node probe — that silently skips
# in a bun-only toolchain (sc-1043).
[ -n "$have_config" ] || js_eval "process.exit(require('./package.json').knip?0:1)" 2>/dev/null || exit 0

# Require a `knip` npm-script (degrade-skip otherwise — we don't assume knip is installed).
js_eval "process.exit(((require('./package.json').scripts||{})['knip'])?0:1)" 2>/dev/null || exit 0

# Rely on exit code — not grep "Unused" (substring false positives). Knip is project-wide by
# nature → run whole-repo, then filter the report to this session's edited files; findings in
# files another session touched are its problem, not this one's.
if ! knip_output=$(pm_run "$PM" knip 2>&1); then
  knip_output=$(printf '%s\n' "$knip_output" | filter_output_to_session_files "$LEDGER")
  if [ -n "$knip_output" ]; then
    echo "Knip reported issues in files you edited:" >&2
    echo "" >&2
    echo "$knip_output" >&2
    echo "" >&2
    echo "(Scoped to your session's edits — '$PM run knip' shows the repo-wide view.)" >&2
    exit 2
  fi
fi

exit 0
