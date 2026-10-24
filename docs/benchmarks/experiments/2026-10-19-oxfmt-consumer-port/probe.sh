#!/bin/bash
# One-time sc-2687 probe: format each consumer's COMMITTED tree with devkit's pinned Oxfmt and the
# consumer starter, through the pre-commit step's explicit-path form, and report the churn.
# Usage: probe.sh <devkit checkout> <consumer repo>...
set -euo pipefail
devkit=$(cd "$1" && pwd); shift
oxfmt="$devkit/node_modules/.bin/oxfmt"
ext='\.(tsx?|jsx?|mts|cts|mjs|css|jsonc?)$'
for repo in "$@"; do
  name=$(basename "$repo"); dir=$(mktemp -d)
  git -C "$repo" archive HEAD | tar -x -C "$dir"
  ( cd "$dir"
    git init -q && git add -A && git -c user.email=p@p -c user.name=p commit -qm base
    cp "$devkit/oxc/oxfmtrc.starter.json" .oxfmtrc.json
    files=$(git ls-files -z | tr '\0' '\n' | grep -E "$ext" || true)
    total=$(printf '%s\n' "$files" | grep -c . || true)
    printf '%s\n' "$files" | tr '\n' '\0' | xargs -0 "$oxfmt" --no-error-on-unmatched-pattern --write >/dev/null 2>&1 || true
    changed=$(git diff --name-only -- . ':!.oxfmtrc.json' | wc -l | tr -d ' ')
    hunks=$(git diff -U0 -- . ':!.oxfmtrc.json' | grep -c '^@@' || true)
    css=$(git diff --name-only -- '*.css' | wc -l | tr -d ' ')
    git add -A && git -c user.email=p@p -c user.name=p commit -qm pass1 --allow-empty
    printf '%s\n' "$files" | tr '\n' '\0' | xargs -0 "$oxfmt" --no-error-on-unmatched-pattern --write >/dev/null 2>&1 || true
    pass2=$(git diff --name-only | wc -l | tr -d ' ')
    other=$("$oxfmt" --list-different . 2>/dev/null | grep -Ev "$ext" | sed -E 's/.*\.//' | sort | uniq -c | tr '\n' ' ' || true)
    echo "$name: formattable=$total changed=$changed hunks=$hunks css_changed=$css pass2_changed=$pass2 bare_run_other_ext=[${other}]"
  )
  rm -rf "$dir"
done
