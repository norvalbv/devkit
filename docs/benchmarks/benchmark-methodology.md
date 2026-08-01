# Benchmark Methodology — Source of Truth

> **Standing use:** this document is the house reference for DESIGNING AND UPGRADING ALL agent
> benchmarks (sentry-eval, claude-md-eval, correctness-bench, reviewer-eval, decisions-eval,
> search-tool-eval, qavis, edge-cases-eval, and future ones). Read the retrofit checklist first;
> read the full audit report when a checklist item needs its evidence.
>
> **Provenance:** the checklist distills a 2026-07-13 methodology audit produced by a 23-agent
> research/audit workflow (run `wf_158e979b-388`, 6 literature sweeps over 2024-26 arXiv +
> practitioner sources → 4 adversarial audit lenses over the real corpus → 12 independent
> citation/data verifications, 0 claims refuted → synthesis). The audited artifact was the
> sc-1118 edge-cases judge corpus (139 cases / 457 findings, v1 — since regenerated as v2).
>
> **Where the evidence lives:** the full verbatim audit report (verdict, 8 ranked findings,
> sc-1119 prescriptions, reading list) remains in the private frink repo at
> `docs/benchmarks/benchmark-methodology.md` beside the corpus it audited
> (`scripts/edge-cases-eval/`). This devkit copy is the LIVING half — the checklist and its
> addenda — moved here 2026-08-01 because the benchmark tracker (`docs/benchmarks/`), the eval
> pipelines (`gate-engine/*/eval/`), and the benchmarking decision axes all live in devkit.

---

## Retrofit checklist — apply to EVERY house benchmark

Distilled from the report + its sources; each item names the failure it prevents.

**Statistics**
1. **Unit of inference = the case/row, never the sub-finding.** Findings cluster within cases
   (here: ICC 0.22, design effect 1.77 → effective N 274→~155). Use paired per-case differences,
   bootstrap-by-case, or clustered SEs (Miller 2411.00640). Never quote iid binomial CIs on
   clustered items.
2. **Paired A/B always** — comparing two variants on the same rows cancels case variance
   (~free power: 0.61→0.75 at 10pp delta on n=139). McNemar for binary outcomes.
3. **Strata are descriptive/exploratory unless pre-registered and powered.** Rule-of-three: a
   zero-failure slice of n=8 still allows a ~31% true failure rate.
4. **Establish the label-noise floor before believing any delta** (3-6% label error flips
   rankings — Northcutt 2103.14749). Delta < (noise floor + paired CI) = unresolved, not a win.

**Labeling**
5. **Keep raw LLM proposals immutable; human audit edits live in an overlay.** In-place edits
   destroy the ability to distinguish rubber-stamping from correction (anchoring: 2507.15821).
6. **Blind-relabel a uniform random subset (40-60 items) and report κ/α (target α ≥ 0.667)**
   next to every results table. Audit-only-the-decisive-classes leaves the majority stratum
   carrying unquantified labeler priors.
7. **No forced label mappings in the labeler prompt** without measuring them: every
   heuristic mapping (here: green-first-run → "false", dismissed → "noise") is a hand-rolled
   heuristic inside an LLM gate — the no-handrolled-heuristics rule applies to LABELING too.
8. **The labeler must see EXACTLY the input the judged system will see** (same truncation,
   same excerpt). Divergent views turn disagreement into a truncation artifact.

**Judge-side bias (any LLM-judged benchmark)**
9. **Blind the judge to provenance**: strip generator model names, tool names, session metadata.
   A false "Claude" label alone shifts claude judges (2508.21164).
10. **Normalize style/format before judging** — style bias dominates position bias
    (0.10-0.76 effect: 2604.23178). Uniform template, strip markdown flourishes.
11. **Randomize/mirror item order identically across compared variants** so position noise
    cancels in the paired difference (2406.07791).
12. **Same-family generator→labeler→judge pipelines need a cross-family spot-check** on a
    stratified subsample; report the family gap next to headline numbers — but don't over-read
    it (~half of self-preference effects vanish under evaluator-quality nulls, 2601.22548).

**Data construction (mined/telemetry corpora)**
13. **Solution-leakage check**: if inputs are reconstructed from history, prove the target
    defect/fix is NOT visible in the input (SWE-Bench+ 2410.06992: 32.67% leakage). Time-bound
    reconstruction at the observation instant, never after.
14. **Anchor-coverage invariant in CI**: every gold item must be derivable from the committed
    input (finding.files ⊆ anchor files here); publish the coverage %.
15. **Negative class must be organic, not an artifact of one construction path** (here: 82% of
    the precision negative class came from agent self-dismissals — one modality).
16. **Degenerate/empty-input guard rows are cheap — grow them** until the hallucination bound
    is meaningful.
