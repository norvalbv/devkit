#!/bin/bash
# Rule: NO exit 1 and NO fail-closed on outage — an advisor's own failure must never block.
[ -z "$(git status --porcelain -- . ":!.claude")" ] && exit 2
bin=$(mktemp -d); mkdir -p .qavis; made=0; [ -f .qavis/recipe.json ] || { echo '{}' > .qavis/recipe.json; made=1; }
cleanup() { rm -rf "$bin"; [ $made -eq 1 ] && rm -rf .qavis; }
fake() { printf '#!/bin/bash\n%s\n' "$1" > "$bin/qavis"; chmod +x "$bin/qavis"; }
fake 'echo "{\"advise\":true,\"reason\":\"ui change\"}"'
GUARD_AI_STRICT=1 PATH="$bin:$PATH" node gate-engine/qavis-advisory/run.mjs >/dev/null 2>&1; [ $? -eq 3 ] || { cleanup; exit 2; }
fake 'echo "{\"advise\":false}"'
PATH="$bin:$PATH" node gate-engine/qavis-advisory/run.mjs >/dev/null 2>&1; [ $? -eq 0 ] || { cleanup; exit 2; }
fake 'echo "503 Service Unavailable"; exit 2'
out=$(GUARD_AI_STRICT=1 PATH="$bin:$PATH" node gate-engine/qavis-advisory/run.mjs 2>&1); code=$?
cleanup
echo "$out" | grep -q "SyntaxError" && exit 2
[ $code -eq 0 ] && exit 0
exit 1
