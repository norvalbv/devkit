# critique-eval — accuracy benchmark for the feature-critique agent

Scores `agents/feature-critique.md` (the pre-implementation critic) against a labelled proposal
corpus, so a prompt edit is a measured delta instead of a vibe. Follows the house standard in
`gate-engine/decisions/eval/README.md`; every departure is listed at the bottom.

| failure mode | metric | tier | why |
|---|---|---|---|
| missed real flaw | **valid-flaw recall** (gold slots hit) | **hard floor 0.75** | a missed flaw is what the critic exists to prevent |
| fabricated blocker | **sound-proposal clean rate** (decoy-only rows with zero fabricated CRITICALs) | **hard floor 0.75** | hallucinated risk is the trust-eroding failure — a critic that flags everything is useless |
| re-litigating settled choices | **decoy flag rate** (decoy slots raised as CRITICAL) | **hard ceiling 0.25** | recorded decisions / sound choices must be left alone |
| wrong class blindness | **per-class recall** (7 critique classes) | reported table | a missed *security* flaw ≠ a missed nice-to-have; never averaged away |
| frame misjudgement | verdict (set-membership) + FRAME_META accuracy | reported | the 2026-06-10 bandaid miss class |
| tier miscalibration | severity calibration (hit flaws: CRITICAL vs WARNING) | warn tier | |
| format drift | contract checks (summary parses, ≤~300 tokens, report written, artifact valid) | reported, deterministic | prompt regressions that break downstream parsers |

**Overall finding precision prints informationally only**: the gold set is not exhaustive, so an
unmatched finding is not provably wrong (sc-1058 convention). The *measured* false-alarm
instruments are the decoy slots and the decoy-only rows, where wrongness holds by construction.

## Run

```bash
node bench.mts --dev                    # prompt-iteration tier: holdout rows excluded, K=1
node bench.mts --dev --only wf-decoy    # id-prefix subset
BENCH_RUNS=3 node bench.mts --baseline  # baseline tier: majority-of-3 per row (committed)
BENCH_RUNS=3 node bench.mts --fail      # gate tier: exit 1 on floor breach / significant flips
node bench.mts coverage                 # corpus coverage matrix — zero claude calls
node bench.mts matcher-audit            # matcher agreement vs committed labels (% + Cohen's κ)
BENCH_RUNS=3 node bench.mts --baseline --salvage <transcripts-dir>
                                        # resume an interrupted run: rows with enough saved
                                        # trials ingest from disk (matcher re-runs, critic does
                                        # not) — only never-run rows spend critic tokens
```

**Interruption/salvage:** every completed trial persists to `transcripts/` (summary + report +
artifact + an `agent.hash` marker). If a run dies (quota, ^C, crash), copy `transcripts/` aside
and pass it to `--salvage`: trials are exchangeable across runs of the same agent md (the marker
is verified; a changed md refuses). Salvaged trials predating artifact persistence score
`artifactValid: null` — unknown, excluded from that contract denominator, never assumed. The
baseline records `salvagedRows` so a mixed-condition run is visible, not hidden.

Exit `0` = ran (no regression under `--fail`) · `1` = regression (with `--fail`) · `2` = could not
run. Sweeps: `BENCH_MODEL` (default = the agent md's frontmatter model, opus — the bench measures
the production config) · `BENCH_RUNS=1|3` · `BENCH_MATCH_MODEL`/`BENCH_MATCH_RUNS` (matcher,
default haiku×3) · `BENCH_CONCURRENCY` (row fan-out, default 3 — higher invites the
machine-contention SIGTERM class, sc-1049).

## Two row modes

- **`intrinsic`** — no tools (`--disallowedTools '*'`), a BENCHMARK directive inlines everything
  (recorded Targets included) and requests the full compact summary block. Scores closed-set
  fields (verdict / frame meta / counts) plus the seed bench's ported `requireAny`/`forbid` text
  checks. ~30–60 s a row. This tier measures intrinsic frame reasoning — the 5 ported
  `scripts/agent-benchmarks` trap cases (bandaid / fine / contradict / notabug / realfix) live here,
  including the permanent 2026-06-10 regression row, plus 5 verbatim real prompts mined from
  session history with outcome-derived labels.
- **`workflow`** — the full contract in a disposable fixture git repo (`materializeFixture`):
  tools allowed, `guard.config.json` / `docs/decisions/` present per row, the agent writes
  `.cursor/.feature-critique.md` + the edge-cases artifact, stdout is the compact summary. The
  finding-set metrics live here, scored via the matcher. 2–6 min a row.

## The matcher (the open-output problem)

The critic emits free-text Critical Issues / Warnings — you cannot confusion-matrix that. Each
workflow row carries labelled **slots**: gold flaws (class + target severity) and decoys (sound
choices / recorded decisions the critic must not raise as blockers). `matcher.mts` parses the
report deterministically, then asks one **forced-choice question per slot** ("does any numbered
finding identify THIS flaw — F\<n\> or NONE?"), K=3 votes, non-unanimous = UNSTABLE (reported,
never regression evidence). Per-slot forced choice over one holistic mapping call: TICK
(arXiv:2410.03608); pointwise over pairwise: arXiv:2504.14716.

