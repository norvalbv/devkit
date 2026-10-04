# Advisory investigation trigger (prototype)

Set `GUARD_PRIOR_ART=1` when running the existing `guard-review --gate` commit gate.
With the flag absent, there is no scan or additional judge. `GUARD_NO_REVIEW` and
`noLlm` disable it; single-lens rechecks do not invoke it.

The trigger examines staged files with the consumer's `sourceExtensions`:

- Added lines containing retry, reopen, restart, fallback, or recovery (including
  identifier substrings) start an investigation. Comments can trigger it too.
- Three or more `fix:` / `fix(scope):` commits (nonempty, whitespace-free scope) touching the exact staged path among
  the latest twelve commits also qualify when their recency score reaches two.
  Each contributes `(12 - position) / 12`, newest position zero. These initial
  thresholds are uncalibrated; this signal identifies a research opportunity.

One prior-art invocation investigates the underlying problem. It defaults to opus
(`GUARD_PRIOR_ART_MODEL` overrides), waits at most 120 seconds before the ordinary
reviewers, and has read/web builtins plus the existing trusted named-agent MCP
profile. Bash is not granted; unavailable
research legs must remain unavailable. Codex model overrides inherit the shared
adapter's disabled web search. The existing response contract validates the
result. Only SOLVED_ELSEWHERE or DISSOLVE_FRAME prints an advisory alternative with
triggering paths/commits and evidence sources. A signal, negative result, malformed
response, or outage cannot block the commit. The review gate's repository-integrity
checks still apply.

An actionable result also prints the full `devkit subtraction-trial` command
template. Candidate/control refs and the unchanged test oracle still need explicit
preparation; the investigation never runs a trial automatically.

At most 100 staged source files and 128 KiB of total diff evidence are admitted.
Diff/history subprocesses have ten-second deadlines and bounded output. Scope/input failures skip
the investigation; they do not assert the frame is sound.

Attempts are recorded before spawning through the existing bounded shared store,
in `.devkit/prior-art-attempts.json`. An unchanged evidence/agent/model fingerprint
does not run again while retained, even after an outage. A changed fingerprint permits a new
attempt. Claiming is serialized with the existing store lock before spawning, so
concurrent identical attempts also run only once. This is an attempt budget, not a
success cache. Store retention or deliberately removing that file resets the budget.

`prior_art_trigger` telemetry records no-signal, attempted, already-attempted,
budget-unavailable, unavailable and invalid outcomes. Judge runs retain label
`prior-art` on the existing `judge_exec` stream. Non-actionable verdicts stay out of
terminal output, but the shared judge runner still prints its usual warning when the
judge times out or is unavailable. Absence of an advisory is not proof of necessity.

This opt-in commit-time mechanism does not cover work before its first staged
change, dependency-error attribution, or non-conventional fix messages. The history
window is the repository's latest 12 commits, not the last 12 that touched a path,
so on a squash-merged branch the fix-chain signal rarely fires and the lexical
signal does most of the work. Signal recall, usefulness, latency and spend require
later evaluation; no benchmark was run to choose these thresholds.
