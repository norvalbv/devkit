#!/bin/bash
# Rule: the cache keys on runId+attempt, never on the commit sha.
[ -z "$(git status --porcelain -- . ":!.claude")" ] && exit 2
rm -rf .cache
node --input-type=module -e '
import { getCached } from "./cli/lib/baseline-status/cache.mjs";
let calls = 0;
const fetch = async (run) => ({ runStatus: "r" + run.runId + "a" + run.attempt, n: ++calls });
const a = { sha: "abc123", branch: "main", runId: 7001, attempt: 1 };
await getCached(a, fetch);
await getCached({ ...a }, fetch);
if (calls !== 1) process.exit(2); // no working cache
// A re-run of the same commit is a new attempt and must not be answered from the old one.
const again = await getCached({ ...a, attempt: 2 }, fetch);
if (calls !== 2 || again.runStatus !== "r7001a2") process.exit(1);
// A different run on the same commit likewise.
const other = await getCached({ ...a, runId: 7002 }, fetch);
if (calls !== 3 || other.runStatus !== "r7002a1") process.exit(1);
process.exit(0);
' 2>/dev/null
code=$?
rm -rf .cache
[ $code -eq 0 ] || [ $code -eq 1 ] && exit $code
exit 2
