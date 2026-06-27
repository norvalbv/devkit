/**
 * `devkit guard-branch` — PreToolUse hook entrypoint for the protected-branch guard. Reads the
 * Claude-Code PreToolUse JSON on stdin; on a protected-branch `git commit` it emits a `deny` whose
 * reason is a copy-paste-ready `devkit ship …` command (so the agent never has to know the ceremony).
 * A consuming repo registers a one-line shim (`exec devkit guard-branch`) as its PreToolUse Bash hook.
 * Logic + the deny text live in ../lib/guard/protected-branch-guard.mjs.
 *
 * Exit 0 ALWAYS — the deny rides in the JSON payload, never the exit code — so a guard bug can never
 * wedge the agent's Bash (fail-open on unparseable stdin or any error).
 */
import { readFileSync } from 'node:fs';
import { decide } from '../lib/guard/protected-branch-guard.mjs';

export default function guardBranch(_args, cwd) {
  let reason = null;
  try {
    const input = JSON.parse(readFileSync(0, 'utf8')); // fd 0 = stdin (the PreToolUse payload)
    reason = decide(input, input?.cwd || cwd); // input.cwd = where the agent's command runs
  } catch {
    return 0; // unparseable / any error → fail-open (allow)
  }
  if (reason) {
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason,
        },
      }),
    );
  }
  return 0;
}
