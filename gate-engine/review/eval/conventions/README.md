# conventions-eval — accuracy benchmark for the conventions-reviewer gate

Scores the conventions-reviewer gate (`guard-review --gate` → the `conventions-reviewer` entry in
`../../reviewers.mts`'s `REVIEWERS` table, driven by `../../run-review.mts`'s `runCascade`, using
`../../claude-md.mts` + `../../diff-evidence.mts` for evidence and `agents/conventions-reviewer.md`
for the brief) against a labelled corpus, so a prompt/evidence-module edit is a measured delta
instead of a vibe. Follows the house standard in `gate-engine/decisions/eval/README.md` and the
open-ended-finding pattern pioneered by `gate-engine/review/eval/README.md` (completeness-eval);
every departure from both is listed at the bottom.

The bench drives `runCascade()` **from the gate** — the exact function `runReviewGate` calls per
selected reviewer — through its injectable-`exec` seam, with a spy that delegates to the real judge
runner: prompt construction (`wrapConventionsPrompt`), the governing-CLAUDE.md render
(`renderGoverningClaudeMd`), the capped diff evidence (`buildCappedDiffEvidence`), the pinned haiku
model, and the isolation flags all run **inside** the gate; the spy only observes the transcript.
Each corpus row materialises as a disposable git repo (base committed — including whatever
CLAUDE.md file(s) the row needs — staged in the index) plus the two gate assets every fixture needs
(`guard.config.json`, `.claude/agents/conventions-reviewer.md`), and the judge investigates that
world, never the host repo.

## Why this bench looks like NEITHER existing template on its own

conventions-reviewer sits at the intersection of two things no other reviewer combines:

- Like the four domain reviewers (`../reviewers/bench.mts`), it runs through the REAL gate cascade
  (`runCascade`/`REVIEWERS`/`selectReviewers`) — not a standalone gate function.
- Unlike them, it is **skill-less** (no checklist, no `expectItems` right-item attribution) — its
  output is free text exactly like completeness-eval's, so scoring needs completeness's gold-slot +
  LLM-matcher machinery (`../bench.mts` / `../matcher.mts`), not reviewer-eval's checklist-artifact
  snapshotting.

So this bench's `bench.mts` borrows reviewer-eval's fixture-materialization-over-the-real-cascade
pattern and completeness-eval's gold-slot/decoy/matcher scoring pattern, and its `matcher.mts` is a
thin wrapper over the same shared core (`gate-engine/judge/matcher-core.mts`) completeness-eval and
critique-eval already use.

## The hard part — scoring an open-ended findings list, with a scoping dimension neither prior bench has

The reviewer emits free text (`VIOLATION: <quoted rule> — <path>:<line>` paired with
`OFFENDING: <quoted line> — <path>:<line>`, or `NO_VIOLATIONS`), not a closed label set, so there is
no confusion matrix to read off. The unit of truth is the **slot**:

- **gold** — a rule violation the reviewer MUST surface;
- **decoy** — a thing it must NOT flag: a recorded exception (`recorded-decision`), a pattern that
  falls outside the scope of any rule that actually governs the touched file
  (`out-of-scope`), or code that merely resembles an anti-pattern but is working as intended
  (`working-as-intended`).

Unlike completeness's `CRITICAL`/`IMPORTANT`/`LOW` or critique's `CRITICAL`/`WARNING`, a conventions
finding has **no severity tier** — the brief's contract is a flat quote-both-or-stay-silent gate, so
`Finding`/`GoldSlot` carry no severity field and there is no severity-calibration section.

`out-of-scope` is this reviewer's OWN failure mode, unlike the other two benches: the AC's explicit
requirement that "a CLAUDE.md governs its own directory and everything below it — NEVER a sibling
directory" has to be measured directly, not inferred from a recall/false-flag pair alone. The
corpus's `scoping-*` rows exist for exactly this (see the dataset card below), and the bench reports
decoys broken out **by kind** so the scoping metric doesn't disappear into the pooled ceiling.

| headline | formula | why that metric | gate |
|---|---|---|---|
| **gap recall** | hit gold / all gold | a missed rule violation is what the reviewer exists to prevent | **hard floor 0.70** |
| **false-flag rate** | flagged decoys / all decoys | re-litigating a recorded exception, or extending a rule past its CLAUDE.md scope, erodes trust in every future review | **hard ceiling 0.25** |
| — `out-of-scope` flag rate (informational) | flagged / total, by decoy kind | the AC's own scoping-boundary metric — worth reading on its own | reported |

