---
slug: bench-gates-on-flips-not-deltas
created: 2026-07-02
---

# bench-gates-on-flips-not-deltas

## Target · 2026-07-02 — the eval gate runs on per-row flips + floors, never aggregate deltas

**Context:** The bench's --fail compared aggregate metrics with a 1e-9 epsilon on a single nondeterministic judge run over ~16 judged rows: one observed haiku row-flip between identical runs trips the gate falsely, one row moves DECISION recall by 6.25pp, the Wilson 95% interval on 14/16 spans ~[64%,96%], and detecting a 5pp regression with power needs ~630 rows — every failure the gate could report was statistically indefensible, teaching people to ignore it.
**Ruling:** The --fail gate evaluates, in order: comparability preconditions (config + gate-code hash + corpus hash mismatches SKIP the comparison mechanically), hard floors on the safety metrics (DECISION recall / CONTRADICT precision / depth accuracy < 0.75 fail immediately), then the per-row FLIP TABLE vs baseline judged by a mid-p McNemar test (p<0.05, ~5+ net one-directional flips) counting only STABLE flips (unanimous across BENCH_RUNS=3 majority-vote trials for detect/depth; retry-confirmed 2-of-2 for alignment). Aggregate deltas print as informational only; every metric ships raw counts + a Wilson 95% interval plus an MDE line; every run appends to the runs.log ledger and post-fix rows enter as holdout.
**Consequences:**
- Positive: A gate failure is defensible with the flip table in hand (named rows, p-value), judge noise warns instead of failing (CI stops crying wolf), nondeterminism is measured as a flip rate instead of silently corrupting baselines, and prompt-iteration overfitting is visible in the ledger and checked by holdout rows.
- Negative: Baseline/gate runs cost ~3x (K=3 majority vote on detect/depth); regressions smaller than ~5 one-directional flips pass the gate silently (below this corpus's resolution — they surface as warns for a human, not CI failures); and the gate's statistics are ~60 lines of hand-rolled dep-free math that must stay correct (unit-tested).
**Vision-fit:** n/a — internal tooling
**Researched:** 4-report research pass (small-n statistics, corpus design, eval tooling practice, judge-bench pitfalls): Wilson over bootstrap/Wald below n=100 (Brown/Cai/DasGupta 2001; arXiv:2503.01747); paired per-row comparison with McNemar mid-p over aggregate deltas (Miller arXiv:2411.00640; Fagerland 2013); judge nondeterminism up to 15% accuracy swing and ~13.6% row flip rates (arXiv:2408.04667, 2606.13685) with N=3-5 trials the industry default (Inspect epochs, Braintrust trialCount, LangSmith num_repetitions); contrast sets / CheckList for metamorphic variants (arXiv:2005.04118, 2310.07641); dev-set overfitting measured at dev 0.80 vs test 0.50 (arXiv:2511.18619) motivating the ledger + holdout
**Rejected:** (a) aggregate-delta epsilon gate (status quo) — loses on the observed false failure from one noisy row-flip; (b) bootstrap CIs — under-cover below n=100 and collapse at 0/1 correct; (c) K=11 majority vote — 3x further cost for marginal variance reduction once K=3 dominates; (d) gating on <=5pp regressions — needs ~630 rows, physically out of reach; (e) prevalence-matched corpus — kills measurement power on the rare class (report projected PPV instead); (f) full inter-annotator program — effort-disproportionate for a single-author corpus (adversarial label audit substitutes)
**Anchored-bet:** [BET]
**Revisit-when:** the corpora reach ~200+ rows per sub-bench (aggregate-delta gating with proper CIs becomes defensible and cheaper than flip accounting), or claude -p exposes temperature/seed control making K-trials partly redundant, or the observed flip rate at K=3 stays 0 across 10+ ledger runs (trials can drop to 1)
**Scope:** gate-engine/decisions/eval/bench.mjs
**Source:** collab
