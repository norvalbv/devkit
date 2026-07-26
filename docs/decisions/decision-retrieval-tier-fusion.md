---
slug: decision-retrieval-tier-fusion
created: 2026-07-26
---

# decision-retrieval-tier-fusion

## Target · 2026-07-26 — Tiers are RRF-fused for ranking; abstention rides on the lexical score, not the fused one

**Context:** The retriever laddered its tiers: semantic won outright whenever Ollama answered, BM25 ran only when it did not. Two consequences, both measured. (1) The tiers fail differently — on the 29-case suite semantic alone gets containment 8/8 but drops multi-axis PartialRecall to 62.5%, lexical alone holds 75% but misses the vocabulary-gap case — so a ladder discards real signal. (2) CI scored a code path no developer ran, because CI has no Ollama. Worse, the embedding model the code names (nomic-embed-text) was not installed on the dev machine either, so the dense tier had NEVER executed and every number collected to date was lexical-only.
**Ruling:** Both tiers run over the same candidates and are fused by Reciprocal Rank Fusion (score = SUM of 1/(60+rank)), K=60 from Cormack et al. 2009 and deliberately untuned at this corpus size. Fusion is strictly better than either tier on the suite: containment SINGLE 8/8, Buried-by-rank 1/8, SetRecall 3/4, PartialRecall 87.5% — beating BOTH parents on multi-axis. Abstention, however, is computed from the PRE-FUSION lexical top-1 score, never the fused score: RRF is rank-only by construction and throws away the magnitude a confidence threshold needs. Degradation to a single tier is announced on stderr, and the result's source field reports hybrid, lexical or semantic so a caller can see which path ran.
**Consequences:**
- Positive: One retrieval path, exercised identically in CI and locally, that answers vocabulary-gap and multi-term questions instead of trading one for the other. The silent-degradation class that hid a dead dense tier for months now announces itself.
- Negative: Every query pays both tiers instead of short-circuiting on the first. At this corpus size that is milliseconds plus one Ollama round-trip; at a corpus where it stops being free, the fix is caching the query embedding, not restoring the ladder.
**Vision-fit:** n/a — internal tooling
**Researched:** BEIR (2104.08663) finds BM25 a robust baseline dense models often fail to beat out-of-domain, which project-specific slugs and jargon are; the counter-argument is the terse-question/verbose-prose vocabulary gap lexical cannot bridge. Both proved true here, on different cases — the standard argument for fusion over selection. Measured signal separation for abstention (oracle-fitted upper bounds): RRF fused FANR 6/11 FAR 3/18; cosine FANR 1/11 FAR 6/18; BM25 top1 FANR 1/11 FAR 0/18.
**Rejected:** A weighted score blend (cosine 0-1 and unbounded BM25 are not commensurable — the reason RRF is rank-based). Calibrating abstention on the fused score: measured, and the ABSTAIN and answerable ranges are identical (0.0313-0.0328). Deriving the abstention calibration set from the corpus itself: measured, and slug-derived queries are too short, so tau lands at 7.6 against an oracle 11.55 and FANR degrades to 8/11 — BM25 magnitude scales with query length, so a calibration set must match the real query distribution.
**Revisit-when:** The corpus grows past a few thousand axes (where BEIR's dense-vs-lexical findings start to favour learned retrieval outright), or a maintained hybrid-search package such as Orama is measured on this suite and beats the hand-fused pair.
**Scope:** gate-engine/decisions/recall/**
**Source:** manual
