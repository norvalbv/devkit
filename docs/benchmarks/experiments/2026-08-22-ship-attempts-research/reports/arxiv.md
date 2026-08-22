## Literature Research: LLM Code Review, Context Length, and Chunked/Multi-Agent Review

### Papers found and read (abstract + method/results), with load-bearing findings

**1. Lost in the Middle** — arXiv:2307.03172 (Liu et al., 2023)
Finding: LM accuracy on multi-doc QA/KV-retrieval is U-shaped in the position of the relevant fact — highest at context start/end, degrades sharply when the needed info sits in the middle, even for models explicitly built for long context. No single numeric effect size in the abstract, but the U-curve is the mechanism SWE-PRBench (below) explicitly cites as the cause of its code-review degradation.

**2. RULER: What's the Real Context Size of Your Long-Context LMs?** — arXiv:2404.06654 (Hsieh et al., 2024)
Finding: 17 long-context LMs tested on 13 tasks (retrieval + multi-hop tracing + aggregation); nearly perfect on vanilla needle-in-haystack, but **only half of models claiming ≥32K context actually hold "satisfactory" performance at 32K** once task complexity increases beyond simple retrieval.

**3. NoLiMa: Long-Context Evaluation Beyond Literal Matching** — arXiv:2502.05167 (Modarressi et al., 2025)
Finding: with lexical-overlap removed (forcing real retrieval, not string-matching), **11 of 13 models drop below 50% of their own short-context baseline by 32K tokens**; GPT-4o falls from 99.3% (short) to 69.7% (32K). This is the clean quantification of "size hurts recall" absent surface shortcuts — exactly the shortcut a diff-review task can't rely on either (bugs aren't literal string matches).

**4. Long Code Arena** — arXiv:2406.11612 (Bogomolov et al., JetBrains Research, 2024)
Finding: introduces 6 project-context code benchmarks (incl. bug localization, commit-message generation) specifically because prior ML4SE benchmarks cap at ~1K tokens (HumanEval/MBPP); establishes that current baselines are weak once real project-scale context is required, but doesn't report a single degradation curve — it's the benchmark infrastructure paper.

**5. Self-Consistency Improves CoT Reasoning** — arXiv:2203.11171 (Wang et al., 2022)
Finding: sampling multiple reasoning paths + majority vote beats greedy decoding by **+17.9pp (GSM8K), +11.0pp (SVAMP), +12.2pp (AQuA)**. Foundational result for "many small votes beat one long pass," used as theoretical basis for chunk-then-vote review architectures.

**6. More Agents Is All You Need** — arXiv:2402.05120 (Li et al., 2024)
Finding: simple sampling-and-voting ("Agent Forest") scales LLM performance with agent count, orthogonal to other enhancement methods; gains are larger for harder tasks. Directly supports "N independent smaller reviewers > 1 big reviewer" if the underlying task admits voting/aggregation.

**7. Improving Factuality/Reasoning via Multiagent Debate** — arXiv:2305.14325 (Du et al., MIT, 2023)
Finding: multiple LLM instances debating over rounds reduces hallucination/factual errors and improves reasoning, using identical prompts across tasks — evidence that independent-then-reconcile agents suppress false positives, relevant to review "noise" control.

**8. CodeReviewer / Automating Code Review Activities** — arXiv:2203.09095 (Li et al., Microsoft, 2022)
Finding: pretraining task tailored to diff review (quality estimation, comment generation, code refinement) beats prior baselines — this is the canonical dataset/model that essentially every later benchmark (SWE-PRBench, c-CRAB, CR-Bench) positions itself against, and all of them note its diffs are hunk/method-local, not project-scale.

**9. SWE-PRBench** — arXiv:2603.26130 (Kumar, 2026) — **the single most directly on-point paper**
Method: 350 real merged PRs, ground truth = actual human review comments (not synthetic), 8 frontier models, 3 frozen context configs of *increasing richness but only ~500 tokens apart in raw size*: diff-only (config_A, ~2000 tok), diff+file content (config_B), full context incl. tests/execution mapping (config_C, ~2500 tok).
Findings (numbers):
- Best model detects only **15–31%** of human-flagged issues (Detection Rate 0.306 for Claude Haiku 4.5 on diff-only, down to 0.079 for Llama 3.3 70B).
- **All 8 models degrade monotonically A→B→C** — i.e., *more context makes review worse*, even though config_A and config_C differ by only 500 tokens. This rules out "just too many tokens" and implicates attention allocation, not context length per se, once the diff is buried among unchanged text.
- The collapse is concentrated in "Type2_Contextual" issues (needs surrounding code): Sonnet 4.6 falls from 0.22→0.10 composite score when file content is added; DeepSeek V3 falls 0.20→0.10 — a **>50% relative drop** exactly at the point unchanged context is added alongside the diff.
- Hallucination/false-positive rate (FPR) ranges 0.193 (GPT-4o, most precise) to 0.417 (Llama 3.3 70B, most confabulatory) — clear precision/recall tradeoff across models.
- Estimated gap to human reviewer recall (50–70% per Bacchelli & Bird 2013): **20–40 percentage points**.