The matcher is itself a measurement instrument with error, so: (1) its prompts/parser are hashed
into the baseline (`runnerHash`) — a matcher edit invalidates comparisons exactly like an agent
edit; (2) `matcher-audit` scores it against the committed, hand-labelled `matcher-audit.jsonl` —
**adversarially seeded** (near-miss paraphrases, same-file-different-problem traps, two-slot
compound findings, decoy mention-vs-objection pairs) — reporting percent agreement **and Cohen's
κ** (raw agreement flatters skewed slot distributions: arXiv:2606.19544). K same-family votes
reduce variance, not family bias (arXiv:2502.01534); the audit is the validity instrument. Matcher
noise is documented here and never attributed to the critic. Decoy severity rule: a decoy matched
by a WARNING is hedging (allowed, printed as `mentioned`); only a CRITICAL counts as a flag.

Measured agreement (haiku × 3 votes, 2026-07-06): **11/12 = 92%, Cohen's κ 0.87** on the seeded
audit set. The one miss was the hardest pair (decoy mention-vs-objection) and voted non-unanimous
— i.e. it surfaced as UNSTABLE, which is the designed behaviour. Re-run `matcher-audit` after any
matcher prompt/model change and update this line.

## Statistical honesty — what this bench can and cannot see

Verbatim house rules (decisions-eval README §Statistical honesty), plus the clustering rule:

- Every headline ships raw counts + a **Wilson 95% interval**; an MDE line prints with every flip
  table.
- `--fail` gates on hard floors/ceilings plus **row-level flip tables** (verdict ·
  recall-degradation · false-alarm) under a mid-p McNemar test — never on aggregate deltas.
  **Flip units are rows, not slots**: slots within one row share a single critic transcript and
  are correlated; slot-level pairing is anti-conservative (cluster by item source — Miller,
  arXiv:2411.00640). A recall flip = a row that lost ≥1 stable gold slot and gained none. Slot
  changes print informationally.
- Only **stable** flips count (unanimous across K trials); non-unanimous rows print as
  instability, never regression.
- `BENCH_RUNS=3` majority per row at baseline/gate tier (user ruling on sc-1059: strict K=3 —
  "do it once and leave it"): a slot is hit if credited in ≥2/3 completed trials; verdict is the
  trial majority (tie → NULL). At K=3 a row needs ≥2 completed trials or it scores NULL and
  counts as an outage.
- Baselines embed `agentHash` (the source md), `runnerHash` (run-critic.mts + matcher.mts),
  `corpusHash`, and the config; any mismatch **skips the comparison mechanically** — never
  silently misleads. **A baseline refuses to write with outages > 0**; `--fail` skips comparison
  when the current run has outages.
- `runs.log` (gitignored) appends one line per run — the anti-Goodhart ledger. Rows added after a
  prompt fix carry `holdout: true`: `--dev` excludes them (iterate freely), baseline/gate runs
  include them.

## Dataset card (33 rows: 13 intrinsic · 20 workflow · 5 decoy-only)

Every row carries a mandatory `note` (why the label is right), `difficulty`
(clear/borderline/adversarial), `provenance` (authored/mined/adapted), optional
`variantOf`/`variantKind` (invariance groups must agree — consistency is its own metric;
directional variants flip one detail and the verdict with it), and `holdout`.
`node bench.mts coverage` prints the full matrix.

Labeling protocol: **mined rows are labelled by outcome, never by the old agent's verdicts**
(anti-circularity — benchmarking the critic against its own past output would be self-consistency,
not accuracy). Sources: (a) the 5 seed trap cases from `scripts/agent-benchmarks` (absorbed here;
that runner is deleted); (b) devkit history with known outcomes — git+ssh default (sc-1057),
hooks-import-the-package, release-by-direct-push, BSD `\s` greps (sc-1042), the `.cursor/`
hardcode, the bench-gates-on-flips decision; (c) 5 verbatim real critique prompts from local
session transcripts (219 runs enumerated; session ids in the corpus notes), labels from
git-verified ships / the architecture that actually got built; (d) authored decoys, security
anchors, and adversarial keyword/verbosity confounds. Wild-format rows keep the real input shape
("## The bug" / "## Verified facts"), which differs from SKILL.md's canonical sections — format
sensitivity is visible per category.

Known limitations: (1) most non-mined row text is model-written — an in-family judge may be
gentler on in-family text (preference leakage); mined rows (15/33) are the counterweight, prefer
them as the corpus grows. (2) `feasibility` has one gold slot — documented coverage debt; grow
toward it. (3) The ~300-token summary contract check uses a chars/4 heuristic (budget 330); real
historical summaries often exceed it, so expect this contract metric to start low — that is
signal about the contract, not the bench. (4) The two RETHINK session rows' outcomes are
inferred-heeded (a different architecture shipped), stated in their notes.

