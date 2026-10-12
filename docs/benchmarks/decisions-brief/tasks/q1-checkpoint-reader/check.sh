#!/bin/bash
# Rules: outage verdicts (NULL) are never replayed; the reader drops torn trailing lines instead of
# failing the load.
[ -z "$(git status --porcelain -- . ":!.claude")" ] && exit 2
node --input-type=module -e '
import { writeFileSync, rmSync } from "node:fs";
import { loadCheckpoint } from "./gate-engine/decisions/eval/checkpoint.mjs";
const key = { config: "haiku/K3/cascade", gateHash: "g1", corpusHash: "c1" };
const line = (k, row) => JSON.stringify({ ...k, ...row }) + "\n";
const f = ".bench-check-progress.jsonl";
const ids = (rows) => rows.map((r) => r.id).sort().join(",");
let code = 0;
try {
  writeFileSync(f, line(key, { id: "a", verdict: "DECISION", inputChars: 10 }) + line(key, { id: "b", verdict: "ROUTINE", inputChars: 20 }) + line({ ...key, gateHash: "OLD" }, { id: "c", verdict: "ROUTINE", inputChars: 5 }));
  let rows;
  try { rows = loadCheckpoint(f, key); } catch { process.exit(2); }
  if (!Array.isArray(rows) || ids(rows) !== "a,b") { code = 2; }
  else {
    // An outage row must be judged again, not replayed.
    writeFileSync(f, line(key, { id: "a", verdict: "DECISION", inputChars: 10 }) + line(key, { id: "o", verdict: null, inputChars: 30 }));
    if (ids(loadCheckpoint(f, key)) !== "a") code = 1;
    // A torn trailing line (interrupted write) must not fail the load.
    writeFileSync(f, line(key, { id: "a", verdict: "DECISION", inputChars: 10 }) + line(key, { id: "b", verdict: "ROUTINE", inputChars: 20 }).slice(0, 25));
    try { if (ids(loadCheckpoint(f, key)) !== "a") code = 1; } catch { code = 1; }
  }
} finally { rmSync(f, { force: true }); }
process.exit(code);
' 2>/dev/null
code=$?
[ $code -eq 0 ] || [ $code -eq 1 ] && exit $code
exit 2
