---
slug: decision-duplicate-axes-surfaced-not-blocked
created: 2026-07-26
---

# decision-duplicate-axes-surfaced-not-blocked

## Target · 2026-07-26 — A new axis surfaces its nearest live rulings; blocking on similarity is measurably wrong

**Context:** Two axes can hold directly contradictory live rulings with nothing detecting it: dev-guardrails-distribution says skills ship via npx-skills, devkit-onboarding-cli says NOT npx-skills, both dated 2026-06-13, both current. The author of the second had no signal the first existed. The story AC proposed refusing a new ruling whose BM25 similarity to a live ruling exceeds a threshold.
**Ruling:** Refusal by similarity threshold is REJECTED on measurement, and replaced by an advisory nudge: creating a new axis prints the three nearest live rulings and continues. Measured over 30 real axes, ranking each ruling against all others, every one of the six highest-scoring pairs is legitimately distinct — the top pair at 70.20 is the recall BENCHMARK design against the ranking ALGORITHM. BM25 measures topic overlap, and decisions about one subsystem share vocabulary by construction, so a threshold catching genuine duplicates would reject legitimate axes at a rate far above the FPR@R80 <= 0.10 the house requires. The nudge has no threshold and no failure mode: it can only help an author notice the file they should have appended to.
**Consequences:**
- Positive: The measured failure — an author unaware that an axis already rules on their question — is addressed at the moment it occurs, without a gate that blocks good work and therefore gets switched off.
- Negative: A determined author can still create a rival axis; this informs rather than prevents. Detection of duplicates that already exist is left to review, not the write path.
**Vision-fit:** n/a — internal tooling
**Researched:** Same discipline that rejected fused-score abstention: measure separability before building the threshold. correctness-reviewer-precision already rules that a false positive blocking a legitimate commit is the costlier error.
**Rejected:** Blocking above a BM25 threshold (measured: top-6 pairs all legitimately distinct). Cosine similarity (measured elsewhere on this corpus: everything sits in a narrow 0.64-0.83 band). An LLM judgement at write time (the per-commit path is deliberately LLM-free).
**Revisit-when:** A signal is found that separates genuine duplicates from topical neighbours on this corpus — at which point blocking becomes defensible and this becomes its shortlist.
**Scope:** gate-engine/decisions/decisions.mts
**Source:** manual
