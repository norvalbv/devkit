---
slug: decision-retrieval-candidate-set
created: 2026-07-25
---

# decision-retrieval-candidate-set

## Target · 2026-07-25 — Retrieval reads the decisions DIRECTORY; an unmatched query abstains

**Context:** The recall half of the decisions gate built its candidate set from INDEX.md rows only, while check-alignment read the directory — two disagreeing sources of truth. Measured on a real 86-axis corpus, 23 axes (27%) had NO INDEX row and were unreturnable by query at any k, including live recent ones (qa-cloud-driver, parallel-commit-isolation, windows-support). In a 14-query probe recall@5 was 35.7% and every single miss was candidate-set absence, not a ranking error — every indexed gold axis ranked #1. Separately, a query matching nothing returned the alphabetically-first k axes, byte-identical in shape to a real hit, so an agent could not tell 'nothing is decided' from 'I got the wrong axis'.
**Ruling:** Retrieval candidates come from the decisions DIRECTORY (loadAxisRows in gate-engine/decisions/retrieval.mts), reading both the Target and the legacy pre-Target schema; INDEX.md is demoted to a rendered view that supplies ruling/why only as a fallback for a file we cannot parse. A searched-but-unmatched query ABSTAINS: RankResult.source distinguishes 'empty' (nothing recorded) from 'none' (searched, nothing rules) and returns no rows, replacing the alphabetical first-k fallback.
**Consequences:**
- Positive: An agent consulting the log actually sees every recorded axis: recall@5 35.7%->100%, success@5 33.3%->100%, MRR 0.333->0.829 on the frink corpus. The completeness gate's semantic channel — silently dead whenever INDEX was incomplete, which is most repos — now works, so recorded decisions reach the reviewer prompt instead of being re-litigated.
- Negative: Retrieval now reads and parses every axis file per query instead of one INDEX.md, so cost scales with corpus size rather than index size; at ~90 files that is milliseconds, but a much larger log would need a cached spine. Abstention is still only the zero-lexical-overlap case — a calibrated relevance threshold needs the recall benchmark that does not exist yet, so near-miss queries still answer.
**Vision-fit:** n/a — internal tooling. Rule 12 makes docs/decisions the source of truth that reviewer and critique agents must consult; a log that cannot return 27% of its own rulings cannot carry that weight.
**Researched:** 9-agent arXiv/web sweep, 55 verified papers (sc-1236 planning): BEIR 2104.08663 (BM25 is a robust out-of-domain baseline dense models often fail to beat); SQuAD 2.0 1806.03822 + RGB 2309.01431 (has-answer/no-answer is its own measurable axis); MemStrata 2606.26511 (cosine separates contradiction from duplication at AUROC 0.59, so structure not similarity must carry current-state).
**Rejected:** (a) Better embeddings or a cross-encoder reranker — the measurement shows every miss was candidate-set ABSENCE, which no ranker can recover; (b) keep INDEX as the candidate set and repair it on write — leaves the two-sources-of-truth split intact and depends on every writer being well-behaved; (c) a hosted vector DB / GraphRAG / RAPTOR — construction and staleness cost are indefensible for ~90 markdown files, and re-clustering would run exactly when the gate runs.
**Anchored-bet:** [VALIDATED]
**Revisit-when:** query latency exceeds ~200ms because the corpus outgrew a per-query full-directory read, or the recall benchmark shows Buried@5 (right axis, wrong rank) dominating the residual once the candidate set is complete
**Scope:** gate-engine/decisions/**
**Source:** shortcut · sc-1236
