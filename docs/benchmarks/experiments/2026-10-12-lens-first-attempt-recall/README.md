# First-attempt recall of single-sample correctness lenses on two real misses

**Outcome: on today's Claude-family judge, both real defects are missed every time: 0/20 and
0/20.** These misses are not sampling variance. A lens that never catches a defect cannot reach the
story's bar (caught on the first attempt in at least 9 of 10 runs) by being sampled more often, so
the planned K-sample bench was not run.

## Question

In October 2026, correctness lenses passed attempt k and failed attempt k+1 on byte-identical code
(autonomous report `65e5fb4f`). The 2026-10-01 lens-stability audit put the flip rate at about
0.42% of judged PASSes, and the remedy (re-run, union, or K-sample voting) was deferred until a
bench showed it helped. This probe asks the narrower question that comes first: how often does
one lens call catch each of those real defects?

## Conditions

- **Defects.** Two real misses, rebuilt on the base the incidents were shipped from (`d23f297d`):
  - **p1:** PR #826's tree, with `detect.mts`'s `main(): void` calling `runGate()` without
    returning its promise. `cli.mts` awaits `main()`.
  - **p2:** PR #824 at `1be5551e`, the commit that opened that PR with the defect in it. A renamed
    file's old blob is lexed with the new file's extension.
- **Path.** `guard-review lens` runs the current code (v0.69.0, `c66b887b`) through the gate's own
  path. Each run is one fresh judge call. The verdict caches are cleared before every run, and
  telemetry goes to a scratch sink.
- **Condition.** No codebase MCP, so every run is DEGRADED, as both incidents were. The judge is
  the Claude family with chunking off. `gpt-5.6-sol`, the judge both incidents ran on, was not
  measured: the Codex account refuses it, as recorded in the 2026-10-10 Claude 5.5 run.
- **Hit rule.** A hit is a run where the lens FAILs, cites a defect file and names the defect. A
  run with no verdict counts as an error. The regexes are in [probe.sh](probe.sh). All 40 counted
  runs returned PASS, so the counts do not depend on the hit rule.

## Results

| Probe | Lens | Model | Hits | 95% CI |
| --- | --- | --- | ---: | --- |
| p1 dropped promise | writer-reader-contracts | `claude-haiku-5-5` | 0/20 | 0–0.17 |
| p1 dropped promise | writer-reader-contracts | `claude-opus-5-5` | 0/3 | 0–0.71 |
| p2 rename extension | error-and-edge-classification | `claude-haiku-5-5` | 0/20 | 0–0.17 |

Intervals are Clopper-Pearson.

Three controls show that the harness can produce a FAIL and that the scoring regexes work:

- **p1 fixed tree:** PASS.
- **p2 fixed tree:** PASS.
- **p1 with `main` renamed to `mainEntry`:** FAIL in 16s. The run cites `cli.mts:74`, which
  calls a missing export, and is scored a hit.

## Reading the result

- **Not variance on this judge.** The report read the late findings as single-sample variance,
  and the lens-stability audit measured them as PASS→FAIL flips. Neither reading holds for the
  Claude judge on these two defects: per-sample recall is 0. K-sampling with union, majority or
  unanimous voting multiplies a zero, so it cannot meet the story's bar.
- **What the Sol incidents show.** On Sol, the same lenses did catch both defects on a later
  attempt. Sol's per-sample recall on them is therefore above zero, and a Sol-arm K-sample bench
  is still a meaningful question. It needs a Codex account that serves `gpt-5.6-sol`.
- **Open causes.** Two candidates were not separated by this probe:
  - The missing codebase MCP, which would let the lens look up `main()`'s caller.
  - The size of the surrounding diff. Both trees are about 100 lines across 3 to 5 files, while
    the renamed-export control is caught at once.

## Limits

- **Two defects.** This is a probe, not a corpus measurement.
- **DEGRADED only.** No codebase MCP is registered for devkit paths on this machine, so no
  MCP-present arm could be built.
- **Small Opus arm.** It is a 3-run positive control, not a measurement.
- **Partial transcripts.** Passing runs keep no transcript, so the PASS reasoning is not
  inspectable.

## Files

- [probe.sh](probe.sh): rebuilds the trees and reruns the Haiku arms. `PROBE_MODEL` selects
  another judge.
- [summary.json](summary.json): the counts above. It contains no findings or transcripts.
