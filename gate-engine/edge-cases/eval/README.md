# edge-cases-eval

Ground-truth corpus of historical **`/edge-cases`** runs (sc-1118, epic 1117 Track A). The
`/edge-cases` prompt is a diff-scoped adversarial review the owner runs at the end of substantive
sessions; it reliably surfaces real bugs. sc-1119 benchmarks prompt/channel variants of an
automated edge-cases judge against this corpus (the bench lives here too — see "sc-1119 bench"
below; its rules are frozen in `PREREGISTRATION.md`); sc-1120 ships the judge (the judge itself
does NOT live here).

**Methodology:** this corpus went through a full research-backed methodology audit
(`docs/benchmarks/benchmark-methodology.md` — verdict, blockers, and the 20-item house checklist).
The v2 pipeline below incorporates its required fixes: time-bounded reconstruction (no solution
leakage), anchor-coverage invariants, symmetric evidence skepticism, truncation parity, an
immutable-proposals audit overlay, and a pre-registered match rule. Read that document before
designing any new benchmark.

`cases.jsonl` is a **hand-audited snapshot**, not the output of a reproducible pipeline: the
harvest reads private local stores (chat databases, session transcripts) that exist only on the
author's machine, labeling uses an LLM pass plus human review, and human corrections are frozen
into the committed rows. The `harvest → label → finalize` scripts are **provenance tooling** —
they document how rows were derived and let the corpus GROW (`finalize.mts --append`), but a fresh
clone cannot regenerate it byte-for-byte.

**Data home:** devkit is public and the corpus carries private-repo code excerpts, so
`cases.jsonl` is **NOT committed here** (gitignored). The canonical committed copy lives in the
private frink repo at `scripts/edge-cases-eval/cases.jsonl`; finalize writes the local working
copy next to this README. sc-1119's bench should read `EDGE_CASES_CORPUS` (env, absolute path)
falling back to this directory's local copy. The `__tests__/cases.test.mts` gate validates
whichever copy is present (it also honors `EDGE_CASES_CORPUS`) and skips when none is.

## Pipeline (provenance, and how to grow the corpus)

```
bun gate-engine/edge-cases/eval/harvest.mts            # stage 1: stores → raw/candidates.jsonl (no LLM)
bun gate-engine/edge-cases/eval/label.mts --limit 5    # stage 2: label proposals (COSTS TOKENS — never auto-run)
bun gate-engine/edge-cases/eval/label.mts --audit      # review queues (liveBug / noise / low-confidence)
bun gate-engine/edge-cases/eval/finalize.mts --append  # stage 3: reviewed proposals (+ audit overlay) → cases.jsonl
```

Raw intermediates live in the gitignored `raw/`. **`raw/proposals.jsonl` is immutable once
written** — human audit corrections go into `raw/audit-overlay.jsonl`
(`{ "ref": "<caseId>#<idx>", "set": { … } }` per line), which finalize applies on read. This keeps
the labeler's raw output recoverable so agreement between the model and the human audit stays
measurable (rubber-stamping and correction must be distinguishable).

Sources (bun-only, `bun:sqlite`, all read-only; agents.db is snapshotted via `VACUUM INTO` first):

