---
slug: blocking-gates-narrate-attribution-never-depend-on-it
created: 2026-08-29
---

# blocking-gates-narrate-attribution-never-depend-on-it

## Target · 2026-08-29 — A blocking gate may narrate blame; the narration can never change the verdict

**Context:** sc-2198. On 2026-08-27 devkit's main was red for 5h15m — a hook generator edit that was never regenerated into the committed .husky/pre-commit, plus a stale decisions INDEX row. A developer pushing an unrelated two-file change hit the pre-push suite, saw five failures in files they had never touched, concluded the suite was flaky, and pushed with --no-verify. The block was correct and every failure was a real committed defect. What was missing was any way to tell 'I broke this' from 'main is red' — and that gap turns a correct block into a bypassed one, which then carries a genuinely red tree past the only local gate.
**Ruling:** A blocking gate MAY narrate whose fault a failure is, but the narration must be structurally incapable of changing the verdict: it runs only after the exit code is captured, is invoked through an errexit-suppressing OR-list, contains no exit, and returns non-zero while printing nothing on every unhappy path. The authoritative command keeps zero added flags, zero redirection and zero pipes. A degraded attribution is silence, never a guess. At pre-push the base is merge-base(HEAD, the remote_oid git supplies on stdin) and the output names that sha, never a branch name.
**Consequences:**
- Positive: A correct block stops reading as flake, so the --no-verify reflex loses its justification. The green path is provably unchanged — two shell-builtin assignments and one comparison — so nothing here can redden a passing suite.
- Negative: The developer still runs the base suite themselves: the output is a copy-pasteable command, not an answer. Automatically running it was measured at 11+ minutes and would double the wait of someone already blocked. The CI fast path is inert today because devkit's own gate workflow fails on every main commit (report 62314729 / sc-1896), so only its success arm is acted on.
**Vision-fit:** n/a - internal tooling; this is how devkit keeps its own gates trusted enough to stay switched on.
**Researched:** cli/lib/husky/pre-push-validation.sh (run_checks, the sc-1508 ship-sha skip, the tag worktree path); docs/decisions/fail-open-needs-an-errexit-safe-call.md for the OR-list errexit semantics that make the || return guards mandatory rather than stylistic; gate-engine/ratchets/folder-fanout.mts:203-223 for the existing blame-the-change output shape; 10 of 10 recent gate.yml runs on main concluding failure.
**Rejected:** (a) --reporter=json on the authoritative run - REJECTED: a green-to-red channel on the one command that must not change. (b) tee/pipe capture - REJECTED: de-TTYs vitest on the green path, so 'only the narration changes' would be false. (c) parsing the pretty reporter - REJECTED: fragile, and only needed by an intersection framing this ruling drops. (d) automatically re-running the suite at the base - REJECTED: 11+ minutes, doubling an already-blocked wait. (e) acting on a CI 'failure' verdict at the base - REJECTED: devkit's gate is red on every main commit, so that line would fire on 100% of pushes and become a standing excuse to --no-verify.
**Anchored-bet:** [BET]
**Revisit-when:** gate.yml goes green on main, at which point the CI failure arm becomes informative and should be reconsidered.
**Scope:** cli/lib/husky/pre-push-validation.sh
**Source:** collab