**10. c-CRAB / "Code Review Agent Benchmark"** — arXiv:2603.23448 (Zhang et al., NUS, 2026)
Method: test-based evaluation — human review comments converted into executable tests; a downstream coding agent applies the reviewer's fix and tests are run as an objective oracle (avoids the "different wording, same issue" problem of text-similarity metrics).
Finding: evaluating PR-Agent, Devin, Claude Code, Codex — **combined, all agents solve only ~40% of tasks**; agent-flagged issues frequently target *different* aspects of the PR than the human reviewer flagged (complementary, not substitute).

**11. CR-Bench** — arXiv:2603.11078 (Pereira et al., Nutanix, 2026)
Method: 584 (174 verified) defect-focused tasks derived from SWE-Bench-grade real bugs; introduces "usefulness rate" and "signal-to-noise ratio" alongside P/R/F1 specifically because raw recall optimization is misleading.
Finding (numbers/qualitative): a **Reflexion-based** (iterative, self-critiquing) agent raises recall substantially over a single-shot agent, but at a **"steep cost in signal integrity"** (SNR) — most pronounced for the lighter model (GPT-5-mini). Recall is near-zero for memory-category bugs (need runtime traces, not diff text) and lowest for low-severity/nit-pick issues; highest for performance/reliability bugs with distinct code signatures. This is a direct, quantified precision-vs-recall knob you can turn by "push harder to find everything."

**12. Reducing False Positives in Static Bug Detection with LLMs (Tencent industrial study)** — arXiv:2601.18844 (Du et al., Fudan/Tencent, 2026)
Method: 433 real alarms (328 FP / 105 TP) from Tencent's proprietary static analyzer (BkCheck) across NPD/OOB/DBZ bug types; developer interviews for cost data.
Findings (numbers): false positives are **>76% of alarms**, each costing **10–20 minutes of manual inspection**. Hybrid LLM+static-analysis techniques (LLMPFA) **eliminate 94–98% of false positives while maintaining high recall**, at **$0.0011–$0.12 and 2.1–109.5 seconds per alarm** — the strongest quantified evidence in this set that LLM-based triage can move the precision/recall frontier cheaply when paired with a symbolic/static signal rather than raw LLM judgment alone.

**13. Automated Code Review Using LLMs at Ericsson: An Experience Report** — arXiv:2507.19115 (Ramesh et al., Ericsson, 2025)
Finding: lightweight LLM+static-analysis tool deployed with experienced developers; qualitative "encouraging results" but explicitly frames the value proposition as reducing reviewer *cognitive burden*, not replacing review — no hard recall/precision numbers reported in the abstract-level material reviewed.

**14. Rethinking Code Review Workflows with LLM Assistance (WirelessCar field study)** — arXiv:2505.16339 (Aðalsteinsson et al., 2025)
Finding: field study + two prototype variants (upfront vs. on-demand LLM review) at a real company; developers found LLM review valuable but flagged **"false positives and trust issues"** as the central adoption blocker, and preference was conditional on reviewer familiarity with the codebase and PR severity — direct evidence that noise tolerance, not raw capability, gates real-world adoption.

**15. Which Bugs Are Missed in Code Reviews (SmartSHARK study)** — arXiv:2205.09428 (Khoshnoud et al., MSR 2022)
Method: 3,261 candidate PRs (post-merge review activity as a proxy for "something was missed") across 77 OSS projects, manually triaged down to 224 buggy PRs / 187 missed bugs.
Findings (numbers): missed-bug taxonomy is **semantic 51.34%, build 15.5%, analysis-checks 9.09%, compatibility 7.49%, concurrency 4.28%, configuration 4.28%, GUI/API/security ~2.14% each, memory 1.6%**. This is human baseline evidence, not LLM-specific, but it's the best available taxonomy of what *any* reviewer (human or AI) misses in the wild, and the dominance of "semantic" (i.e., logic that depends on understanding code beyond the visible hunk) is consistent with SWE-PRBench's "Type2_Contextual" collapse category.

