# completeness-eval — accuracy benchmark for the feature-completeness reviewer gate

Scores the completeness gate (`guard-review completeness --gate` — `../completeness.mts` +
`agents/feature-completeness-reviewer.md`) against a labelled corpus, so a prompt/model edit to the
reviewer brief is a measured delta instead of a vibe. Design record:
`docs/decisions/open-ended-reviewer-gold-slots.md`.

The bench drives `runCompleteness()` **from the gate** through its injectable-exec seam, with a spy
that delegates to the real judge runner: prompt construction, Target loading (`scopedTargets`), the
stdin evidence extraction (per-file caps + OMITTED accounting, sc-1060), argv, the opus model and
the isolation flags all run inside the gate — bench and
gate cannot drift. Each corpus row materialises as a disposable git repo (base committed, staged in
the index, decoy Targets as real `docs/decisions/*.md` files) and the agentic judge investigates
that world, never the host repo.

## The hard part — scoring an open-ended findings list

The reviewer emits free text (`CRITICAL: desc | paths | impact`), not a closed label set, so there
is no confusion matrix to read off. The unit of truth is the **slot**:

- **gold** — a gap the reviewer MUST surface, with its target severity;
- **decoy** — a thing it must NOT flag: a recorded `docs/decisions/` Target it would be
  re-litigating, a deliberately out-of-scope item, or working-as-intended behaviour.

