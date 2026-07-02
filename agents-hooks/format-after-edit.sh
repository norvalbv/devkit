#!/bin/bash
# PostToolUse hook (Edit|Write|MultiEdit) — format + lint the just-edited file.
#   1. Biome `check --write` auto-fixes formatting/lint on the single edited file.
#   2. ESLint surfaces structure/size violations EARLY (before pre-commit blocks). A
#      non-zero ESLint exit + stderr + exit 2 feeds the message back into the conversation.
#
# Portable (W-3): the ESLint gate only applies to files under the consumer's configured
# scanRoots (resolveGuardConfig). No hardcoded src/socket-server/vercel paths. Biome + ESLint
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

cd "${CLAUDE_PROJECT_DIR:-$(pwd)}" 2>/dev/null || { echo '{}'; exit 0; }

# Biome format/lint auto-fix on the edited file (silent, best-effort).
if [[ "$file_path" =~ \.(ts|tsx|js|jsx|json|jsonc)$ ]]; then
  if command -v bun &>/dev/null && [ -f "package.json" ] && [ -x "./node_modules/.bin/biome" ]; then
    bun run biome check --write "$file_path" 2>/dev/null || true
  fi
fi

# ESLint structure/size check — scoped to the consumer's configured scanRoots. Resolve them
# from guard.config.json via the devkit config loader; skip the whole step if unresolvable.
if [[ "$file_path" =~ \.(tsx?|css)$ ]] && [ -x "./node_modules/.bin/eslint" ]; then
  RESOLVER='import("@norvalbv/devkit/gate-engine/config").then(m=>{const r=m.resolveGuardConfig();process.stdout.write((r.scanRoots||[]).join("\n"))}).catch(()=>process.exit(1))'
  scan_roots=$(node --input-type=module -e "$RESOLVER" 2>/dev/null)
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
