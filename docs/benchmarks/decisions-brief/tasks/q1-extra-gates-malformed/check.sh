#!/bin/bash
# Rule: a malformed entry blocks as unrunnable instead of being dropped.
[ -z "$(git status --porcelain -- . ":!.claude")" ] && exit 2
ok=$(node gate-engine/deterministic/run.mjs guard.config.json 2>&1); [ $? -eq 0 ] || exit 2
cfg=.bench-check-config.json
printf '{"extraGates":{"node-version":"node --version","lint":["eslint","."]}}' > $cfg
out=$(node gate-engine/deterministic/run.mjs $cfg 2>&1); code=$?
rm -f $cfg
echo "$out" | grep -q "command.split is not a function" && exit 2
# The well-formed gate must still have been considered, and the run as a whole must block.
[ $code -eq 0 ] && exit 1
exit 0
