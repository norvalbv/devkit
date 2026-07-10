#!/bin/bash
# PostToolUse hook (Edit|Write|MultiEdit) — format + lint the just-edited file.
#   1. Biome `check --write` auto-fixes formatting/lint on the single edited file.
#   2. ESLint surfaces structure/size violations EARLY (before pre-commit blocks). A
#      non-zero ESLint exit + stderr + exit 2 feeds the message back into the conversation.
#
# Portable (W-3): the ESLint gate only applies to files under the consumer's configured
# scanRoots (from guard.config.json). No hardcoded src/socket-server/vercel paths. Biome + ESLint
# are run via the consumer's own local binaries; each step degrade-skips when its tool/config
# is absent (a repo without eslint, or without a scanRoot match, is never blocked).

input=$(cat)

file_path=$(echo "$input" | grep -o '"file_path":"[^"]*"' | head -1 | sed 's/"file_path":"//;s/"$//')

if [ -z "$file_path" ] || [ ! -f "$file_path" ]; then
  echo '{}'
  exit 0
fi

# Only act on files INSIDE this project. An agent may edit a sibling checkout (e.g. another repo it
# is working on in the same session) whose files live outside CLAUDE_PROJECT_DIR and have their own
# toolchain — running THIS repo's biome/eslint on them errors (eslint resolves its config from the
# edited file's own tree, not cwd) and spams the conversation. That repo runs its own hooks.
if [ -n "$CLAUDE_PROJECT_DIR" ] && [[ "$file_path" != "$CLAUDE_PROJECT_DIR"/* ]]; then
  echo '{}'
  exit 0
fi

# Absolute hook dir BEFORE cd — a relative $0 would dangle after the chdir.
HOOK_DIR=$(cd "$(dirname "$0")" 2>/dev/null && pwd)
cd "${CLAUDE_PROJECT_DIR:-$HOOK_DIR/../..}" 2>/dev/null || { echo '{}'; exit 0; }

# Record this edit in the per-session ledger (repo-relative path) so the Stop hooks
# (lint-check/knip-check/decision-stop-check) can scope their reports to files THIS session
# touched. Best-effort: a missing lib (sync-hooks --only) or unwritable $TMPDIR never blocks.
# Strip the prefix from the same UNRESOLVED root the guard above compared against — `pwd -P`
# would resolve symlinks (/tmp → /private/tmp) and the strip would silently miss.
source "$HOOK_DIR/session-edits-lib.sh" 2>/dev/null || true
if type session_edits_file &>/dev/null; then
  rel_path="${file_path#"${CLAUDE_PROJECT_DIR:-$(pwd)}"/}"
  if [ -n "$rel_path" ] && [ "$rel_path" != "$file_path" ]; then
    ledger=$(session_edits_file "$input")
    mkdir -p "$(dirname "$ledger")" 2>/dev/null &&
      printf '%s\n' "$rel_path" >> "$ledger" 2>/dev/null || true
  fi
fi

# Biome format/lint auto-fix on the edited file (silent, best-effort).
if [[ "$file_path" =~ \.(ts|tsx|js|jsx|json|jsonc)$ ]]; then
  if command -v bun &>/dev/null && [ -f "package.json" ] && [ -x "./node_modules/.bin/biome" ]; then
    bun run biome check --write "$file_path" 2>/dev/null || true
  fi
fi

# ESLint structure/size check — scoped to the consumer's configured scanRoots. Resolve them by
# parsing guard.config.json directly (repo root = cwd); NO package import, because under global-CLI
# consumption @norvalbv/devkit is not a node_modules dependency. Absent/corrupt config → skip.
if [[ "$file_path" =~ \.(tsx?|css)$ ]] && [ -x "./node_modules/.bin/eslint" ]; then
  RESOLVER='const fs=require("fs");try{const c=JSON.parse(fs.readFileSync("guard.config.json","utf8"));const r=Array.isArray(c&&c.scanRoots)?c.scanRoots:["src"];process.stdout.write(r.join("\n"))}catch(e){process.exit(1)}'
  # Resolve via whichever JS runtime exists — this block runs the eslint binary directly (not via
  # `bun run`), so it must not hard-require either bun or node. RESOLVER is plain CJS (runs in both).
  if command -v bun &>/dev/null; then
    scan_roots=$(bun -e "$RESOLVER" 2>/dev/null)
  else
    scan_roots=$(node -e "$RESOLVER" 2>/dev/null)
  fi
  in_scope=""
  if [ -n "$scan_roots" ]; then
    # Match the edited file against any configured scanRoot path segment.
    while IFS= read -r root; do
      [ -z "$root" ] && continue
      if [[ "$file_path" == *"/$root/"* ]] || [[ "$file_path" == "$root/"* ]] || [[ "$file_path" == *"/$root"* ]]; then
        in_scope="1"; break
      fi
    done <<< "$scan_roots"
  fi
  if [ -n "$in_scope" ]; then
    eslint_output=$(./node_modules/.bin/eslint "$file_path" 2>&1)
    if [ $? -ne 0 ]; then
      echo "ESLint violation in ${file_path}:" >&2
      echo "" >&2
      echo "$eslint_output" >&2
      echo "" >&2
      echo "Fix: relocate/rename file, split file/function, or add a file-level /* eslint-disable */." >&2
      exit 2
    fi
  fi
fi

echo '{}'
exit 0