Same floor/ceiling **values** as completeness-eval (0.70 / 0.25) — set once from the house standard
for an open-ended-finding reviewer bench, not retro-tuned.

## Run

```bash
node bench.mts                 # full run: reviewer + matcher, headline metrics
node bench.mts --baseline      # write results.baseline.json (committed here, once generated)
node bench.mts --fail          # exit 1 on floor breach / significant stable case flips
node bench.mts --dev           # prompt-iteration tier: holdout rows excluded
node bench.mts --only <id>     # id-prefix subset (iteration; usage lands in runs.log)
node bench.mts validate        # 0 LLM calls: corpus + selection linter
node bench.mts coverage        # 0 LLM calls: corpus coverage matrix
node bench.mts matcher-audit   # matcher agreement vs committed hand-labels (percent + Cohen's κ)
```

Exit `0` = ran (no regression under `--fail`) · `1` = regression (with `--fail`) / `validate` found
bad rows · `2` = could not run. Sweeps: `BENCH_MATCH_MODEL=haiku|sonnet` (matcher, default haiku) ·
`BENCH_MATCH_RUNS=1|3` (matcher votes, default 3).

**The reviewer has NO model sweep, for a different underlying reason than completeness-eval's.**
Completeness-eval's gate hardcodes opus by a **bench-external user ruling** ("the gap-finder gets
the strongest model or it isn't worth running") — a choice this bench measures the *consequences*
of but did not itself decide. conventions-reviewer's single-pass haiku, no-cascade execution is a
**ticket mandate** baked directly into `reviewers.mts`'s `REVIEWERS` table (`model: 'haiku'`, no
`skill`) — see that file's own `Reviewer.model` docstring: *"Also used by conventions-reviewer, per
the ticket's own haiku mandate."* There is no cascade to turn on and no alternate model the gate
would ever run in production, so a bench-only sweep knob would measure a configuration that never
ships — exactly completeness-eval's own "no model sweep on purpose" reasoning, applied here to a
prompt-conditioned pin rather than a bench-external ruling.

## The matcher is an instrument, and instruments get calibrated

- **K-vote**: each slot question is asked `BENCH_MATCH_RUNS` (default 3) times through a bounded
  pool (4 in flight). Non-unanimous slots are **unstable** and never count as regression evidence.
- **Audit** (`matcher-audit`): joins a committed labels file (`matcher-audit-conventions.labels.jsonl`)
  against the latest run's saved transcripts and prints **percent agreement + Cohen's κ**.
  **Policy: κ < 0.7 → the matcher is not trusted; fix `matcher.mts` before reading headline metrics.**
- **matcherHash**: `gate-engine/judge/matcher-core.mts` + this dir's `matcher.mts`, hashed into the
  baseline alongside the gate hash — a matcher edit invalidates comparisons exactly like a gate
  edit.
- **CROSS-BENCH HAZARD (new versus decisions-eval, and versus completeness/critique pre-extraction):**
  `matcher-core.mts` is now **shared** by completeness-eval, critique-eval, and this bench (sc-1058's
  own ticket named this bench as the third-consumer extraction trigger). An edit to
  `matcher-core.mts` invalidates **all three** benches' `matcherHash` simultaneously — a single PR
  touching the shared engine can silently skip three benches' comparisons at once (each will report
  "matcher changed since the baseline — regenerate with --baseline", which is *correct* per-bench
  but easy to read as three unrelated failures if the shared cause isn't obvious). **Re-run every
  consumer's `matcher-audit` after touching `matcher-core.mts`** — completeness's, critique's, and
  this one.

### Matcher-audit label provenance — CURRENTLY SYNTHETIC, not yet mined

