#!/bin/bash
# Rule: records without a category are reported under an explicit uncategorised heading, never
# silently bucketed (or dropped); the command always exits 0.
[ -z "$(git status --porcelain -- . ":!.claude")" ] && exit 2
out=$(node gate-engine/decisions/recall/cli.mjs categories 2>&1); code=$?
echo "$out" | grep -q "TypeError" && exit 2
[ $code -ne 0 ] && exit 1
node -e '
const out = process.argv[1].split("\n");
const known = ["decision-log","commit-gates","benchmarking","ship-pipeline","consumer-distribution","self-host-release"];
const explicit = /uncategori[sz]ed|no category|without (a )?category|missing category|not categori[sz]ed|unassigned/i;
for (const slug of ["published-tags-immutable", "synced-assets-layout"]) {
  const at = out.findIndex((l) => l.includes(slug));
  if (at < 0) process.exit(1); // dropped
  let h = at;
  while (h >= 0 && !/^\s*(#+|\*\*|[A-Za-z].*:\s*$)/.test(out[h])) h--;
  const heading = h >= 0 ? out[h] : "";
  if (!explicit.test(heading) && !explicit.test(out[at])) process.exit(1); // bucketed under something else
  if (known.some((k) => heading.includes(k))) process.exit(1);
}
for (const slug of ["coverage-gate", "bench-gates-on-flips", "decision-format-parsed"])
  if (!out.some((l) => l.includes(slug))) process.exit(2);
' "$out"