17. **Survivorship: mined gold measures precision and RELATIVE recall only.** Say so; add a
    known-answer slice for absolute recall.

**Consumption contract**
18. **Pre-register the match rule (incl. tie-breaks) before the first run.** An LLM matcher
    needs its own mini-eval first (sc-1061 lesson; c-CRAB 2603.23448 rejects unvalidated LLM
    matching).
19. **Disagreement-triaged human audit after the first run** — hand-audit exactly the items
    where variants disagree with the label (platinum-benchmark method, 2502.03461); judge-vs-label
    disagreements at high judge confidence are candidate LABEL errors first (2410.18889).
20. **Treat measured precision as a lower bound** when gold recall is incomplete; never
    hard-fail a variant solely on unmatched extra findings.

### Known house exposures (quick scan — verify per benchmark before trusting)
- **sentry-eval / claude-md-eval**: single-label rows (low clustering risk) and baseline-paired
  by design ✓ — but no κ, no label-noise floor, labeler==judge family unblinded.
- **correctness-bench / reviewer-eval**: multi-finding matching = items 1, 18, 19 (sc-1061
  matcher unification is exactly item 18).
- **decisions-eval / search-tool-eval / qavis**: audit against items 5-8 (labeling) and 9-11
  (judge bias); qavis vision verdicts additionally style-bias-prone (item 10).

---

## Addendum 2026-08-01 — growing corpora from verdict-labeled telemetry

Context: house corpora hold 13–66 rows per reviewer while public benchmarks hold thousands. The
scale gap is NOT the problem — items 1–2 above (Miller): paired per-case A/B at n≈150 is decisively
powered, and leaderboard-scale n exists to rank dozens of models, which we don't do. The real
problem is that every row costs human authoring while the gates adjudicate real findings daily and
discard the evidence. Target labeled-row *throughput*, not row count.

**Three capture points (planned devkit work), one enabler.** Enabler: archive the staged diff
BYTES on every reviewer FAIL (telemetry keeps only `diff_sha256`; without bytes a fail can't be
replayed as a row except via the leakage-prone reconstruction blocker F1 documents — capturing at
gate time satisfies item 13 by construction). Then:

1. **Fail → fix**: collector correlates consecutive ship attempts; next attempt's diff touches the
   flagged lines → gold candidate, zero human steps.
2. **Fail → waive**: `guard-review waive <reviewer>[:<lens>] "<rationale>"` unblocks the ship,
   records the event (lens `disposition: 'waived'` already exists; the command + rationale capture
   don't) → decoy candidate with the rationale as its note. Also closes the honesty gap where a
   bypass is invisible to the benchmark.
3. **Pass → external bot fails it**: dashboard `pr_comments` ∩ `commit_review_scope` → recall-miss
   candidates via `mine-bots.mts`; the human's thread resolution (fixed vs rebutted) is the label.
   *(Amended at commit time: the collector's `pr_comments` stores no file path, no reply threading,
   and no resolution state, so extraction stays on the GitHub API — comment anchors, review-thread
   resolution, and `original_commit_id` come from there. The collector tables supply the join that
   scope-CONFIRMS a miss: `commit_ships.pr_number` → `commit_review_scope.files_json`. Findings
   that can't be joined are labeled unverifiable, not asserted as gate misses.)*

Humans do disagreement-triage only (item 19), never authoring. Evidence of throughput:
correctness-reviewer alone has ~118 fails (~30% fail rate) + 550+ CodeRabbit comments banked.

**External imports and tools (researched 2026-08-01):**
- Known-answer slices for absolute recall (the item-17 fix): c-CRAB (arXiv 2603.23448 — f2p-test
  ground truth, agents ~40%) and CR-Bench (arXiv 2603.11078 — SWE-Bench defects re-cast as review
  tasks with category/impact/severity). Filter to TS/JS. Survey/map: arXiv 2602.13377.
- Label-noise floor (item 4): use cleanlab (Northcutt's confident-learning), don't hand-roll.
- Runner stays ours: `bench.mts` drives the real `runCascade`, so bench and gate cannot drift —
  third-party harnesses (Inspect AI, promptfoo) can't preserve that without re-implementing the
  gate. Revisit promptfoo only for adversarial-input breadth on security reviewers.

The durable target ("benchmarks grow from verdict-labeled telemetry, not authoring") is recorded
in this repo's decision log: `docs/decisions/benchmarks-grow-from-telemetry.md`.

Sequencing (amended at commit time): the diff-bytes enabler ships in the FIRST devkit PR of the
corpus-growth effort, alongside the miner upgrade — not after the mining pass. Reviewer FAILs
(~12/day for correctness alone) are irreversibly unreplayable until it lands, while the CodeRabbit
backlog is static and loses nothing by waiting.
