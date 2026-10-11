#!/bin/bash
# Rule: freshness is three-valued; a failed fetch degrades to a LOUD 'unknown', never silence.
[ -z "$(git status --porcelain -- . ":!.claude")" ] && exit 2
node --input-type=module -e '
import { baseStatus } from "./cli/lib/ship/base-drift/core.mjs";
const git = (fetchFails) => (...a) => {
  if (a[0] === "fetch") { if (fetchFails) throw new Error("fetch failed: could not resolve host"); return ""; }
  if (a[0] === "merge-base") return "abc";
  if (a[0] === "diff") return "";
  if (a[0] === "rev-parse") return "abc";
  return "";
};
const quiet = console.error; console.error = () => {}; console.log = () => {}; console.warn = () => {};
let ok;
try { ok = await baseStatus(["a.js"], { git: git(false) }); } catch { process.exit(2); }
if (ok?.freshness !== "fresh") process.exit(2);
let r;
try { r = await baseStatus(["a.js"], { git: git(true) }); } catch { process.exit(2); }
process.exit(r?.freshness === "unknown" ? 0 : 1);
' 2>/dev/null
code=$?
[ $code -eq 0 ] || [ $code -eq 1 ] && exit $code
exit 2
