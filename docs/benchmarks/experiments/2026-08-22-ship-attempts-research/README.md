# Ship-attempt cost research: why large PRs take 20+ attempts, and what to build — 2026-08-22

**Status:** research consolidation + approved plan; no benchmark run yet. This folder exists so every
claim in the plan can be re-validated from the same inputs.

**Finding record:** [`../../reviewer-yield-vs-diff-size.md`](../../reviewer-yield-vs-diff-size.md).
**Queries:** [`reports/queries.md`](reports/queries.md).

## Question

Ship attempts on large branches run to 20–55 with ~1 new finding per ~15-minute attempt and up to
$466 of judge calls per branch. The owner proposed (1) reviewing only the code amended since the last
attempt and (2) splitting large diffs into ~N-LOC chunks reviewed by parallel agents. Is either
standard practice, what does the literature say, what does our own telemetry say, and what is the
smallest thing that moves attempts × cost × accuracy on large PRs?

## Method

A 14-agent workflow (`reports/workflow-script.js.txt`, run id `wf_4ddc9246-00f`, ~1.9M tokens, 39 min):

| phase | agents | output |
|---|---|---|
| Explore (haiku) | ship/review flow map; bench infrastructure map | `reports/flow.md`, `reports/bench-infra.md` |
| Evidence (sonnet) | telemetry SQL; arXiv (arxiv-mcp + web); industry (docs + source); prior-art verdict | `reports/telemetry.md`, `reports/arxiv.md`, `reports/industry.md`, `reports/prior-art.json` |
| Critique | completeness critic over all evidence | `reports/critique.md` |
| Design | three independent architects (incremental-first / chunk-fanout / measure-first) | `reports/design-*.md` |
| Judge | three lenses (cost-sensitive solo user; engineering risk; evidence fidelity), then synthesis | `reports/judges.json`, `reports/synthesis.md` |
| Plan critique | feature-critique of the drafted plan against the code and decision records | `reports/feature-critique.md` |

The lead re-derived the headline telemetry numbers independently before and after the workflow
(`reports/queries.md`). Branch names in every report are anonymised (`branch-NN`, `checkout-NN`);
absolute paths are `<home>/…`; no issue text, transcripts, or private source lines are included.

## Bottom line

| question | answer | evidence |
|---|---|---|
| Is "review only the delta since last attempt" standard? | Yes among diff-only tools (CodeRabbit, PR-Agent `/review -i`, Cursor Bugbot opt-in); Anthropic's own Code Review deliberately does not offer it. Prior-art verdict: DISSOLVE_FRAME — it attacks cost, not attempts, and `judge-verdict-cache-scope` Rejected (b) already rules diff-minus-files unsound. | `industry.md`, `prior-art.json` |
| Is fixed-size chunk fan-out standard? | Only PR-Agent packs files into token buckets (≤3 parallel calls); Cursor runs 8 parallel whole-diff passes with voting; Anthropic fans out by issue class (= devkit's lens split). No paper compares one-agent-whole vs N-agents-N-chunks. | `industry.md`, `arxiv.md` |
| Why ~1 finding per attempt? | Prompt convention: the brief checks "one item at a time, `--fail "reason"`"; the checklist store and telemetry already accept several issues per lens. | `feature-critique.md` B5, `queries.md` |
| Does yield fall with diff size? | Issues/review plateaus at ~1.0 above 1k LOC; issues per 1k LOC 4.9 → 0.14; 13.9% of correctness reviews exceed the 60 KB evidence cap. | finding record |
| What was built first? | (1) truncation telemetry on `review_scope`; (2) bounded multi-finding disclosure per lens; (3) a scale-track benchmark — real large diffs, labels mined from later attempts — where chunked reviewers are an arm; (4) production chunking only if (3) clears a pre-registered rule. | approved plan, summarised below |

## Plan of record (approved 2026-08-22)

1. **Telemetry:** `review_scope` gains `evidence_bytes_shown / omitted_files / truncated_files`.
2. **Disclosure:** brief asks for every distinct defect per lens (cap knob, default 3); FAIL report
   prints a bounded deduped list while keeping the waiver `[fp]` line verbatim; per-lens waivers
   unchanged; rollback trigger on agent-confusion proxies; decision note narrows
   `ship-gates-converge-not-restart` Rejected (a).
3. **Scale track:** data-handling ruling first (third-party rows keep counts/hashes only); separate
   `cases-scale-correctness.jsonl` + suite; real-checkout materialisation (new) that does not clobber
   the target repo's `guard.config.json`; arms `whole` vs `chunk:<loc>` (lens split fixed on;
   `writer-reader-contracts` always whole-diff); `--dry-run` first; an informal single-diff probe
   (≈$30–45) before any pre-registered expansion.
4. **Production chunking** gated on a properly powered confirmation; keys byte-identical when off.

Not pursued: incremental delta-only re-review; haiku as a production correctness model
(`correctness-reviewer-precision`); re-testing lens-split on/off (`correctness-lens-split-ab-unresolved`).

## Papers cited (arXiv ids; one-line findings in `reports/arxiv.md`)

Directly on-point: SWE-PRBench 2603.26130 · CR-Bench 2603.11078 · c-CRAB 2603.23448 ·
Which bugs are missed in code reviews 2205.09428 · CodeReviewer 2203.09095.
Context length: 2307.03172 · 2404.06654 · 2502.05167. Ensembles: 2203.11171 · 2402.05120 · 2305.14325.
Noise/adoption: 2601.18844 · 2507.19115 · 2505.16339. Infrastructure/survey: 2406.11612 · 2508.18003.

## How to re-validate

- Re-run every query in `reports/queries.md` against a current collector DB; the finding record
  states the 2026-08-22 values.
- Re-run the workflow: `reports/workflow-script.js.txt` is the exact orchestration (agents research live;
  numbers will move with the telemetry).
- The unredacted originals (with real branch names) are kept locally by the owner, not in git.
