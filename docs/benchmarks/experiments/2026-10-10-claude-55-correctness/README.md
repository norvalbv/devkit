# Correctness reviewer on Claude 5.5: Sonnet and Haiku against the Sol baseline

**Outcome: Haiku 5.5 flags more labelled bugs than Sonnet 5.5, and Sol flags more than either.**
The Claude judge family's correctness model moves from `sonnet` to `claude-haiku-5-5`. The shipped
default stays `gpt-5.6-sol`.

## Question

The Claude family runs the correctness reviewer whenever the Codex judges are unreachable. Its
model was the `sonnet` alias, which began resolving to Sonnet 5.5 on 2026-09-28. Production
telemetry then showed the reviewer's block rate falling from about half of ships to about one in
twenty-five. Neither Claude 5.5 model had been measured on the labelled corpus.

## Conditions

Both runs use the full 285-case correctness corpus and the condition of the 2026-09-13 Sol
baseline: single pass, four lens groups, chunk cap 400, 1,164 planned lens tasks with four chunked
cases. The corpus file is byte-identical to that baseline's, and every case pairs with it on its
behaviour hash.

```bash
BENCH_CORRECTNESS_MODEL=claude-sonnet-5-5 BENCH_CASCADE=off \
  node gate-engine/review/eval/reviewers/bench.mts run correctness-reviewer
BENCH_MODEL=claude-haiku-5-5 BENCH_CORRECTNESS_MODEL=claude-haiku-5-5 BENCH_CASCADE=off \
  node gate-engine/review/eval/reviewers/bench.mts run correctness-reviewer
```

## Results

Initial reviewer verdicts against frozen labels. This is label agreement, not factual precision.

| Model | Bug-labelled cases flagged | Clean-labelled cases accepted |
| --- | ---: | ---: |
| `gpt-5.6-sol` (2026-09-13 checkpoint) | 102/105 (97.1%) | 117/180 (65.0%) |
| `claude-haiku-5-5` | 92/105 (87.6%) | 130/180 (72.2%) |
| `claude-sonnet-5-5` | 84/105 (80.0%) | 150/179 (83.8%) |

Paired on the same cases, with an exact two-sided McNemar test over the discordant pairs:

| Comparison | Bug cases only the first flags | Only the second | p |
| --- | ---: | ---: | ---: |
| Sol vs Haiku 5.5 | 11 | 1 | 0.006 |
| Sol vs Sonnet 5.5 | 18 | 0 | <0.001 |
| Haiku 5.5 vs Sonnet 5.5 | 10 | 2 | 0.039 |

Sonnet 5.5 accepts more clean cases than Haiku 5.5 (28 against 7, p<0.001) and more than Sol (44
against 10). The same ordering holds on the development and held-out partitions.

Nine bug cases are missed by both Claude models and flagged by Sol; two are missed by all three.
[summary.json](summary.json) lists them.

## Reading the result

Catching a labelled bug is weighted above accepting a clean case, so Haiku 5.5 replaces Sonnet in
the Claude family. Haiku 5.5 still misses about one labelled bug in eight where Sol misses about
one in thirty-five, so the family remains a fallback and not a replacement for the default.

## Limits

- **Sol was not re-run.** The Codex account available to this run refuses `gpt-5.6-sol`, so Sol's
  numbers are the published 2026-09-13 checkpoint. The reviewer brief and skill are unchanged since
  then, but the surrounding review code and the benchmark runner have moved, so the Sol comparison
  spans two code states. The Haiku and Sonnet runs share one.
- **Localized fixtures.** Cases are one or two files of at most 25 lines. They measure recall on
  small changes, not on production-sized diffs.
- **One unmeasured case.** `corr-eslint-no-extra-semi-clean` ended in an engine error on the Sonnet
  run and is excluded from its totals.
- **Interrupted runs.** The Sonnet run paused twice on an account usage limit and resumed from its
  ledger. The Haiku run was restarted to raise concurrency. Completed lens tasks were reused and
  interrupted ones re-ran.
- **Single run per model.** No repeat runs measure run-to-run noise.

## Files

- [results.json](results.json) — per-case outcomes and hashes for both runs. No prompts, findings
  or transcripts.
- [summary.json](summary.json) — the metrics above, written by [summarize.mjs](summarize.mjs) from
  `results.json` and the Sol checkpoint.
