---
slug: judge-verdict-cache-scope
created: 2026-08-07
---

# judge-verdict-cache-scope

## Target · 2026-08-07 — A judge's PASS is cached at the altitude of the question that judge answers

**Context:** The completeness gate is straight opus (mean 263s, max 1803s over 198 calls, 1-6 Aug) and its PASS was keyed on the exact staged bytes, so ANY retry re-judged from scratch. Ship telemetry shows ~4.5 attempts land one ship and 143 of 150 review-gate runs recorded cache_state=none, so a single landed change paid the gap-finder up to five times over for a claim that never changed once. It was the largest single opus line item in the gate chain (~14h of opus in six days) and the cost was pure repetition: the reviewer whose finding forced the retry was never completeness.
**Ruling:** A confident PASS is cached at the altitude of the question the judge answers, not uniformly on the evidence bytes. Completeness judges the commit MESSAGE's claims against what the change delivers, so its PASS is additionally keyed on branch + normalised message + reviewer brief (version-salted), beside the byte-exact key. A retry that reshapes the diff to satisfy a DIFFERENT reviewer, on the same branch under the same message, is not re-judged. A FAIL is never sticky. Message normalisation mirrors git --cleanup=whitespace so the ship's composed temp file and git's COMMIT_EDITMSG compute one identical key across the two hooks.
**Consequences:**
- Positive: Opus completeness is paid once per branch+message across an entire retry chain instead of once per attempt, so the gap-finder's cost stops scaling with how many times an unrelated reviewer blocks the commit.
- Negative: A retry that GUTS claimed functionality while keeping the same commit message is not re-caught on that branch: the message is the only guard. Byte-exact re-judging would catch it and we knowingly gave that up. Amending the message, switching branch, or editing the brief re-opens the gate, and a FAIL always re-judges.
**Vision-fit:** n/a — internal tooling (devkit gate chain).
**Researched:** Measured from ~/.devkit/telemetry/gate-events.jsonl: per-gate makespan (review 260s mean vs deterministic 11s), 198 completeness judge_exec rows 1-6 Aug, cache_state distribution across 150 review-gate runs, and 468 ship attempts against 103 successes.
**Rejected:** (a) Keep byte-exact keying — SAFE but it IS the status quo whose cost forced this: every retry re-pays ~4min of opus for an unchanged claim. (b) Key on the diff minus the failing reviewer's files — UNSOUND: a fix routinely edits files outside that reviewer's domain, so the key still churns while quietly dropping real changes out of the judgement. (c) Run completeness only on the final attempt — IMPOSSIBLE: which attempt is final is unknowable in advance, and a blocked attempt is exactly when a gap-finder earns its keep.
**Anchored-bet:** [BET]
**Revisit-when:** A same-message retry is observed shipping a gap completeness had already passed, or per-judge cost instrumentation (sc-1527) shows completeness is no longer a material share of ship spend.
**Scope:** gate-engine/review/completeness.mts
**Source:** collab · PR #360