An LLM **matcher** (`matcher.mts`) maps emitted findings onto slots with one **forced-choice
question per slot** ("does any numbered finding identify the SAME underlying gap — yes (which) or
no?"), never one holistic list-to-list call — per-item decomposition measurably beats holistic
judging (TICK, arXiv:2410.10934). Findings no slot claims are *spurious* (directional signal only —
gold is not exhaustive, so an unmatched finding is not provably wrong; the decoy set is the measured
precision instrument).

| headline | formula | why that metric | gate |
|---|---|---|---|
| **gap recall** | hit gold / all gold | a missed gap is what the reviewer exists to prevent | **hard floor 0.70** |
| **false-flag rate** | flagged decoys / all decoys | decoys flagged / recorded decisions re-litigated erode trust in every future review | **hard ceiling 0.25** |
| severity calibration | exact want×got over hit gold | build-breakers must rank CRITICAL, nits must not | warn tier |

The recorded-decision subset of false-flags prints as its own line — over-flagging recorded
decisions is this reviewer's characteristic failure.

## Run

```bash
node bench.mts                 # full run: reviewer + matcher, headline metrics
node bench.mts --baseline      # write results.baseline.json (committed here)
node bench.mts --fail          # exit 1 on floor breach / significant stable case flips
node bench.mts --dev           # prompt-iteration tier: holdout rows excluded
node bench.mts --only <id>     # id-prefix subset (iteration; logged to runs.log)
node bench.mts coverage        # corpus coverage matrix — zero claude calls
node bench.mts matcher-audit   # matcher agreement vs committed labels (percent + Cohen's κ)
node mine-cases.mts            # scan local session logs → candidates.jsonl (gitignored)
```

Exit `0` = ran (no regression under `--fail`) · `1` = regression (with `--fail`) · `2` = could not
run. Sweeps: `BENCH_MATCH_MODEL=haiku|sonnet` (matcher, default haiku) · `BENCH_MATCH_RUNS=1|3`
(matcher votes, default 3). **The reviewer has no model sweep on purpose** — the gate hardcodes
opus (the gap-finder gets the strongest model or it isn't worth running) and the bench runs the
gate, not a copy.

## The matcher is an instrument, and instruments get calibrated

- **K-vote**: each slot question is asked `BENCH_MATCH_RUNS` (default 3) times through a bounded
  pool (4 in flight — an unbounded slot storm gets judges SIGTERM'd under machine contention, the
  sc-1048/sc-1049 failure class, which would read as fake outages). Non-unanimous slots are
  **unstable** and never count as regression evidence. K same-family votes reduce *variance*, not
  family bias (arXiv:2502.01534) — which is why the audit exists.
- **Audit** (`matcher-audit`): runs record per-case transcripts (gitignored `transcripts/`); a held
  sample of slot assignments is independently labelled (committed `matcher-audit.labels.jsonl` —
  authored by an adversarial model pass in a fresh context that re-derives each assignment from the
  matcher rubric, SAFE-style with disagreement adjudication; a model-authored audit is a documented
  limitation, spot-check it in review). The command prints **percent agreement + Cohen's κ** — κ,
  not raw agreement, because most slots are NONE and an always-NONE matcher "agrees" by chance.
  **Policy: κ < 0.7 → the matcher is not trusted; fix `matcher.mts` before reading headlines.**
- **matcherHash**: `matcher.mts` is hashed into the baseline alongside the gate hash — a matcher
  edit invalidates comparisons exactly like a gate edit (addition over decisions-eval, where the
  scorer is deterministic).
- Gold target severities are withheld from the matcher; calibration comes from the reviewer's
  emitted tier, unbiased. Zero-findings transcripts skip the matcher entirely (deterministic:
  all gold missed, all decoys clean).

## Statistical honesty — verbatim the house standard (decisions-eval)

Every headline ships raw counts + a Wilson 95% interval; `--fail` never gates on aggregate deltas.
Order of evaluation: comparability preconditions (config + gateHash + matcherHash + corpusHash
mismatch, or any outage → comparison SKIPPED with a message, never lied about) → hard floors →
the paired **flip table** under a mid-p McNemar test (p < 0.05), stable flips only, plus an MDE
line stating what this corpus cannot resolve.

**The flip gate clusters by CASE, not slot.** Slots within one case share a single reviewer
transcript and are positively correlated; slot-level pairing would be anti-conservative (Miller,
arXiv:2411.00640 — cluster by item source). The slot-level flip table still prints for diagnosis.
A case is *stable-flipped* only when a re-run confirms it 2-of-2 (the alignment convention):
reviewer rows are the expensive class (agentic opus, 1–6 min each), so the reviewer runs **K=1**
even at baseline tier and only baseline-discordant cases re-run once — the matcher takes the K=3
budget instead. This is the same cost split decisions-eval applies to its alignment rows; the
ticket's literal "BENCH_RUNS=3 majority vote" applies there to rows ~10× cheaper than these.

`runs.log` (gitignored) appends one line per run — the anti-Goodhart ledger; `--only` usage lands
there too. Rows added after a prompt fix should carry `holdout: true`: `--dev`/`--only` exclude
them, baseline/gate runs include them (the exam keeps questions you didn't practice on).

## Corpus (`cases-completeness.jsonl`) — dataset card

30 rows · ~34 gold slots · ~26 decoys. One JSON object per line:

```json
{ "id": "…", "category": "…", "difficulty": "clear|borderline|adversarial",
  "provenance": "authored|mined|adapted", "note": "<why the labels are right — mandatory>",
  "variantOf": null, "variantKind": "invariance|directional|null", "holdout": false,
  "message": "<commit message — the gate's intent signal>",
  "repo": { "base": {"path": "content"}, "staged": {"path": "content-or-null"} },
  "gold":   [{ "id": "g1", "severity": "IMPORTANT", "desc": "…", "paths": ["…"] }],
  "decoys": [{ "id": "d1", "kind": "recorded-decision|out-of-scope|working-as-intended",
               "targetSlug": "…", "desc": "…" }],
  "expectedVerdict": "PASS|FAIL" }
```

- `gold[].paths` are matcher hints, not string-match keys. `expectedVerdict` is informational only
  (null verdict reads as PASS, the gate's fail-open interpretation).
- Every `recorded-decision` decoy is BACKED by a real Target file in `repo.base` whose `**Scope:**`
  matches ≥1 staged file — enforced twice: a free corpus-lint (unit test + bench startup, including
  a round-trip through the gate's own `loadScopedTargets`) and a paid-run assert that the decoy's
  slug reached the prompt. An unloaded decoy is a fixture bug, not a clean slot.
- **Provenance**: `mined` rows come verbatim from devkit's own history/sessions (public repo);
  `adapted` rows are private-repo review sessions **rebuilt neutralized** — same file topology and
  gap structure, renamed identifiers, rewritten prose, zero verbatim code; `authored` rows are the
  calibration minority (controls, adversarial constructions, metamorphic variants). Mined-first is
  the counterweight to preference leakage (an in-family judge is gentler on in-family text), and
  perturbation variants hedge the memorization risk of public-history rows (arXiv:2506.12286).
- **Labeling protocol**: gold slots are gaps the real reviewer flagged AND a later commit fixed
  (verifiable by construction), or authored from the brief's own severity rubric; single-author
  labels with per-row rationale (`note`), then an adversarial audit pass re-derives each label from
  `agents/feature-completeness-reviewer.md`'s rubric — disputed slots fixed or dropped.
- `coverage` prints category × gold-severity × difficulty. Cells a category cannot populate
  (clean-complete × severity — `gold: []` by construction) are structural `n/a`, not debt.
- Categories: registration-gap · stale-user-docs · missing-error-handling · missing-entry-point ·
  band-aid-over-target · contradicts-recorded-target · incomplete-claim · cross-surface-parity ·
  interaction-regression · clean-complete (over-flag controls). Adversarial rows include two burial
  cases against the sc-1060 stdin evidence contract — one pinning the `[TRUNCATED:` path (a huge
  segment cannot eat the budget) and one pinning the `OMITTED:` path (the gap file arrives only as
  a named pointer the judge must chase) — plus keyword bait on a complete change and a verbosity
  confound hiding one absent artifact.

## Cost + outage policy

A budget derived from per-row costs prints before any token is spent: 30 reviewer rows × 60–360s
(the gate's own timeout ceiling) + ~60 slots × K=3 matcher ÷ pool 4 → realistic full tier
**~1.5–3.5 h**, worst case higher; plus one case re-run per baseline-discordant case. Iterate with
`--dev --only <id>`; the full tier is the only tier whose numbers count.

Outages are alignment-style (rows are too expensive to vaporise a run on a quota blip): a dark
reviewer scores the **case** as an outage and continues; a dark matcher slot (after one retry per
trial) scores the **slot** as an outage; any outage taints the run (`--fail` comparison skipped).
All-outage aborts (exit 2). A gate **free-skip** (exec never called: nothing staged, missing agent
brief, `noLlm`, kill-switch env) is NEVER an outage — it aborts as a fixture bug, because "the gate
didn't run" must not read as "the reviewer passed".

## Departures from decisions-eval (the house standard) — each justified

- **`results.baseline.json` is COMMITTED** (decisions-eval gitignores its own): that corpus is a
  generic seed consumers replace; this corpus is devkit-specific labelled data, and the DoD is a CI
  regression check (`--fail` needs the baseline in-tree).
- **An LLM matcher sits between judge output and metrics** (decisions parses closed labels): forced
  by the open-ended output format; calibrated + hashed as above.
- **Reviewer K=1 with retry-on-discordance even at baseline tier** (decisions votes K=3 on
  detect/depth): these rows are the alignment-cost class, where decisions-eval itself uses exactly
  this convention.
- **Case-level flip gate** (decisions gates per-row): a decisions row IS one judgement; here a case
  bundles correlated slots, so the case is the honest pairing unit.
- **No `BENCH_MODEL` sweep**: the gate hardcodes opus; adding a bench-only knob would measure a
  configuration the gate never runs.

Relationship to `scripts/agent-benchmarks/`: complements, not supersedes — that trap-set exercises
the *interactive* feature-critique surface with keyword checks; this bench measures the *gate* path
with finding-level truth.

## Matcher audit status (2026-07-06, baseline run over the v2 corpus)

All 53 matcher-judged slots (27 cases with ≥1 finding; zero-finding cases are deterministic and
carry no matcher decision) were independently labelled blind — the labelers saw findings + slot
descriptions, never the matcher's assignments — and adjudicated SAFE-style:

- **agreement 51/53 = 0.96 [0.87, 0.99] · Cohen's κ 0.936** (`node bench.mts matcher-audit`)
- Initial disagreements 3: one **matcher error** (a decoy leniency on a slot the K-vote had
  already marked unstable — unstable slots never count as regression evidence); one **label
  error** (auditor over-match, corrected in the committed labels with an `adjudicated:` note);
  one immaterial same-gap facet pick (two findings describe one gap — hit either way).
- Labels are model-authored (independent adversarial pass in fresh contexts re-deriving each
  assignment from the matcher rubric) — the documented limitation of a claude-only harness;
  spot-check `matcher-audit.labels.jsonl` (each line carries its `why`) in review.

Baseline headline numbers (committed `results.baseline.json`): gap recall 25/34 = 0.74
[0.57, 0.85] · false-flag 1/26 = 0.04 [0.01, 0.19] · recorded decisions re-litigated 1/14 ·
severity calibration 0.68 exact, dominated by IMPORTANT→CRITICAL inflation (×7) — the reviewer
over-escalates mid-tier gaps; that is the first prompt fix this bench should measure.