| source | store | fidelity |
|---|---|---|
| `claude-code` | `~/.claude/projects/*/*.jsonl` | full tool I/O — carries the corpus |
| `frink-app` | `~/Library/Application Support/{Frink Dev,frink}/data/agents.db` (`sub_chats`) | full; a sub_chat sharing `session_id` with a transcript folds into that row (`crossRefs`) |
| `cursor` | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` (21 GB — scan takes ~1 min) | text-only bubbles; **no diffs, no model metadata** → summary anchors |

**Diff recovery — the solution-leakage rule.** The `/edge-cases` prompt commands the agent to FIX
what it finds, so every reconstruction bound is the **invocation timestamp itself, never later** —
a window extending past the invocation sweeps the fix into the anchor and the judge gets scored on
a diff where the gold bug no longer exists (the SWE-Bench+ defect, arXiv 2410.06992). Ladder,
recorded per row as `anchor.diffOrigin`:

1. `in-session` — a real hunked `git diff` output in the transcript: nearest **pre-invocation**
   output first, else the **earliest** in-turn output (never the largest — later re-diffs inside
   the turn already contain the fix);
2. `reconstructed-from-commits` — the session's own pre-invocation commit shas re-shown;
3. `reconstructed-from-branch` — the branch tip **as of the invocation instant** vs merge-base;
4. `reconstructed-from-date-window` — commits with committer-date up to the invocation (git's
   `--until` bound; rebases refresh committer dates, so post-invocation work re-committed later
   stays excluded) whose files overlap what the session edited;
5. `reconstructed-from-pr` — the PR squash (cannot be time-bounded): always flagged
   `postFixContaminated` and demoted to `session-summary`.

## Row schema

One JSON object per line, sorted by date. Enums live in `lib/schema.mts` (the validator the test
gate runs); this table is documentation, the validator is law.

| field | meaning |
|---|---|
| `id` | `{cc\|fk\|cu}-{repo}-{yyyymmdd}-{sha8(sourceRef)}` — deterministic, one row per INVOCATION (a session can invoke twice; continuation transcripts dedup on the invocation-message uuid) |
| `source` / `sourceRef` / `crossRefs` | which store, the exact message/bubble address, and folded twin rows |
| `repo` | `frink \| devkit \| qavis \| other:<name>` — owners-web (employer code) is excluded entirely at harvest |
| `branch` / `prNumber` / `date` / `model` / `provider` | run metadata; `model` is null for cursor rows |
| `promptVariant` / `promptSha` | prompt lineage (`frink-cmd-v1`, `frink-cmd-v0`, `legacy-diff-debug-chat`, `custom-<sha8>`) — the prompt text EVOLVED over time |
| `labelModel` / `labelPromptSha` | which labeler model and which labeling-prompt revision produced this row's proposals |
| `anchor.kind` | `diff` or `session-summary` — **summary rows must be excluded from the diff-scoped P/R denominator** |
| `anchor.nameStatus` | changed-file list (from diff headers, else the session's diff-stat output) |
| `anchor.diffExcerpt` | ≤300 lines / ≤12 KB, truncated at hunk boundaries; **only for allowlisted repos** (`EXCERPT_ALLOWLIST`); full diffs stay in gitignored `raw/`. **The labeler judged this exact view** (shared `lib/excerpt.mts`) — labeler and judge truncations are identical by construction |
| `anchor.coverage` | share of findings citing ≥1 file present in `nameStatus`. **Diff rows must have coverage > 0** (validator-enforced); zero-coverage rows are demoted to `session-summary` — judge recall on them would measure reconstruction error, not judge quality |
| `anchor.excerptCoverage` | same, measured against the committed `diffExcerpt` string |
| `anchor.postFixContaminated` | anchor may contain post-invocation fixes; always false on `diff` rows (validator-enforced) |
| `anchor.summary` | 2–4 sentence what-was-built (LLM-written at label time; the only anchor for cursor rows) |
| `findings[]` | see below; `[]` for degenerate rows (a labeler reply with BOTH degenerate=true and findings is a finalize error, not a silent drop) |
| `degenerate` / `degenerateReason` | the run had nothing to review (`empty-diff \| docs-only \| agent-declined \| no-response`). True degenerates are **precision guards** (a judge producing findings on them is hallucinating); `no-response` rows are extraction losses — **excluded from ALL denominators**, kept for provenance |

Per finding:

| field | meaning |
|---|---|
| `claim` | normalized one-line assertion — **match key** for sc-1119 |
| `files` | repo-relative paths implicated — **match key**; on diff rows every entry must be path-shaped (validator-enforced) |
| `text` / `severity` / `category` | the finding as stated (`severity` verbatim, `unstated` if none) |
| `verdict` | **axis 1 — what judge precision scores against.** `noise` = hallucinated / factually wrong about the code / duplicate of an existing test / below-severity trivia. A legitimate concern the session **investigated and found already handled** (`resolved-safe`) stays `worth-surfacing` — raising it is what a good reviewer does, regardless of whether the verification was a test or prose |
| `wasLiveBug` | **axis 2 — orthogonal fix-evidence.** `"true" \| "false" \| "unknown"`. Skepticism is symmetric: same-session compliance proves neither true NOR false |
| `evidence.tier` | ranked by INDEPENDENCE from the raising agent — see below |
| `evidence.detail` | must quote its source (failing-test output, `sha subject`, or user words) |
| `evidence.confidence` / `evidence.reviewed` | labeler confidence; `reviewed: true` = a human verified this label (via the audit overlay) |

## Label semantics — why the tiers are ranked by independence

The `/edge-cases` prompt **commands** test-writing + TDD-fixing, so "agent wrote a test and a fix"
is *compliance with instructions*, not evidence the finding was real — an agent can test-pin
already-correct behaviour or "fix" a non-bug it just invented. Tiers, strongest first:

1. **`f2p-in-session`** (wasLiveBug=true): test output shows the test **FAILING against pre-fix
   code, then passing** — behavioural evidence (the epic's F2P logic). Must quote the failing run.
   *Caveat: the failing test was authored by the same agent that raised the finding — a wrong test
   can fail for wrong reasons. F2P receipts are strong, not infallible; treat them as a
   calibration core, not unquestionable.*
2. **`independent-fix`**: a **different, later session's** commit addresses it (session-printed
   shas are excluded from the candidate list). Same-session commits never qualify.
3. **`user-confirmed`**: the user explicitly validated the specific finding in-session.
4. **`test-added-green`** (wasLiveBug=**unknown** by default): test written, passed immediately.
   A green first run cannot distinguish "always correct" from "fix landed before the test ran";
   `false` requires evidence the test or behaviour predates the session.
5. **`rejected`**: dismissed in-session — split by WHY: shown factually wrong → `noise` +
   wasLiveBug=false; investigated and **resolved-safe** → `worth-surfacing` + wasLiveBug=false.
6. **`none`** (wasLiveBug=unknown): verdict judged on content quality alone.

`wasLiveBug: "true"` is only legal with tiers 1–3 (enforced by `finalize.mts` and the test gate),
and every `wasLiveBug: "true"` or `verdict: "noise"` label is human-reviewed. Evidence was
gathered **mechanically before** the labeling model ran, constrained to that bundle, with
per-section budgets so no evidence class is silently truncated away.

## How sc-1119 must consume this — pre-registered contract

**Match rule (fixed BEFORE the first bench run; changing it after is p-hacking):**

1. Candidate match: judge finding J matches gold finding G iff `J.category === G.category` AND
   their file sets overlap (suffix-tolerant path comparison). If `G.files` is empty (allowed only
   on session-summary rows), fall back to claim-token Jaccard ≥ 0.35 and flag the match `fuzzy`.
2. Tie-break, one-to-one: rank candidate pairs by (a) file-overlap count, (b) claim-token Jaccard,
   (c) severity agreement — greedy assignment, each J and each G matched at most once.
3. One J covering two Gs counts both ONLY if J's file set covers both Gs' files; otherwise the
   tie-break picks one.
4. Unmatched judge findings on non-degenerate diff rows = false positives; on degenerate rows =
   hallucinations; on session-summary rows = excluded. A NON-degenerate row with zero gold
   findings (none currently exist) scores exactly like a degenerate row: true-negative material —
   any judge finding on it is a false positive.
5. **No LLM matcher unless it gets its own mini-eval first** (sc-1061 lesson).
6. **Recall denominator = ANCHORED findings only**: a gold finding enters the recall denominator
   iff its `files` intersect the anchor's file list (computable with `lib/match.mts`'s
   `overlapCount` — the same helper coverage uses). Partial-coverage rows stay in the corpus, but
   their unanchored findings are EXCLUDED from recall (a judge cannot find what its input doesn't
   contain — scoring those measures reconstruction failure, not judge quality). Precision is
   unaffected (judge FPs are judged against the whole row).

**Analysis (from the methodology audit — non-negotiable):**

- **Unit of inference = the case, never the finding.** Findings cluster within cases (v1 measured
  ICC ≈ 0.22, design effect ≈ 1.8). Use paired per-case score differences between variants,
  bootstrap-by-case or clustered SEs, McNemar for binary per-case outcomes. Never quote iid
  binomial CIs over pooled findings.
- At n≈139 cases a paired A/B resolves ~10-point deltas (power ≈ 0.75); pooled point estimates
  carry ±4–8pp. Anything smaller than (label-noise floor + paired CI) is **unresolved**, not a win.
- **Establish the label-noise floor first**: blind-relabel a uniform random 40–60 findings
  (proposals hidden), report κ next to every results table.
- All strata (generator model, anchor kind, prompt variant, evidence tier) are **descriptive** —
  no per-stratum p-values; the slices are too small (rule of three: a zero-failure n=12 slice
  still allows ~25% true failure).
- The f2p core is a **calibration/disqualification set** ("variant misses >N of the receipted live
  bugs → out"), never a ranking metric.
- Treat measured precision as a **lower bound** (gold recall is incomplete — survivorship).

**Judge-bias controls (all-claude generator→labeler→judge pipeline):**

- **Blind the judge**: strip model names, provider/tooling identifiers, and all provenance from
  judge inputs.
- **Normalize finding style** (uniform template, strip markdown) before any judge comparison —
  style bias dominates position bias.
- **Mirror item order** across the two variants of a paired comparison.
- Run one **non-Claude judge or labeler on a stratified subsample**; report the family gap next to
  headline numbers (labelled "consistent with self-preference", not proof).
- After the first run, **hand-audit exactly the findings where variants disagree with the label**
  (disagreement-triaged audit) — cheapest way to turn ranking-deciding points into gold.

## sc-1119 bench

The benchmark harness consuming this corpus under the contract above. **`PREREGISTRATION.md` is
the rule book** — denominators, match rule, decision rule, seeds, K, gates and amendments are
frozen there before any judged run; this section only orients.

- `counts.mts` — denominator source of truth (derived, test-pinned; never hand-counted).
- `guards-generate.mts` — synthetic precision-guard rows (pure-prose docs-only commits at pinned
  shas → gitignored `guards-synthetic.jsonl`; regenerable).
- `prompts.mts` — frozen arms (shape F/P × length S/L), channel wrappers (U / G-user / G-sys ×2
  realizations), shared JSON footer, blinded judge-input projection, prompt shas.
- `noise-audit.mts` — the REQUIRED label-noise floor (stratified blind n=60, two-axis relabel,
  opus via `claude -p`; gemini cross-family leg opt-in via `--with-gemini`; frozen bundles, AC1
  gate, owner-adjudicated ε posteriors).
- `bench.mts` — K=3 grid runner (12 configs), pre-registered scoring via `lib/match.mts
  matchFindings`, nested label-perturbation bootstrap, `--ceiling` calibration (sets the ship
  target T = max(0.6·C, 0.35)), `--analyze` (paired Δs + audit queue), `--baseline`/`--fail`
  (flip-table regression gate with comparability hashes).
- `results.baseline.json` — committed results (IDs + numbers only; enforced by the
  results-privacy test).

Run order: `--ceiling` → `noise-audit --sample/--run/--report` → owner adjudication →
`noise-audit --epsilon` → `--all` → `--analyze` → owner queue → `--baseline`.

### Results — LOCKED VERDICT (run 2026-07-14→16, sonnet/haiku, K=3, 12 configs × 135 rows)

**No config ships.** Every one of the 12 pre-registered configs fails at least one gate; the
verdict is robust under the full disputed-label bracket (below). sc-1120 does **not** ship a judge
on this corpus/prompt set as-is.

| # | config (model·shape·channel·real) | macro recall | receipts /7 | guard fire /26 | flags |
|---|---|---|---|---|---|
| best-recall | son·PS·G-user·r1 | **0.315** | 5 | 18 (69%) | GUARD-DQ |
| only guard-passer | son·FL·G-user·r1 | 0.214 | 2 | **5 (19%)** | soft-receipts |
| best haiku | hai·FS·G-sys·r1 | 0.179 | 0 | 15 (58%) | GUARD-DQ + soft |

Target **T = 0.35** (= max(0.6·C, 0.35); ceiling **C = 0.512** — the matcher+segmentation+phrasing
cap on ANY judge, measured judge-free). Gates: macro recall ≥ T · nested-CI lower ≥ T−0.15 ·
guard fire-rate ≤ 20% of the 26-row diff-shaped guard stratum · ≥4/7 receipts.

Findings:
- **Nobody clears the recall bar.** Highest is 0.315 (< 0.35), and its CI lower bound is 0.16.
- **A hard trade-off, not a tuning gap.** The prompt that finds the most (procedural-short, 0.315)
  hallucinates on **69%** of pure-documentation diffs; the only prompt that stays under the 20%
  hallucination gate (findings-analytic-long, 19%) finds just 0.214. No config is on the right side
  of both — E2/E3 (shape × length) buys recall only by trading away precision.
- **Configs are statistically indistinguishable in recall.** Every paired Δ vs the best config has a
  bootstrap CI spanning 0, Wilcoxon p ≥ 0.05, McNemar non-significant (discordant pairs ≤ 7) —
  exactly the n=19 power ceiling the pre-registration declared. We can disqualify, not rank.
- **Provenance (E1) — the ticket's headline question — is a NULL.** Owner-voice vs gate-user vs
  gate-system framing (2 paraphrases each, paired per-case): sonnet macro recall 0.220 / 0.226 /
  0.242, all deltas ≤ 2.2pp, Wilcoxon p 0.46–0.65; finding volume, hallucination rate and pushback
  all overlap. Whether the judge believes a human or an automated gate asked makes no measurable
  difference to finding quality for this wrapper set. → sc-1120 picks the delivery channel on
  engineering grounds, not sycophancy grounds.
- **Label-noise floor:** blind opus relabel + owner adjudication put the decision-stratum label
  error at **1/38 (~2.6%)**, Beta(2,38) — folded into every CI via the nested bootstrap. The raw
  AC1 gate "failed" purely because the blind protocol hides the session context that justifies
  resolved-safe findings (documented; not a labels problem).
- **Sensitivity bracket (settles the checkpoint-2 audit queue):** the guard gate is
  label-independent (synthetic docs guards), and only son·FL·G-user·r1 passes it. Even declaring
  **all 22** never-recalled gold findings label errors lifts its recall only 0.118 → 0.164 — still
  under half of T, with 2/7 receipts. No adjudication of the 22-item / 60-extra audit queue
  rescues any config. Verdict is robust, not provisional.

Why this is the useful answer: the ceiling C = 0.512 says half the distance to "perfect" is
matcher/segmentation friction, not judge intelligence — so the next move for edge-cases autonomy is
matcher + prompt work (and the sc-1131 known-bug slice for real recall power), NOT shipping a gate
that finds a quarter of the issues while crying wolf on two-thirds of docs commits. Full per-config
numbers, CIs, provenance table, κ/AC1 and seeds: `results.baseline.json` +
`raw/bench/analysis.json`.

Summary-tier (session-summary rows, descriptive-only, feeds no gate) was **not run** — it is
purely a modality sanity check and the no-ship verdict does not depend on it; skipped to conserve
subscription quota (a pre-declared ponytail cut).

**Corpus errata found by the checkpoint-2 audit (DEFERRED to the next corpus regen — NOT applied
here, so the committed baseline stays in sync with the corpus it scored, and the merged frink
corpus is untouched for a verdict-irrelevant delta the sensitivity bracket already covers):**
- `cc-frink-20260616-60a58840#4` — `wasLiveBug: unknown → true`, tier `test-added-green →
  f2p-in-session`: the frozen bundle shows the concurrency-guard test failing at 11:32:46 then
  passing at 11:35:03 (a real f2p receipt the original label missed as a same-turn green).
- `cc-devkit-20260703-f8944646#10` — `verdict: worth-surfacing → noise`: the finding is a
  test-scope triage note (a not-worth-testing boundary), not an edge-case assertion (both triage
  passes + owner agree). Fold both via `raw/audit-overlay.jsonl` + `finalize` on the next corpus
  cut (tracked as an sc-1118 follow-up).

