# Correctness re-baseline on the shipped gpt-5.6-sol pin — 2026-09-04 (sc-2494)

The published correctness numbers described sonnet. This run re-measures the reviewer on the pin
production has actually run since 2026-08-26.

**Epoch break.** These rows do not pair with the 2026-08-02 checkpoint: the model family changed and
the corpus grew from 69 to 75 gold and 59 to 65 decoys. The tracker records it as a methodology
reset, not a delta.

**Freshness.** The tracker marks this checkpoint `stale` on arrival, and that is correct rather than a
defect. It measures the reviewer as of `54268f07`; sc-2538 (#578) then changed `run-review.mts` and
`reviewers.mts`, so the implementation moved after measurement. Freshness is a separate axis from
evidence — the rows below are the best available measurement of the shipped pin, and they describe
the code that produced them.

| metric | sonnet, 2026-08-02 | gpt-5.6-sol, today |
|---|---|---|
| first-pass FAIL recall | 56/69 = 0.81 | 69/75 = 0.92 [0.84, 0.96] |
| first-pass clean pass | 49/59 = 0.83 | 39/65 = 0.60 [0.48, 0.71] |

## A measurement bug voided every clean row first

`runRow` called `runCascade` without the gate's judge env, so `DEVKIT_CHECKLIST_KEEP=1` never
reached the judge. The checklist script deleted its own all-pass artifact and the contract read the
result as "checklist artifact missing". Every PASS row scored inconclusive.

Production and the scale bench both pass `gateJudgeEnv` for this reason (sc-1438); the main bench
did not. Fixed in #581 with a regression test. Backend-performance decoys went from 0/6 to 3/6
end-to-end on the same rows.

## Where the precision loss lives

Splitting the decoys by whether they are the repaired sibling of a gold row (`variantOf` set):

| decoy type | first-pass clean pass |
|---|---|
| fix-pairs — same diff, bug repaired | 25/50 = 0.50 [0.37, 0.63] |
| standalone clean code | 14/15 = 0.93 [0.70, 0.99] |

25 of the 26 false blocks are fix-pairs. In 24 the reviewer caught the bug in the gold row and then
blocked its repaired sibling too. The bench's own pair-consistency metric (sc-2498) reads 21/50.

On ordinary clean code the reviewer is strong. On repaired code it is at chance.

## Paired comparison on identical rows

120 of the shared rows are byte-identical across the two runs (`rowHash` match), so they pair
directly.

| metric | sonnet | sol |
|---|---|---|
| recall | 55/65 = 0.85 | 59/65 = 0.91 |
| clean pass | 48/55 = 0.87 | 33/55 = 0.60 |

Flips run 18 sonnet-right-to-sol-wrong against 7 the other way (McNemar chi-square 4.00). All 7
improvements are gold rows; 15 of the 18 regressions are decoys, 14 of them fix-pairs. On those same
rows the blocking rate rose from 52% to 68%.

That is a lowered firing threshold rather than better discrimination.

## Two reasons not to read this as a verdict on the pin

**The corpus cannot see the configuration sol was chosen for.** No corpus row comes within ten times
the chunk trigger (#570), so the bench measures sol whole-diff. On the scale probe's real 1k–7.2k
LOC diffs, sol whole-diff re-found 5/23 known defects — level with sonnet — while sol at chunk:400
re-found 13/23 against sonnet's best of 8/23. Sol's advantage is a large-diff, chunked effect that
this corpus is structurally unable to measure.

**Recall and precision were measured on different workloads.** The codex judge probe measured recall
on real large diffs and explicitly recorded that extras precision was not verified, and that a
production flip still required it. The flip shipped anyway. These numbers are that check arriving
late, on the small-diff corpus rather than the large-diff one.

## Production agrees with the precision half

Correctness blocks per review, same weeks, machines split across models: sonnet 55% and 44%, sol 73%
and 66%. After a block, the next review of the same branch blocks again 59% of the time under sonnet
and 81% under sol. Where the diff genuinely changed between two blocks, sol returns to the same file
48% of the time against sonnet's 34%.

Ship attempts per branch, holding diff bytes comparable, went from 3.3 in W33 to 4.9 in W35 on a
smaller average diff.

## How this baseline was produced

The run completed without `--baseline`, and `runBench` clears its checkpoint on success, so the
per-row evidence had to come from the run's own printed transcript. Only the verdict, final status
and reason class are run-derived; the hashes, pair identity and metrics were recomputed with the
bench's own functions, and every row's recomputed pass/fail was asserted equal to its logged verdict.
The provenance is recorded in the published event, not only here.

A general-purpose rebuild tool was written for this and then **withdrawn**. Over four review rounds
it drew ten distinct correctness findings — outage rows recorded as ordinary misses, escalated runs
crashing rather than refusing, an unreadable output silently overwritten, verdicts re-attachable to a
moved corpus, and more. Each was fixable; the pattern was the answer. Reconstructing authoritative
evidence from a transcript is the hazard itself.

So this reconstruction stands as a one-off, with its provenance in the published event, and a run
that finishes without `--baseline` is re-run rather than rebuilt. The durable fix belongs in the
bench: persist per-row results on completion so nothing ever needs reconstructing.

Nothing from the attempt ships in this record. `bench.mts` is the suite's own scorer and runner, so
editing it in the publishing commit re-stales the checkpoint being published. The one worthwhile
survivor — a run identity line carrying the effective model, corpus hash, gate hash and cascade mode
— belongs in its own change, which will legitimately mark this suite stale until it is re-measured.

## Scope

The four domain suites ran in the same sweep and are recorded on sc-2494, but they are not published
here: those reviewers are work in progress, so their numbers are a snapshot of moving assets. Their
escalation timings are also not recoverable from a run log, so the one-off reconstruction used here
could not have covered them either.