`matcher-audit-conventions.labels.jsonl` (10 labels) is seeded with **synthetic hand-labels derived
directly from the corpus's own gold/decoy descriptions**, not from real transcripts (see
"Matcher-audit labels are still synthetic" below). Each label's `why` field is prefixed `SYNTHETIC
seed label` and states the direct derivation (e.g. "the row has exactly one gold slot and no
decoys, so a compliant transcript's sole finding covers it"). This is a **documented limitation**,
not a substitute for the real audit. A first live baseline run (2026-07-09) has now populated
`transcripts/` (gitignored local telemetry) with 26 real transcripts; replacing this synthetic seed
with real hand-labels drawn from them — then computing a real matcher-audit κ — is the follow-up
step, since it requires independent human judgment per transcript, not just running the harness.

## Hash-comparability preconditions

A comparison against `results.baseline.json` is **mechanically skipped** (never silently lied about)
when any of these differ from the run that produced the baseline:

- `matchModel` / `matchRuns` (matcher config)
- `gateHash` — `reviewers.mts` + `run-review.mts` + `claude-md.mts` + `diff-evidence.mts` +
  `agents/conventions-reviewer.md`, hashed together. Everything that changes conventions-reviewer's
  *behaviour* lives in this hash — including the two brand-new skill-less-reviewer evidence modules
  (`claude-md.mts`, `diff-evidence.mts`) neither completeness-eval nor critique-eval depends on,
  since neither of those gates is a `REVIEWERS`-table entry.
- `matcherHash` — see the cross-bench hazard above.
- `corpusHash` — the full row set as run (not a filtered subset; `--dev`/`--only` refuse to combine
  with `--baseline`/`--fail` for exactly this reason).
- any outage in the current run (`outages > 0` → skip, "score is suspect").

## Dataset card (`cases-conventions.jsonl`)

**26 rows · 18 gold slots · 14 decoy slots.** One JSON object per line:

```json
{ "id": "…", "category": "…", "difficulty": "clear|borderline|adversarial",
  "provenance": "adapted", "note": "<why the labels are right — mandatory>",
  "variantOf": null, "variantKind": "invariance|directional|null", "holdout": false,
  "message": "<commit message — documentation only; this gate never reads it>",
  "repo": { "base": {"path": "content"}, "staged": {"path": "content-or-null"} },
  "gold":   [{ "id": "g1", "desc": "…", "paths": ["…"] }],
  "decoys": [{ "id": "d1", "kind": "recorded-decision|out-of-scope|working-as-intended",
               "targetSlug": "…", "desc": "…" }],
  "expectedVerdict": "PASS|FAIL" }
