# prior-art-eval — step-0 problem-validation bench (seed tier)

Scores `agents/prior-art.md` on hand-authored **intrinsic** rows: each row inlines its ENTIRE
reachable research corpus and pins the per-leg attestations, so this tier measures **recognition +
frame courage** (does the agent name the dissolving artifact and challenge the frame?), never
retrieval. Retrieval belongs to the Phase-3 workflow tier (fixture repos with declared
`research.referenceCheckouts`); the live network legs (`gh`, web, deep-research) are **unbenchmarked
departures**, same idiom as the critique bench's deep-research gap.

## Corpus (`cases-prior-art.jsonl`, 15 rows)

| slice | rows | gold |
|---|---|---|
| Frame-dissolve haystacks (Frink wake-hold + reword, skill-dedup recast) | 3 | DISSOLVE_FRAME |
| Solved-elsewhere haystacks (vendored-adhd, jscpd, qavis — mined from real adoption history) | 3 | SOLVED_ELSEWHERE |
| Genuine-work controls (decisions-gate, gold-slot-bench, worktree-leases, verdict-cache) | 4 | GENUINE_NEW_WORK |
| Insufficient-evidence control (private vendor dep) | 1 | INSUFFICIENT_EVIDENCE |
| Legs-degradation rows (all-dark · undeclared checkouts · gh-failed) | 3 | INSUFFICIENT_EVIDENCE |
| Legs positive control (declared-and-searched-empty + upstream wontfix) | 1 | GENUINE_NEW_WORK |

Haystack rows bury one probative excerpt among near-misses (watchdogs, retries, renderer dedups) so
recognition is earned, not handed over. Decoy slots are spread across 10 rows — slot flips cluster
by CASE, so decoys concentrated in one row would be n=1 (`open-ended-reviewer-gold-slots`).

## Metrics

Row-level, Wilson 95% intervals, via the `prior-art` adapter (`gate-engine/eval/adapters.mts`):

- **verdict accuracy** — majority-of-K verdict ∈ the row's expected set (headline)
- **framing accuracy** — `frameChallenge.framing` ∈ expected set (the frame-courage instrument)
- **gold evidence recall** — forced-choice matcher: the dissolving/solving artifact is NAMED
- **decoy endorsement rate** (lower) — a within-frame patch endorsed as the way forward
- **genuine-control clean rate** — controls not misdeclared SOLVED/DISSOLVE
- **response contract** — closed `prior_art` JSON validity per run

**UNDERPOWERED, by design at seed size:** the genuine-control clean rate rests on n=5 rows and the
decoy ceiling on 12 case-clustered slots — a single flip moves them by whole percentage points, so
they are reported with intervals and carry **no hard floor** until Phase-5 live-calibration rows
(mined from real step-0 outcomes, per `benchmarks-grow-from-telemetry`) give them resolution.
Regression checks are row-FLIP based, never aggregate deltas (`bench-gates-on-flips-not-deltas`).

The legs-degradation rows are **contract-checkable**: the coupling rules in
`gate-engine/prior-art/response-contract.mts` make every verdict except INSUFFICIENT_EVIDENCE
invalid when the pinned legs are dark/undeclared/failed, so those rows measure the anti-laundering
rules directly, with no matcher call.

## Departures from production

- No Task-tool environment and no deep-research MCP under `claude -p` — the md degrades
  ("where available"); unmeasured here.
- Leg attestations are PINNED by the fixture; production legs are attested by the agent itself and
  enforced only at benchmark/capture time (the production step-0 path is prompt-level — recorded in
  the `prior-art-before-plan` Target).
- Matcher prompt nouns are this suite's own (`buildGoldPrompt`/`buildDecoyPrompt` in
  `eval/matcher.mts`) per the deliberate per-suite pattern documented in
  `gate-engine/judge/matcher-core.mts`; only the engine is shared.

## Running

```bash
node gate-engine/prior-art/eval/bench.mts coverage      # corpus lint + slot counts (no LLM)
node gate-engine/prior-art/eval/bench.mts --dev         # K=1 scoring run
BENCH_RUNS=3 node gate-engine/prior-art/eval/bench.mts --baseline   # writes results.baseline.json
node gate-engine/prior-art/eval/bench.mts --fail        # exit 1 on any row flip vs baseline
```

**The committed seed baseline is K=1** (a deliberate cost decision, 2026-08-06): `runs: 1` in the
baseline, so the adapter reports it not-accepted and the subject stays `evidence-only`. Upgrading
to the acceptance-grade K=3 resumes the 15 banked responses from the checkpoint and pays only the
30 missing calls: `BENCH_RUNS=3 node gate-engine/prior-art/eval/bench.mts --baseline`.

`runs.log` (gitignored) is the append-only run ledger. Baselines embed
`agentHash`/`runnerHash`/`corpusHash` — any mismatch is a new experiment, never a comparison.

**Checkpoint/resume**: completed agent calls are banked in `checkpoint.jsonl` (gitignored) keyed by
(row, runIndex) under the experiment fingerprint, so a K=1 pass upgrades to K=3 later paying only
the missing runs, and a killed run resumes where it stopped. An edited agent/corpus/runner changes
the fingerprint and ignores the bank (`bench-runs-resume-from-checkpoint`). `BENCH_NO_RESUME=1`
forces fresh calls.
