#!/usr/bin/env bash
# Re-judges two real correctness misses N times each, one fresh lens call per run, and scores hits.
# usage: probe.sh <devkit checkout> [runs per probe, default 20]
set -euo pipefail

WT=$(cd "$1" && pwd -P)
RUNS=${2:-20}
S=${PROBE_DIR:-/tmp/sc4699}
BASE=d23f297d # main when both incidents were shipped (devkit v0.67.1)

# The Claude judge family, the codebase MCP absent (DEGRADED, as in both incidents), and a scratch
# telemetry sink so no probe row reaches ~/.devkit/telemetry.
export GUARD_REVIEW_MODEL=haiku GUARD_REVIEW_ESCALATION_MODEL=opus
export GUARD_CORRECTNESS_MODEL=${PROBE_MODEL:-claude-haiku-5-5} GUARD_CORRECTNESS_CHUNK=off
export DEVKIT_JUDGE_MCP_CONFIG="$S/no-such-mcp.json"

tree() { # <name> <commit>: a scratch clone at BASE with <commit>'s tree staged
  rm -rf "${S:?}/$1"
  git clone -q --shared "$WT" "$S/$1"
  git -C "$S/$1" checkout -q "$BASE"
  git -C "$S/$1" checkout "$2" -- .
}

build() {
  mkdir -p "$S"
  # P1: PR #826 as judged on ship attempt 2: detect.mts main() drops runGate()'s promise.
  tree p1 eb7d9cef
  sed -i.bak \
    -e 's/^export function main(\[cmd, ...rest\]: string\[\]): Promise<void> | void {/export function main([cmd, ...rest]: string[]): void {/' \
    -e "s/  if (cmd === '--gate') return runGate();/  if (cmd === '--gate') runGate();/" \
    "$S/p1/gate-engine/decisions/detect.mts"
  rm "$S/p1/gate-engine/decisions/detect.mts.bak"
  git -C "$S/p1" add -A
  # P2: PR #824 exactly as shipped at 1be5551e: a renamed file's old blob lexed by the new extension.
  tree p2 1be5551e
  # Controls: the fixed trees.
  tree p1-control eb7d9cef
  tree p2-control 414bc4ff
}

judge() { # <tree> <lens> <out dir>
  mkdir -p "$3"
  rm -f "$S/$1/.devkit/review-cache.json" "$S/$1/.devkit/prefix-cache.json"
  (cd "$S/$1" && DEVKIT_GATE_EVENTS="$3/events.jsonl" \
    node "$WT/gate-engine/review/cli.mts" lens "correctness-reviewer:$2" >"$3/out.log" 2>&1) || true
}

# A hit is a FAIL citing a defect file and naming the defect; a run with no verdict is an error.
score() { # <out.log> <file regex> <defect regex>
  grep -q "\] — \(PASS\|FAIL\)" "$1" 2>/dev/null || { echo error; return; }
  grep -q "\] — FAIL" "$1" && grep -Eq "$2" "$1" && grep -Eiq "$3" "$1" && echo hit || echo miss
}
P1_SITE='decisions/(detect|cli)\.mts:[0-9]'
P1_DEFECT='promise|await|undefined|runGate'
P2_SITE='comment-firewall/detect\.mts:[0-9]'
P2_DEFECT='extension|rename|\.tsx|lex'

loop() { # <tree> <lens> <site> <defect>
  for i in $(seq 1 "$RUNS"); do
    d="$S/runs/$1/$i"
    judge "$1" "$2" "$d"
    echo "$1 $i $(score "$d/out.log" "$3" "$4") $(grep -o '\] — [A-Z]*[^$]*in [0-9]*s' "$d/out.log" | head -1)"
  done
}

for t in p1 p2 p1-control p2-control; do [ -d "$S/$t" ] || { build; break; }; done
judge p1-control writer-reader-contracts "$S/runs/p1-control"
judge p2-control error-and-edge-classification "$S/runs/p2-control"
loop p1 writer-reader-contracts "$P1_SITE" "$P1_DEFECT" >"$S/p1.tsv" &
loop p2 error-and-edge-classification "$P2_SITE" "$P2_DEFECT" >"$S/p2.tsv" &
wait
for p in p1 p2; do
  echo "$p: $(grep -c ' hit ' "$S/$p.tsv")/$RUNS hits, $(grep -c ' error ' "$S/$p.tsv") errors"
done