```

- `gold[].paths` are matcher hints, not string-match keys. `expectedVerdict` is informational only
  (a null verdict reads as PASS, the gate's own fail-open interpretation for that one metric).
- Every `recorded-decision` decoy is BACKED by a real `docs/decisions/*.md` file in `repo.base` —
  enforced by the free corpus lint (`lintCases`, run at load time and by `validate`) — an unbacked
  decoy would never tempt the reviewer either way, since it has no checklist/Target-loading
  mechanism of its own and can only find the file via its own Read/Grep/Glob tools.
- **Provenance: 100% `adapted`, 0% `mined`.** This is not a corner cut — it is structural. Every
  *other* bench in this repo (completeness-eval, critique-eval, reviewer-eval) mines real findings
  from devkit's OWN history, because those reviewers judge devkit's own source against devkit's own
  conventions. conventions-reviewer's entire charter is the opposite: it checks a **consumer repo's**
  own written CLAUDE.md rules, never devkit's. devkit has no CLAUDE.md of its own to mine violations
  from (and even if it did, mining devkit's own history would benchmark the reviewer against the ONE
  repo it is explicitly designed never to judge). So every row is a small, self-contained fictional
  fixture — a two-line CLAUDE.md rule plus a minimal diff that either violates it, violates it in a
  disguised way, or merely resembles a violation — with **zero verbatim text from any real company
  or personal repo**; every rule is rewritten in this corpus's own words even where a row is inspired
  by a realistic pattern (e.g. "generated files are regenerated, never hand-edited" is a pattern
  every codegen-using repo eventually writes down, in its own words).
- **Nine concepts, 2-4 variant rows each:**
  1. **generated-file edit** (`gen-file-edit-*`) — never hand-edit `app/generated/`.
  2. **forbidden prop** (`forbidden-prop-*`) — components must not accept `className`/`style`;
     includes a **directional** scope variant (identical prop added OUTSIDE the governed package).
  3. **logging discipline** (`logging-*`) — structured logger only, never raw `console.*`/print;
     the clear row pairs the gold with a `working-as-intended` decoy (a legitimate `logger.error`
     call in the same diff).
  4. **schema requirement** (`schema-pk-*`) — every new table needs a `PRIMARY KEY`.
  5. **root-cause-not-patch** (`root-cause-*`) — never clamp/guard a symptom at the call site; a
     dedicated PASS row (`root-cause-decoy-pass`) is a legitimate external-input clamp that must NOT
     be confused with the anti-pattern.
  6. **layering rule** (`layering-*`) — `packages/ui` must never import `packages/data` directly;
     includes a `recorded-decision` PASS row backed by a real `docs/decisions/*.md` exception.
  7. **naming convention buried in a big diff** (`naming-kebab-buried-*`) — new files under
     `app/components/` must be kebab-case; the violation is buried among 2-3 correctly-renamed
     sibling files (`working-as-intended` decoys), not `out-of-scope` (they're not off-topic, they
     are simply correct).
  8. **THE LOAD-BEARING SCOPING ROWS** (`scoping-*`, 3 rows) — a fictional two-service monorepo:
     `services/orders/CLAUDE.md` forbids calling the payments client directly from a handler;
     `services/inventory/` has **no CLAUDE.md of its own** and there is **no repo-root CLAUDE.md**
     in this fixture. `scoping-orders-violation-with-sibling-decoy` commits the IDENTICAL
     direct-payments-client pattern under both services in one diff (gold under orders, `out-of-scope`
     decoy under inventory) — the single most important row in this corpus, because the AC's explicit
     scoping requirement ("a dir's file applies only at/below it") lives or dies on it.
     `scoping-inventory-only-pass` isolates the same signal with orders untouched entirely.
     `scoping-inventory-nested-pass` pushes the ungoverned pattern two directory levels deeper to
     exercise the full ancestor walk.
  9. **clean control** (`clean-control-*`, 3 rows) — `gold: []`, a lexical-bait decoy mentioning the
     rule's own keywords ("type hint", "magic number", "forward ref") with zero actual violation,
     `expectedVerdict: "PASS"`. These, together with `root-cause-decoy-pass` and the two
     `scoping-*-pass` rows, are what the false-flag **ceiling** actually measures.
- **Metamorphic pairs**: `gen-file-edit-invariance` (cosmetic variant, same verdict),
  `forbidden-prop-invariance` (cosmetic variant, same verdict), `forbidden-prop-directional` (scope
  flip, verdict flips PASS). `variantOf`/`variantKind` mark all three; `variantConsistency` in
  `bench.mts` checks the invariance pair lands the same per-slot pattern.
- **Holdout**: 7 rows (every `*-adversarial` row) marked `holdout: true` — `--dev`/`--only` exclude
  them so prompt iteration can't overfit them; baseline/gate runs always include them.
- Decoys by kind (from `coverage`): `working-as-intended=9 · out-of-scope=4 · recorded-decision=1`.
- `node bench.mts coverage` prints the full category × verdict × difficulty matrix — zero claude
  calls.

## Cost + outage policy

A budget derived from per-row costs prints before any token is spent: 26 reviewer rows × 20–90s
(single-pass haiku, **no cascade** — cheaper per row than completeness's 60–360s opus-with-checklist
rows) + 32 slots × K=3 matcher ÷ pool 4. Iterate with `--dev --only <id>`; the full tier is the only
tier whose numbers count.

Outages are alignment-style: a dark reviewer scores the **case** as an outage and continues; a dark
matcher slot (after one retry per trial) scores the **slot** as an outage; any outage taints the run
(`--fail` comparison skipped). All-outage aborts (exit 2). A gate **free-skip** (exec never called,
or `selectReviewers` never fires conventions-reviewer for the row's staged files) is NEVER an
outage — it aborts as a fixture bug (`validate` catches the selection half of this for free, with
zero claude calls, before any paid run).

## Departures from decisions-eval (the house standard)

- **`results.baseline.json` is COMMITTED** (decisions-eval gitignores its own): like
  completeness/critique, this corpus is devkit-specific labelled data, not a generic seed consumers
  replace. `.gitignore` deliberately does NOT list it (only `runs.log` + `transcripts/` are local
  telemetry).
- **The gate mechanism is `runCascade`/`REVIEWERS`, not a standalone gate function.** completeness-eval
  imports and calls `runCompleteness()` directly — completeness is not a `REVIEWERS`-table entry at
  all, it's its own gate module. conventions-reviewer IS a `REVIEWERS` entry, so this bench drives it
  the way reviewer-eval drives its four checklist reviewers: through `selectReviewers` (to prove the
  row's staged files actually reach the reviewer) and `runCascade` (the exact function
  `runReviewGate` calls). `gateHash` is built from the cascade + selection + evidence modules
  accordingly, not from a single gate-function file.
- **Single-pass haiku, no cascade, no model sweep — pinned by the TICKET, not bench-decided.** See
  the "Run" section above. Every other reviewer this bench's siblings measure either cascades
  (reviewer-eval's four domain reviewers escalate haiku→opus on FAIL) or is pinned by a **bench
  finding** the ticket then encoded (correctness-reviewer: reviewer-eval measured that the opus
  escalation *subtracts* recall and the pin followed from that measurement). conventions-reviewer's
  pin came first, from its own AC ("No Bash… single-pass"), not from a bench result — so there is no
  A/B this bench could ever run to justify sweeping it.
- **An LLM matcher sits between judge output and metrics** (decisions parses closed labels): forced
  by the open-ended output format, exactly completeness/critique's reasoning — see "The hard part"
  above.
- **No severity calibration section** (completeness/critique both have one): conventions violations
  aren't severity-tiered; the brief's contract is flat quote-both-or-stay-silent.
- **100% `adapted` provenance, 0% `mined`** (completeness/critique both mine devkit's own history):
  structural, not a shortcut — see the dataset card's provenance note above.

## Matcher-audit labels are still synthetic — a real follow-up

`matcher-audit-conventions.labels.jsonl` was seeded with 10 synthetic hand-labels before any live
transcript existed (documented in-file). Real transcripts now exist under `transcripts/` (gitignored
local telemetry) from the baseline run below — replacing the synthetic seed with real hand-labels
against those transcripts, then computing a real matcher-audit κ, is left as a **follow-up step**:
it requires a human to independently judge each transcript's slot matches, which is genuine manual
effort distinct from writing the harness. `matcher-audit` today runs against the synthetic seed only
— treat its κ as a smoke test of the audit MACHINERY, not yet a validated trust signal for the
matcher itself.

## Results — baseline history

The committed `results.baseline.json` is the machine-readable source of truth (per-row verdicts,
slot outcomes, hashes, Wilson inputs); this table is the human-parseable summary. **Contract: any
PR that regenerates the baseline appends a row here** with the run date, the prompt/evidence-module
change that motivated it, and the headline numbers — so the reviewer's measured history stays
greppable in one place. Validate any row by re-running `node bench.mts --fail` at that commit: the
numbers must reproduce within the printed MDE.

| date · change | gap recall (floor .70) | false-flag rate (ceiling .25) | out-of-scope flags | recorded-decision flags | verdict |
|---|---|---|---|---|---|
| 2026-07-09 · first baseline (haiku single-pass, no cascade) | 1.00 (18/18) [0.82, 1.00] | 0.07 (1/14) [0.01, 0.31] | 0/4 | 1/1 | PASS — both floors clear |

**The one recorded-decision flag, explained (not hidden):** `layering-recorded-exception-pass`
FAILs even though `docs/decisions/ui-data-import-for-offline-cache.md` records exactly this import
as a reviewed exception, and the brief explicitly instructs checking `docs/decisions/` before any
FAIL (added specifically in response to this row's first failure — see the brief's git history).
Single-pass haiku, with no forced tool-use workflow (unlike the checklist-driven reviewers, which
have a `generate`→`check-item`→`finalize` gate that FORCES per-item investigation), answered
straight from the pre-loaded CLAUDE.md rule without actually Grepping `docs/decisions/` first. This
is a real, measured, single-row miss, not a harness bug — and it is already priced into the 0.07
false-flag rate above (1 of 14 decoys), which clears the 0.25 ceiling with room to spare. Chasing
this ONE row to zero via further prompt-tuning risks the same overfitting decisions-eval's own
house rules warn against (a bench measures the brief, it should not be reverse-engineered by the
brief). The production mitigation is the override valve (`gate-engine/review/overrides.mts`): a dev
hit by this exact false-flag in real use waives it with `OVERRIDE_<fp>_RATIONALE`, and the
fingerprint is stable per `offendingPath:offendingLine` (not the free-text VERDICT reason), so the
waiver persists across identical re-commits. Revisit if this failure mode recurs across MULTIPLE
corpus rows, not one.
