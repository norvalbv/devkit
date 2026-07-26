---
slug: bench-runs-resume-from-checkpoint
created: 2026-07-26
---

# bench-runs-resume-from-checkpoint

## Target · 2026-07-26 — Long judge-bench runs checkpoint every completed row and resume

**Context:** The decisions judge bench is ~150 min of `claude -p` cold starts (~250 invocations against the subscription). It aborted FOUR times on consecutive nights — three at ~3am beside a usage limit, once at row 20 of 37 — and each abort discarded every row already paid for, so no judge baseline has EVER been produced. The abort itself is correct (a dark judge must not score as a wrong answer); the loss of completed work is what made the suite unrunnable.
**Ruling:** Every completed row is appended to a gitignored progress-<sub>.jsonl the moment it lands, and re-running the SAME command replays those rows for free. A row is replayed only when config (model/K/cascade) AND gateHash AND corpusHash all match, so a stale checkpoint is inert rather than quietly blending two measurements; outage verdicts (NULL) are never replayed. Cost and stability aggregates are derived from the ROWS (per-row inputChars/rawChars/judged/outage) rather than counters incremented in the loop, so a resumed run reports what the whole run cost. The reader drops torn trailing lines instead of failing the load. --fresh discards and re-measures.
**Consequences:**
- Positive: The suite can actually finish: an abort at minute 140 now costs the remainder, not all 140 again, and an operator loop can retry unattended. Without this the judge half of the decisions benchmark is unmeasurable on a subscription.
- Negative: A resumed run's rows are judged at different wall-clock times, so a mid-run model-side change is invisible; the hash triple bounds that to config/corpus/gate identity, not provider drift. Progress files are local scratch, never evidence.
**Vision-fit:** n/a — internal tooling
**Researched:** House precedent: gate-engine/review/eval/reviewers/bench.mts already checkpoints (progress-<model>-<cascade>.jsonl + --fresh + pause-after-3-outages). This adopts that shape rather than inventing one, but reads the file tolerantly instead of all-or-nothing — its parseCasesText load drops the ENTIRE checkpoint on one torn line.
**Rejected:** Retry-before-abort on a dark judge: the header already rules that a polluted run is worth less than a rerun, and the only real objection to aborting was cost, which checkpointing removes. Also rejected: clearing the checkpoint on success (an idempotent re-run should cost nothing) and keying on row content instead of corpusHash (per-row keys would let a re-labelled row replay under its old verdict).
**Revisit-when:** The bench completes reliably in one attempt (a provider-side fix or a batch API), making resume dead weight; or a sub-bench gains per-row state that a single JSONL row cannot capture.
**Scope:** gate-engine/decisions/eval/**
**Source:** manual
