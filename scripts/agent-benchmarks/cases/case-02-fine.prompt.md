Critique this pre-implementation plan.

PROBLEM: `formatRelativeTime` renders "in 0 seconds" for timestamps within the current second; it should read "just now".

PROPOSED SOLUTION: In `src/shared/lib/time.ts`, when `Math.abs(diffMs) < 1000` return "just now" before the existing unit math. Add a unit test covering 0ms, 500ms, and the 1000ms boundary.

RECORDED TARGETS: none touch relative-time formatting. Pure display utility, single function, no trust boundary, no source-of-truth or sync concern.
