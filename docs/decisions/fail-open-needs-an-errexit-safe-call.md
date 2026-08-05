---
slug: fail-open-needs-an-errexit-safe-call
created: 2026-08-05
---

# fail-open-needs-an-errexit-safe-call

## Target · 2026-08-05 — A fail-open exit code is only real if its CALL SITE is errexit-safe

**Context:** sc-1366: a devkit ship in frink died after every deterministic and reviewer gate had passed. The vision gate hit an unreadable staged object and exited 2 (its documented fail-open); the commit was refused with 'husky - pre-commit script failed (code 2)'. Cause, measured directly: husky runs hooks via sh -e (.husky/_/h:17), and the call was written as a bare command with the status capture on the NEXT line. Under -e that aborts the hook with the gate's own status before the capture runs, so the branch meant to tolerate exit 2 is unreachable and the hook's own comment described behaviour the code could not reach. Eight such lines exist in that one consumer hook and nothing detected any of them.
**Ruling:** devkit GENERATES errexit-safe calls (every emitted gate line uses an OR-guarded capture), DETECTS unsafe hand-authored ones via a report-only devkit doctor check, and never rewrites them. The -e model is measured rather than assumed: OR-lists, leading negation, and if/while/until CONDITION lists suppress errexit; an if or case BODY, a subshell, a semicolon-joined pair, the right operand of AND, and a command-substitution assignment do not. The -e state itself is tri-state - in-force, not-in-force, or UNVERIFIABLE when husky's gitignored runner is unreadable - because reporting clean there would convert 'nobody has looked' into 'devkit says this is fine'.
**Consequences:**
- Positive: A consumer whose gate promised to fail open actually fails open, instead of hard-blocking a commit for a defect that does not exist. The check finds 8 of 8 real hazards in the reference hook with 0 false positives, and cites the line the command STARTS on so the fix is one edit.
- Negative: Report-only means the hazard survives until a human acts; doctor --fix cannot help, because these are hand-authored lines outside the managed block and fix only regenerates content from the recorded selection. The checker also over-reports AND-lists (safe only when the left operand is constantly false, which is not knowable statically) and cannot see a command inside a function body, which needs a call graph. Both are stated in its own output rather than guessed at.
**Vision-fit:** n/a - devkit gate-engine scoping. Consistent with devkit-gates-repo-not-harness: a husky hook in the consumer's repository IS the consumer's repository, and doctor already reads it.
**Scope:** cli/lib/doctor/unguarded-gate-calls.mts,cli/lib/doctor/hook-gate-scan.mts,gate-engine/judge/odb-probe.mts
**Source:** manual