## Cost (printed before any token is spent) + outage policy

Budget at K=3: 13 intrinsic × ~45 s × 3 + 20 workflow × ~3.5 min × 3 ≈ 3.8 h serial, ~1.5–2 h at
concurrency 3; matcher ≈ 24 slots × 3 votes × 3 trials × ~12 s interleaved haiku. `--dev --only`
is the iteration tier. Outages are asymmetric by cost: an intrinsic dark row aborts the run
(exit 2 — a polluted cheap run is worth less than a rerun); a workflow row tolerates per-trial
outages down to 2 completed trials, then scores NULL and counts in `outages` (exit 2 only when
everything was dark).

## Departures from decisions-eval (the house standard)

1. **Agent-spawn runner, not an imported gate runner** — no gate wires this agent; the runner
   reads the SOURCE `agents/feature-critique.md` at spawn time (never a synced copy) and the
   baseline pins `agentHash` + `runnerHash` instead of `gateHash`.
2. **`--append-system-prompt` approximates the production Task-tool spawn** (where the md is the
   subagent's system prompt). Residual gap: no Task-tool env or deep-research MCP under `-p` —
   the md itself degrades ("where research tooling is available"); unmeasured here.
3. **`guard-decisions` is not on PATH inside fixtures** — decision-log rows exercise the md's
   documented INDEX.md fallback only; the bin path is unmeasured.
4. **Matcher layer + κ audit** (open finding-set output; decisions judges emit closed labels).
5. **`results.baseline.json` is COMMITTED** (ticket DoD; decisions-eval gitignores theirs) —
   `.gitignore` covers only `runs.log` + `transcripts/`.
6. **Workflow rows are not read-only** — artifact writes are part of the contract under test.
7. **Row-level flip units** for finding-set metrics (clustering rationale above).
8. **Critic rows run K=3 at baseline/gate tier** (user ruling), where sc-1058's completeness eval
   runs its expensive reviewer K=1 + discordance-retry and gives the vote budget to the matcher.
   Shared-rule note: when both benches are on main, the matcher core (forced-choice slots, votes,
   κ) should be lifted into one shared module — tracked as the extraction trigger in matcher.mts.
9. **Floors gate NEW breaches only.** The committed baseline itself breaches the clean-rate floor
   (below), so an absolute floor would leave `--fail` permanently red and trained-ignored. A
   breach the baseline already carries prints loudly (`KNOWN FLOOR BREACH … B2 target`) but does
   not gate; the flip tables still catch that metric worsening row-by-row, and any breach that is
   new vs the baseline fails immediately.

## Results — baseline history

The committed `results.baseline.json` is the machine-readable source of truth (per-row verdicts,
slot outcomes, hashes, Wilson inputs); this table is the human-parseable summary. **Contract: any
PR that regenerates the baseline appends a row here** with the run date, the prompt change that
motivated it, and the headline numbers — so the agent's measured history stays greppable in one
place. Validate any row by re-running `BENCH_RUNS=3 node bench.mts --fail` at that commit (or
`--salvage <transcripts-dir>` against saved trials): the numbers must reproduce within the
printed MDE.

| date · change | recall (floor .75) | clean rate (floor .75) | decoy flags (ceil .25) | verdict | frame-meta | severity cal | token contract |
|---|---|---|---|---|---|---|---|
| 2026-07-06 · **B1** initial prompt (PR #26) | 0.92 (22/24) | **0.20 (1/5) — breach** | 0.20 (4/20) | 0.94 (31/33) | 1.00 (12/12) | 0.64 (14/22) | 0.65 (13/20) |
| 2026-07-06 · **B2** evidence-gated blockers + verdict coupling (PR #29) | **0.96 (23/24)** | **0.80 (4/5) — floor cleared** | 0.10 (2/20) | 0.97 (32/33) | 1.00 (12/12) | 0.78 (18/23) | 0.95 (19/20) |

All numbers: opus, K=3 majority per row, 33 rows, zero outages; matcher haiku×3, κ 0.87
(re-audit after any matcher change). Wilson 95% intervals ship in the bench output and the
baseline JSON — at n=33 this corpus is a large-effect tripwire, not a percentage-point detector;
read the intervals, not bare deltas.

**B1 reading** (the problem statement): the agent fabricated ≥1 CRITICAL blocker on 4 of 5 sound
proposals — hallucinated risk, the ticket's predicted characteristic failure, measured not vibed.
**B2 reading** (the fix): four prompt rules — explicit permission to find nothing, positive-
evidence burden for Critical Issues, verdict-blocker coupling, evidence-based severity tiers
(prior art: pr-agent / sweep / code-review-gpt restraint prompts). Every headline moved the right
way; `--fail` vs the B2 baseline exits 0. Remaining known weakness: ux-class recall 2/3 (one gold
slot) — documented debt, not worth a baseline re-buy on its own.
