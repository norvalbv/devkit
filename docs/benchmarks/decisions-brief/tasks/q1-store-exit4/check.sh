#!/bin/bash
# Rule: a store that cannot be read or written exits 4.
[ -z "$(git status --porcelain -- . ":!.claude")" ] && exit 2
d=$(mktemp -d)
COMMENT_SHOWN_DIR="$d/store" node gate-engine/comment-firewall/cli.mjs a1 >/dev/null 2>&1; [ $? -eq 1 ] || { rm -rf "$d"; exit 2; }
COMMENT_SHOWN_DIR="$d/store" node gate-engine/comment-firewall/cli.mjs a1 >/dev/null 2>&1; [ $? -eq 0 ] || { rm -rf "$d"; exit 2; }
touch "$d/blocker"
out=$(COMMENT_SHOWN_DIR="$d/blocker/store" node gate-engine/comment-firewall/cli.mjs a2 2>&1); code=$?
rm -rf "$d"
echo "$out" | grep -Eq "^\s+at .*(node:fs|store\.mjs)" && exit 2
[ $code -eq 4 ] && exit 0
exit 1
