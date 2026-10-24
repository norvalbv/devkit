# prior-art-eval — step-0 problem-validation bench (seed tier)

Scores `agents/prior-art.md` on hand-authored **intrinsic** rows: each row inlines its ENTIRE
reachable research corpus and pins the per-leg attestations, so this tier measures **recognition +
frame courage** (does the agent name the dissolving artifact and challenge the frame?), never
retrieval. Retrieval is measured by the workflow tier below (pinned public snapshots with declared
`research.referenceCheckouts`); the live network legs (`gh`, web, papers, deep-research) are **unbenchmarked
departures**, same idiom as the critique bench's deep-research gap.

## Corpus (`cases-prior-art.jsonl`, 16 rows)

| slice | rows | gold |
|---|---|---|
| Frame-dissolve haystacks (Frink wake-hold + reword, skill-dedup recast) | 3 | DISSOLVE_FRAME |
| Solved-elsewhere haystacks (vendored-adhd, jscpd, qavis — mined from real adoption history) | 3 | SOLVED_ELSEWHERE |
| Genuine-work controls (decisions-gate, gold-slot-bench, worktree-leases, verdict-cache) | 4 | GENUINE_NEW_WORK |
| Insufficient-evidence control (private vendor dep) | 1 | INSUFFICIENT_EVIDENCE |
| Legs-degradation rows (all-dark · undeclared checkouts · gh-failed) | 3 | INSUFFICIENT_EVIDENCE |
| Legs positive control (declared-and-searched-empty + upstream wontfix) | 1 | GENUINE_NEW_WORK |
| Partial-fix haystack (merged PR fixes the named trigger; other exits still reproduce) | 1 | GENUINE_NEW_WORK or INSUFFICIENT_EVIDENCE |

Haystack rows bury one probative excerpt among near-misses (watchdogs, retries, renderer dedups) so
recognition is earned, not handed over. Decoy slots are spread across 12 rows — slot flips cluster
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

## Workflow tier (`workflow/`, frozen retrieval)

The intrinsic tier cannot tell "never found the source" from "found it, drew the wrong verdict". The
workflow tier can: each task runs twice on the same agent, model, effort and workspace, once with
its labelled spans **supplied** verbatim (the oracle, no tools) and once where it must **search** for
them with Read/Grep/Glob. Right-when-supplied but wrong-when-searching is a retrieval failure; wrong
both ways is an interpretation failure.

- **Families** (`workflow/families.jsonl`): 3 families, 5 tasks, 10 cases. Every source is a public
  repository pinned by commit SHA and tree OID (devkit at two commits, t3code at one), so no snapshot
  content is authored. Each natural member is anchored by a real outcome (sc-2272's closed PR #533,
  the mined frink-wake-hold and ship-resume rows). Each artificial member is a broken-tool twin: the
  declared `../refs/*` pattern resolves nothing, so INSUFFICIENT_EVIDENCE is its only right answer.
  Natural gaps and artificial controls are reported separately.
- **Layout**: a per-run workspace holds `consumer/` (the snapshot, with `research.referenceCheckouts`
  set to `["../refs/*"]`) and `refs/<name>/`. Snapshots cache under
  `~/.devkit/research/prior-art-workflow/`; a commit that cannot be fetched, or whose tree OID differs
  from the pin, aborts before any spawn.
- **Measures**, per condition: valid response, verdict and framing, local-leg honesty (counts and
  status match the layout), own-repo and reference-checkout recall, required spans read (a Read
  window or Grep content covering the span; a file listing only locates it), claim support (a quote
  inside a gold span is supported, inside a decoy span is decoy, a real but unlabelled file is
  unjudged and never false, an absent quote is unverifiable), decoy endorsement (the matcher),
  genuine work not dissolved, insufficient-evidence calibration, and families with every member
  right. Plus the paired split above.
- **Identity**: an execution is reused only when the spawn argv, `claude --version`, agent md,
  request bytes, pinned trees, user-scope CLAUDE.md and the runner's whole module closure are all
  unchanged. The scorer hash is separate, so a scoring change rescores the bank with no new call.
  The bank is `workflow-checkpoint.jsonl` (gitignored).

**Departures from production**, all deliberate:

- **External legs are frozen.** github, web and papers are pinned reached, and their results are
  inlined, captured once with source URLs. deep-research is unavailable. The tier measures
  local-leg and own-repo retrieval only and makes no claim about live-web recall.
- **The tool profile is narrowed.** The session gets `--restricted --tools Read,Grep,Glob`, an empty
  strict MCP config, and no Bash, so Phase 0 resolves the checkouts by hand. The agent's declared
  codebase and context7 MCP servers are stripped. A session whose `system/init` event shows any
  other tool, or any MCP server, is a harness fault, not a result.

**Third-party harnesses considered and rejected.** promptfoo and inspect_ai cannot run
`agents/prior-art.md` from source under the closed response contract. They would also split the
append-only evidence pipeline.

**The decision the first paid run informs.** Does reference-checkout and own-repo retrieval need
more than Grep, Glob and Read, i.e. is the paired retrieval-failure count material? The run does not
reopen gating, which `prior-art-before-plan` ties to about 30 mined rows.

```bash
node gate-engine/prior-art/eval/bench.mts workflow coverage      # lint + session plan (no LLM, no network)
node gate-engine/prior-art/eval/bench.mts workflow --dev         # materialise + verify snapshots, print plan
BENCH_RUNS=1 node gate-engine/prior-art/eval/bench.mts workflow --dev --yes   # K=1 probe (spends)
BENCH_RUNS=3 node gate-engine/prior-art/eval/bench.mts workflow --baseline --yes   # writes workflow/results.json
```

The plan line states the session count and the per-session `--max-budget-usd` cap ($5, so 30
sessions at K=3 have a $150 worst case, plus haiku matcher calls). Run a K=1 probe of each family
before K=3.

## Running

```bash
node gate-engine/prior-art/eval/bench.mts coverage      # corpus lint + slot counts (no LLM)
node gate-engine/prior-art/eval/bench.mts --dev         # K=1 scoring run
BENCH_RUNS=3 node gate-engine/prior-art/eval/bench.mts --baseline   # writes results.baseline.json
node gate-engine/prior-art/eval/bench.mts --fail        # exit 1 on any row flip vs baseline
node gate-engine/prior-art/eval/bench.mts --dev --only int-a,int-b   # subset, one combined summary
```

Under each row, every slot the majority flagged (gold missed, decoy endorsed) lists its agreeing
runs: the item the matcher picked (`← F<n>`, `(unstable)` on a split vote) and a 240-char excerpt
of that item and of the response's conclusion, or `matcher dark` when every vote was dark. That is
enough to tell a matcher false positive from an agent regression without opening
`checkpoint.jsonl`; the `run#` is the bank's run index.

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
