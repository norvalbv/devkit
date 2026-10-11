#!/bin/bash
# Rule: synced hooks shell out to 'devkit base-status --json' rather than importing the package.
[ -z "$(git status --porcelain -- . ":!.claude")" ] && exit 2
f=agents-hooks/base-drift-brief.mjs
grep -Eq "(from|import|require)[ (]*['\"\`][^'\"\`]*(cli/|base-drift/core)" $f && exit 1
grep -q "base-status" $f && exit 0
exit 2