**16. "Previously on... Automating Code Review" (survey)** — arXiv:2508.18003 (Heumüller & Ortmeier, 2025)
Finding: systematic survey of 691 papers → 24 relevant MCR-automation studies (2015–2024); finds **48 distinct task/metric combinations, 22 unique to their own paper**, and limited dataset reuse — i.e., the field lacks standardized recall/precision measurement, which is exactly why SWE-PRBench/c-CRAB/CR-Bench (all 2026) each had to build their own protocol from scratch. Useful as the "state of measurement rigor" citation.

*(Secondary, weaker-fit evidence gathered but not central: chunk-size-for-RAG papers — arXiv:2607.24767, 2504.19754 — show chunk granularity trades retrieval precision vs. coherence in generic RAG, not code review specifically; included only as an analogy, not as review-task evidence.)*

---

### Synthesis

**(1) Does size hurt recall — how much, at what sizes?**
Yes, and the mechanism is not raw token count but *signal dilution once the target (the diff) is embedded in surrounding unchanged content*. NoLiMa shows non-literal-matching recall falls below 50% of short-context baseline by 32K tokens for 11/13 frontier models (GPT-4o: 99.3%→69.7%). Critically, **SWE-PRBench shows this degrades at far smaller scales in the code-review setting specifically**: going from a 2,000-token diff-only prompt to a 2,500-token prompt with structured file/AST context — a 25% token increase — collapses "contextual" issue detection by >50% relative (0.22→0.10, 0.20→0.10) across all 8 models tested. This is the single most important number for your question: **the hurt-recall threshold for code review is much lower than the raw long-context literature (RULER/NoLiMa's ~32K) suggests**, because review requires distinguishing changed-vs-unchanged lines within a flat token stream, and models fail at that discrimination task well before hitting classic "long context" lengths.
CONFIDENCE: high (SWE-PRBench numeric, direct match to your question) / high (NoLiMa/RULER for general long-context degradation, but medium for how well it transfers to diff review specifically, since SWE-PRBench suggests the code-review failure mode kicks in earlier and for a different reason — attention allocation between changed/unchanged text, not absolute position).

**(2) Does chunking help — evidence for/against, and what breaks?**
Direct evidence is thin but consistent in direction: SWE-PRBench's core finding — diff-only beats diff+context — is *de facto* evidence that a **smaller, more focused unit of work (chunk = diff-only) outperforms a larger one (chunk = diff+surrounding files)** for this task, when the model can't reliably index which tokens matter. That argues for review at hunk/diff granularity over file- or repo-level context stuffing, at least until context-representation improves (SWE-PRBench's authors propose explicit changed/unchanged boundary markers as future work — i.e., naive chunking-by-concatenation is not sufficient; you need structural markers, not just less text).
What breaks: cross-hunk and cross-file bugs are exactly the "Type2_Contextual" and "Type3_Latent" categories that collapse hardest in SWE-PRBench (Type3, requiring cross-file import-graph reasoning, is near-zero for all models regardless of context config). The human-baseline missed-bug taxonomy (SmartSHARK, arXiv:2205.09428) shows "semantic" bugs — the category most likely to span multiple hunks/require holistic understanding — are the largest share of bugs missed even by humans (51.34%), so chunking risk here is not unique to LLMs, but LLMs appear to fail at cross-hunk reasoning categorically rather than partially (near-zero, not just lower).
CONFIDENCE: medium — this is inferred from one benchmark's context-ablation (SWE-PRBench) plus one benchmark's difficulty-category breakdown (CR-Bench's near-zero recall on categories needing broader context), not from a study that directly compares "1 agent, whole diff" vs. "N agents, N chunks" on the same corpus. No paper in this search ran that exact experiment for code review — this is the biggest gap.

**(3) Small-model-per-chunk vs. big-model-whole: evidence**
No paper directly tests this trade for code review. Indirect support for "many independent (possibly smaller) votes" comes from general-purpose LLM literature: Self-Consistency (+11–18pp via sampling+voting) and More Agents Is All You Need (accuracy scales with agent count, orthogonal to other techniques) both show ensembling/voting recovers accuracy lost to any single pass's errors — this is the theoretical basis for "chunk + independent reviewers + aggregate" beating one big pass, but neither paper is about code or about long-context degradation specifically. On the cost/precision side, the Tencent industrial study is the strongest real evidence that **cheap, fast LLM passes (2–110 seconds, $0.001–0.12 each) combined with a symbolic signal (static analysis) can eliminate 94–98% of false positives while keeping recall high** — directly relevant to "many smaller/cheaper models, structured aggregation" being both cost-effective and precision-effective, though this is FP-triage on static-analysis output, not diff review de novo.
CONFIDENCE: low — genuinely no code-review paper compares model size × chunk count on recall/precision/cost jointly. This is an open research gap, not a solved question the literature answers; treat any claim of "small models per chunk work as well as one big model" as unverified extrapolation from adjacent tasks.

**(4) Incremental re-review: evidence of missed cross-hunk/regression bugs**
Weakest evidence in the set. The SmartSHARK study is human-only and mines post-merge review activity as a *proxy* for "the earlier review missed something," rather than directly comparing full-diff review vs. incremental (delta-since-last-review) review. It shows humans miss real bugs after review completes (224/16,779 candidate merged PRs, ~1.3% base rate before filtering, up to 187 confirmed missed bugs), dominated by semantic bugs (51%) — plausible candidates for state/logic that spans multiple commits or hunks, but the paper does not isolate "incremental review process" as the cause versus ordinary reviewer fallibility. I found **no paper that directly studies LLM incremental (changes-since-last-review) code review and measures missed cross-hunk bugs** as a distinct failure mode from single-pass whole-diff review. This is a genuine literature gap, not a case where evidence points against or for it.
CONFIDENCE: low (no direct study found; the SmartSHARK numbers only establish that *some* review process misses semantic/cross-cutting bugs, not that incremental review specifically is worse than whole-diff review).

**(5) What would a rigorous test look like?**
Based on how SWE-PRBench, c-CRAB, and CR-Bench are each built (all 2026, independently converging on similar designs — itself informative):
- **Ground truth**: real merged-PR review comments from active, high-review-culture repos (SWE-PRBench's Repository Quality Score / PR Review Value Score filtering) or test-based oracles converted from human comments (c-CRAB), not synthetic/LLM-generated ground truth — avoids circularity.
- **Metrics**: precision, recall, F1 *plus* a noise metric — CR-Bench's "signal-to-noise ratio" and "usefulness rate" are the right additions beyond bare P/R, because a reviewer that flags everything trivially maximizes recall (CR-Bench shows Reflexion-style "try harder" agents do exactly this).
- **Min n**: SWE-PRBench uses 350 PRs (100-PR sample for its leaderboard) with 95% bootstrap CIs (N=300, B=10,000 resamples) to distinguish model tiers — their own data shows you need this scale to statistically separate models that differ by ~0.03–0.04 composite score (their rank-4/rank-5 gap of 0.147 vs 0.113 was significant; the top-4 cluster at 0.147–0.153 was not separable even at n=100). A smaller n risks false confidence in ranking chunking strategies.
- **Noise-floor logic**: any comparison of "whole-diff vs. chunked" or "big model vs. small-model-ensemble" needs a **fixed, validated LLM-judge with cross-judge kappa reported** (SWE-PRBench: κ=0.75 primary judge, κ=0.616 cross-validation judge) — without this, apparent gains from chunking could just be judge inconsistency, not real recall improvement. It also needs a **hallucination/FPR control arm** (SWE-PRBench splits DR from FPR explicitly) so that "chunking improved recall" claims aren't confounded by "chunking made the model hallucinate more freely." Finally, a **difficulty-stratified breakdown** (Type1 direct / Type2 contextual / Type3 latent-cross-file, per SWE-PRBench) is necessary because aggregate recall hides that chunking helps Type1 and destroys Type2/Type3 — exactly what SWE-PRBench found.
CONFIDENCE: high (this is a synthesis of methodology actually used and validated across 3 independent 2026 benchmark papers, not speculation).

---

### Papers I could NOT access / verify beyond metadata
- Zeng et al., "Benchmarking and studying the LLM-based code review" (arXiv:2509.01494 / SWR-Bench) — cited by CR-Bench but not independently fetched/read here.
- Guo et al., "SWE-CARE" (2025) — cited only via c-CRAB's Table 1 comparison; abstract not independently retrieved.
- Zhang et al., "AACR-Bench" (2026) — same, cited secondhand only.
- LAURA (retrieval-augmented review generation, arXiv:2512.01356) — cited secondhand via SWE-PRBench, not independently read.
- Any Google- or Meta-specific internal industrial code-review report — searched explicitly, found none on arXiv (Ericsson and Tencent were the only large-company industrial reports located; Google/Meta reports on this topic, if they exist, are likely non-arXiv industry blog posts/talks, not indexed here).
- Original "LongLLMLingua" / prompt-compression-for-long-context papers were not searched directly (out of scope given time budget) — could bear on chunking-vs-compression trade-offs if pursued further.