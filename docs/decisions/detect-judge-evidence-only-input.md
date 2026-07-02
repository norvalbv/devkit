---
slug: detect-judge-evidence-only-input
created: 2026-07-01
---

# detect-judge-evidence-only-input

## Target · 2026-07-01 — detect judge gets extracted evidence, never the raw diff

**Context:** The smell-downgrade judge received the first 12000 chars of the raw staged diff: a commit whose routine churn preceded the decision decider falsely downgraded a genuine ORM swap (bench: DECISION recall 1.00 -> 0.86 on the buried-decision row), and long noisy input itself degrades one-word judgment — measured accuracy loss from ~3k tokens even with benign filler, with binary label bias (arXiv:2402.14848; Context Rot; arXiv:2302.00093).
**Ruling:** The judge never sees the raw diff. buildDetectJudgeInput deterministically extracts EVIDENCE: a capped changed-file list, only the smell-contributing files' segments (per-segment 4k / hard total 8k caps, lockfiles never evidence), and explicit omission accounting where cap-dropped smell evidence names itself INCOMPLETE (engaging the insufficient-evidence -> DECISION fail-safe). Prefixes are forced off-config on the gate's diff call so consumer diff.noprefix/mnemonicPrefix cannot blind the extractor.
**Consequences:**
- Positive: A buried decision is positionally immune by construction (the smell defines the evidence; a decision in a non-smelled file never triggers the gate), and the judged input drops to a mean 592 chars from mean 3688-char raw diffs on the seed corpus — cheaper, and the hallucination-prone long-context regime is avoided. DECISION recall restored to 1.00 including the adversarial buried row.
- Negative: Evidence selection is only as good as the smell taxonomy: a smell whose contributing files are misidentified extracts the wrong segments, and cap-exhaustion on many-smell commits drops evidence (flagged INCOMPLETE, which biases toward blocking — a false block, not a false clear).
**Vision-fit:** n/a — internal tooling
**Researched:** two research passes (lit + production practice): extraction ranked above reorder/summarize/embed-retrieve/agentic for a 30s deterministic-trigger judge — reorder fixes position but not length (arXiv:2307.03172 vs 2402.14848); summarize adds a hallucinating middleman losing structural cues (2005.00661, 2503.19114); embeddings replace a perfect-recall deterministic filter with a probabilistic one (2502.05167); agentic wins on quality (2410.10934: ~90% vs ~70%) but costs minutes per call (Greptile v3). Production: PR-Agent compression, CodeRabbit/Copilot generated-file exclusion, cubic -51% false positives from narrow contexts.
**Rejected:** (a) naive truncated raw diff (status quo) — loses on the measured buried-decision miss AND the length penalty; (b) smell-first reordering of the full diff — loses on the length penalty that persists once position is fixed (2402.14848); (c) summarize-then-judge — loses on abstraction hallucination + structural-cue loss; (d) embedding retrieval — loses on recall vs a trigger that already names the files; (e) fully agentic judge — loses on the 30s commit-path budget (kept as the async escalation road)
**Anchored-bet:** [BET]
**Revisit-when:** the bench shows evidence-only input missing decisions (DECISION recall drop on grown corpora), or commit-path latency budgets relax enough that an agentic detect pass (alignment's shape) becomes affordable per smelled commit
**Scope:** gate-engine/decisions/detect.mjs
**Source:** collab