### Research notes (sc-1119 Phase 0 — provenance/channel design inputs)

- **Instruction hierarchy / channel authority:** models are trained to weight system > user >
  tool text (2404.13208); in agentic settings tool-delivered instructions carry the lowest trust
  and frontier models resolve multi-source conflicts poorly (~40%, ManyIH 2604.09443). This is
  why the provenance experiment exists: gate-delivered findings may be argued with where
  user-attributed asks are not.
- **Authority/sycophancy mechanics:** models respond in a GRADED way to perceived authority,
  unprompted and mechanistically localized (2607.00415); but simple user opinion statements
  induce sycophancy where expertise framing does NOT (2508.02087), and stated confidence
  modulates it (2410.14746); baseline preference-driven sycophancy: 2310.13548. Design
  consequences (all in `prompts.mts`): wrappers carry attribution ONLY — zero opinions about the
  code, zero confidence claims, matched mood/length; the first-person shift inherent to
  owner-voice framing is BUNDLED with the attribution construct (2508.02087 shows person itself
  matters) and results are scoped to the wrapper set, not the construct.
- **LLM-as-judge pitfalls** (style/position/self-preference biases): covered by the house
  methodology (`docs/benchmarks/benchmark-methodology.md` items 9–12) — the bench's scorer is a
  DETERMINISTIC matcher, so judge-side bias enters only through the corpus labels (addressed by
  the blinding, uniform output footer, and the noise audit's cross-family relabel).

## Known biases (accepted, documented)

- **Survivorship / recall blind spot:** the corpus only contains what historical runs FOUND — it
  measures variant precision and relative recall, never absolute recall. Open-source known-bug
  slice = sc-1131.
- **Self-generated F2P:** the failing tests behind `f2p-in-session` were written by the same agent
  that raised the findings (see tier-1 caveat).
- **Evidence recall floor:** later-commit matching is file/keyword overlap — renamed-file fixes are
  missed, so some genuinely-real findings sit at `wasLiveBug: "unknown"`.
- Single user, single machine, frink-heavy repo skew; cursor rows lack models and true diffs; the
  prompt text drifted over two years (stratify by `promptVariant`).
- The scrub gate catches **modeled** secret shapes and machine paths only; the repo excerpt
  allowlist and PR review cover what patterns can't.
- The degenerate slice is small — it bounds only catastrophic hallucination. Growing it
  (empty-diff/docs-only anchors need zero labeling spend) is the cheapest capacity add.

## Corpus stats (snapshot v2, 2026-07-13)

- **139 cases, 575 labeled findings**, spanning 2026-03-11 → 2026-07-12. Sources: 85 claude-code ·
  45 cursor · 9 frink-app. Repos: 111 frink · 19 devkit · 8 qavis · 1 frink-marketing.
- **Diff-scoped spine (the primary denominator): 31 diff rows** — 19 finding-bearing (9 at full
  anchor coverage; median 0.5+) + 12 empty/degenerate precision guards. Origins: 15 date-window ·
  9 in-session · 5 commits · 2 branch — all time-bounded at the invocation instant (no solution
  leakage by construction).
- **35 rows demoted to session-summary by the zero-coverage invariant**: their leakage-safe
  anchors genuinely don't contain the findings' files (the session's work was uncommitted at
  invocation, or the captured diff was a stray). This is the honest cost of the v1 audit's
  blockers — v1 reported "77 diff-anchored" but 66% of those anchors could contain the post-fix
  code and 43% of findings were unmatchable. 19 clean rows beat 77 corrupted ones.
- 108 session-summary rows total (incl. 45 cursor). Degenerates: 9 true (4 agent-declined ·
  3 docs-only · 2 empty-diff) + 37 `no-response` extraction losses (excluded from ALL denominators).
- Findings: verdict `worth-surfacing` 534 / `noise` 41 (7.1%). `wasLiveBug`: true 19 · false 133 ·
  unknown 423 — the v2 symmetric-skepticism rule moved ~200 unverifiable green-first-run findings
  from `false` (v1's forced mapping) to `unknown`.
- Evidence tiers: `f2p-in-session` 18 · `user-confirmed` 1 · `test-added-green` 198 · `rejected`
  129 (of which 88 resolved-safe → worth-surfacing under the v2 split; 41 rejected-wrong → noise) ·
  `none` 229.
- Review state: 100% of `wasLiveBug:"true"` and `verdict:"noise"` labels human-audited (60
  findings; evidence quotes verified verbatim against raw bundles; recorded via the audit
  overlay). Labeler: sonnet (`labelModel`/`labelPromptSha` per row).
- Prompt variants: `frink-cmd-v1` 87 · `frink-cmd-v0` 43 · `legacy-diff-debug-chat` 1 · custom 8.
- **Matcher/segmentation pilot** (blind haiku second pass, 12 cases, seed 1118 — NOT the
  label-noise floor; the methodology requires a blind uniform 40-60 finding audit, which is a
  REQUIRED sc-1119 pre-step and has not been run yet): matched findings agree perfectly (raw 100%
  on verdict and wasLiveBug; κ undefined — every matched pair single-class), but only 5 of
  sonnet's 82 findings match under the strict pre-registered rule (a looser claim-similarity
  matcher yields 25 — and overstates agreement, which is why the strict rule is the registered
  one). What this pilot DOES establish: finding SEGMENTATION dominates labeler disagreement, so
  matcher quality dominates the benchmark's error budget (the sc-1061 lesson, quantified).
  Rerun: `bun gate-engine/edge-cases/eval/kappa.mts --cases 12`.
