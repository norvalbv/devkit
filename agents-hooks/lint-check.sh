#!/bin/bash
# Stop hook QA — when the agent stops, run biome + structure-lint + typecheck and block the
# stop (exit 2 + stderr) on any failure, re-invoking the agent to fix it. SESSION-SCOPED:
# only errors in files this session edited are reported (see session-edits-lib.sh) — a
# parallel session's breakage never blocks this one. The commit gate stays repo-wide.
#
# Portable (W-3): runs the consumer's OWN npm-scripts (biome via local binary; `lint:structure`
# + `ts:check` via package.json scripts). Each step DEGRADE-SKIPS when its tool/script is
# absent — a repo without an eslint structure preset, or without a typecheck script, simply
# runs fewer checks rather than erroring. No frink-specific paths.

input=$(cat)

# Loop guard: don't block a stop we ourselves re-invoked.
echo "$input" | grep -q '"stop_hook_active":[[:space:]]*true' && exit 0

# Absolute hook dir BEFORE cd — a relative $0 would dangle after the chdir.
HOOK_DIR=$(cd "$(dirname "$0")" 2>/dev/null && pwd)
cd "${CLAUDE_PROJECT_DIR:-$HOOK_DIR/../..}" 2>/dev/null || exit 0

# Session scoping — only report errors for files THIS session edited (ledger written by
# format-after-edit.sh; see session-edits-lib.sh). Missing lib (sync-hooks --only) or no
# session edits → FAIL-OPEN: a session that edited nothing is never blocked at stop.
# The commit/ship gate chain stays repo-wide.
source "$HOOK_DIR/session-edits-lib.sh" 2>/dev/null || true
type session_edits_file &>/dev/null || { echo '{}'; exit 0; }
LEDGER=$(clean_session_ledger "$(session_edits_file "$input")")
[ -n "$LEDGER" ] || { echo '{}'; exit 0; }
trap 'rm -f "$LEDGER"' EXIT

command -v bun &>/dev/null || exit 0
[ -f "package.json" ] || exit 0

# Does package.json define a given npm-script? (degrade-skip guard.) bun -e, not node — this hook
# requires only bun (line 17), so a node probe silently skips in a bun-only toolchain.
has_script() { bun -e "process.exit(((require('./package.json').scripts||{})['$1'])?0:1)" 2>/dev/null; }

truncate() { if [ ${#1} -gt 1500 ]; then echo "${1:0:1500}... (truncated)"; else echo "$1"; fi; }

# 1. Biome check (no --write) — only if the local binary is present. Scoped to the session's
# own edited files (biome-supported extensions only), not the whole repo.
if [ -x "./node_modules/.bin/biome" ]; then
  biome_files=()
  while IFS= read -r f; do
    [[ "$f" =~ \.(ts|tsx|js|jsx|json|jsonc)$ ]] && biome_files+=("$f")
  done < "$LEDGER"
  if [ ${#biome_files[@]} -gt 0 ]; then
    lint_output=$(bun run biome check --no-errors-on-unmatched "${biome_files[@]}" 2>&1)
    if [ $? -ne 0 ]; then
      echo "Biome lint/format errors detected in files you edited. Please fix these issues:" >&2
      echo "" >&2
      truncate "$lint_output" >&2
      echo "" >&2
      echo "Run 'bun run biome check --write <file>' to auto-fix." >&2
      exit 2
    fi
  fi
fi

# 2. Structure/size ESLint — only if the consumer defines a `lint:structure` script.
# Project-wide tool → run whole-repo, then filter the report to this session's files.
if has_script "lint:structure"; then
  structure_output=$(bun run lint:structure 2>&1)
  if [ $? -ne 0 ]; then
    structure_output=$(printf '%s\n' "$structure_output" | filter_output_to_session_files "$LEDGER")
    if [ -n "$structure_output" ]; then
      echo "ESLint violations detected in files you edited. Please fix these issues:" >&2
      echo "" >&2
      truncate "$structure_output" >&2
      echo "" >&2
      echo "Fix file placement, split file/function, or add a file-level disable (see eslint.config.mjs)." >&2
      echo "(Scoped to your session's edits — 'bun run lint:structure' shows the repo-wide view.)" >&2
      exit 2
    fi
  fi
fi

# 3. TypeScript typecheck — only if the consumer defines a `ts:check` script.
# Project-wide tool → run whole-repo, then filter the report to this session's files.
if has_script "ts:check"; then
  typecheck_output=$(bun run ts:check 2>&1)
  if [ $? -ne 0 ]; then
    typecheck_output=$(printf '%s\n' "$typecheck_output" | filter_output_to_session_files "$LEDGER")
    if [ -n "$typecheck_output" ]; then
      echo "TypeScript type errors detected in files you edited. Please fix these issues:" >&2
      echo "" >&2
      truncate "$typecheck_output" >&2
      echo "" >&2
      echo "These are type errors that Biome doesn't catch but will break at build time." >&2
      echo "(Scoped to your session's edits — 'bun run ts:check' shows the repo-wide view.)" >&2
      exit 2
    fi
  fi
fi

echo '{}'
exit 0
