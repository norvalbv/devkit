#!/bin/bash
# Stop hook QA — when the agent stops, run biome + structure-lint + typecheck over the repo
# and block the stop (exit 2 + stderr) on any failure, re-invoking the agent to fix it.
#
# Portable (W-3): runs the consumer's OWN npm-scripts (biome via local binary; `lint:structure`
# + `ts:check` via package.json scripts). Each step DEGRADE-SKIPS when its tool/script is
# absent — a repo without an eslint structure preset, or without a typecheck script, simply
# runs fewer checks rather than erroring. No frink-specific paths.

input=$(cat)

# Loop guard: don't block a stop we ourselves re-invoked.
echo "$input" | grep -q '"stop_hook_active":\s*true' && exit 0

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}" 2>/dev/null || exit 0

command -v bun &>/dev/null || exit 0
[ -f "package.json" ] || exit 0

# Does package.json define a given npm-script? (degrade-skip guard.) bun -e, not node — this hook
# requires only bun (line 17), so a node probe silently skips in a bun-only toolchain.
has_script() { bun -e "process.exit(((require('./package.json').scripts||{})['$1'])?0:1)" 2>/dev/null; }

truncate() { if [ ${#1} -gt 1500 ]; then echo "${1:0:1500}... (truncated)"; else echo "$1"; fi; }

# 1. Biome check (no --write) — only if the local binary is present.
if [ -x "./node_modules/.bin/biome" ]; then
  lint_output=$(bun run biome check --no-errors-on-unmatched . 2>&1)
  if [ $? -ne 0 ]; then
    echo "Biome lint/format errors detected. Please fix these issues:" >&2
    echo "" >&2
    truncate "$lint_output" >&2
    echo "" >&2
    echo "Run 'bun run biome check --write .' to auto-fix." >&2
    exit 2
  fi
fi

# 2. Structure/size ESLint — only if the consumer defines a `lint:structure` script.
if has_script "lint:structure"; then
  structure_output=$(bun run lint:structure 2>&1)
  if [ $? -ne 0 ]; then
    echo "ESLint violations detected. Please fix these issues:" >&2
    echo "" >&2
    truncate "$structure_output" >&2
    echo "" >&2
    echo "Fix file placement, split file/function, or add a file-level disable (see eslint.config.mjs)." >&2
    exit 2
  fi
fi

# 3. TypeScript typecheck — only if the consumer defines a `ts:check` script.
if has_script "ts:check"; then
  typecheck_output=$(bun run ts:check 2>&1)
  if [ $? -ne 0 ]; then
    echo "TypeScript type errors detected. Please fix these issues:" >&2
    echo "" >&2
    truncate "$typecheck_output" >&2
    echo "" >&2
    echo "These are type errors that Biome doesn't catch but will break at build time." >&2
    exit 2
  fi
fi

echo '{}'
exit 0
