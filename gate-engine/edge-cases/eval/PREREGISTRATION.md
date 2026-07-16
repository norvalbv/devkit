# sc-1119 PRE-REGISTRATION — edge-cases judge benchmark

Frozen BEFORE the first judged run (commit history is the audit trail: this file + `prompts.mts` +
`bench.mts` + `noise-audit.mts` land in a commit that strictly precedes every results commit).
Changing any rule below after seeing results is p-hacking under the consumption contract
(README.md "How sc-1119 must consume this"). Executable mirrors of these rules live in
`bench.mts` / `noise-audit.mts` and are pinned by `__tests__/bench-scoring.test.mts`,
`__tests__/noise-audit.test.mts`, `__tests__/match.test.mts`, `__tests__/counts.test.mts`.

Design provenance: 5 feature-critique rounds on the plan (2 contract/feasibility, 1 statistics,
2 verification) — all blockers were resolved at pre-registration time; the load-bearing changes
are recorded as amendments in §9.

## 1. Denominators (derived by `counts.mts`, pinned by its test — never hand-counted)

Corpus v2 snapshot 2026-07-13 (139 cases / 575 findings), `EDGE_CASES_CORPUS` or local copy.

- Judged rows: **102** = 23 diff (19 finding-bearing + 4 true guards) + 79 summary (74 bearing +
  5 true guards). The 37 no-response rows are NEVER judged (contract: excluded from all
  denominators; the corpus README's "12 diff guards" figure counts 8 no-response rows).
- Recall denominator: **79 anchored ∩ worth-surfacing** findings on the 19 bearing rows
  (anchored = `finding.files ∩ anchorFilesOf(nameStatus)` via `lib/match.mts`, the same parse
  that computed the committed coverage). Per-row counts: 1×7, 2×2, 3, 4, 5, 7×3, 8×2, 9, 10.
- f2p core: **7 anchored `wasLiveBug:"true"` receipts** — disqualification material only.
- **1 anchored noise finding** — the spine's only labeled precision positive; precision therefore
  lives on the guard rows.
- Synthetic guard extension: `guards-generate.mts` at pinned shas (devkit 86bb201f…, frink
  1394feb0…), pure-prose purity glob (`*.md|*.mdx`, `docs/`, LICENSE-class; config/build/lockfile/
  CI excluded), fenced-code rejection, **22 rows generated**; spot-check performed 2026-07-13:
  2 heuristic flags, both manually cleared as indented prose bullets. Guard gate stratum =
  4 true diff guards + 22 synthetic = **26** (≥ the pre-registered minimum 15; below 15 the guard
  gate is descriptive-only). The 5 summary-modality true guards are descriptive. **Scope: this
  bounds prose-hallucination, not over-flagging on correct code.**

## 2. Match rule (contract items 1–3 — ONE implementation: `lib/match.mts matchFindings`)

1. Candidate: same `category` AND suffix-tolerant file overlap; a side with empty `files` falls
   back to claim-token Jaccard ≥ 0.35, flagged `fuzzy`.
2. Tie-break one-to-one: greedy by (file-overlap count, claim Jaccard, severity agreement).
3. Item-3 exception (contract literal): one judge finding J counts a second gold G ONLY when
   J's files cover BOTH its greedy match's files and G's files (suffix-tolerant ⊇; empty gold
   file lists never covered). Credits consume no judge finding, each gold credited once,
   **item-3 credit share reported per config** (recall-gaming visibility).
4. No LLM matcher anywhere.

## 3. Scoring (per run k of config × bearing row)

- recalled = matched gold (greedy + item-3) ∩ anchored-WS; per-case recall = |recalled| / |anchored-WS|.
- Precision is judged against the WHOLE row's gold; **a match to a `verdict:"noise"` gold is an
  FP** (the judge reproduced a claim verified wrong), never recall credit.
- Unmatched judge findings: bearing rows → FP (precision = lower bound — survivorship; never a
  sole disqualifier); guard rows → hallucination; summary rows → excluded.
- Zero-finding reply on a bearing row → recall 0 (silence scores worst). Per-case F1 with TP=0 → 0.
- Judge output coercions: unknown category → `other`; unknown severity → `unstated`; non-string
  files dropped. At most TWO exec attempts per cell (outage retry or one re-ask on unparseable);
  a still-unparseable cell is recorded `parseFailed` and scores as a zero-finding run —
  parse-failure rate is a pre-declared provenance outcome (pushback/non-compliance).

## 4. Runs per cell, stability

- **K = 3** runs per (config, diff-set row) — house `bench-gates-on-flips-not-deltas` reasoning
  (measured ~13.6% judge flip rate), a fortiori at n=19. Per-cell score = mean over K.
- Guard row "fires" on a MAJORITY of its K runs producing ≥1 finding.
- A receipt counts recalled when recalled in a MAJORITY of its row's K runs.
- Between-run stability (finding-count SD + pairwise recalled-set Jaccard) reported per config —
  the first measurement of this judge's nondeterminism.
- Summary tier: K = 1, **descriptive only**, run for `son-FS-Guser-r1` (reference) + the winner.

## 5. Config grid (EXACT; 12 cells; cost order = listed order, cheapest first)

| # | id | model | arm | channel | realization |
|---|---|---|---|---|---|
| 1 | hai-FS-U-r1 | haiku | FS | U | r1 |
| 2 | hai-FS-Guser-r1 | haiku | FS | G-user | r1 |
| 3 | hai-FS-Gsys-r1 | haiku | FS | G-sys | r1 |
| 4 | son-FS-Guser-r1 | sonnet | FS | G-user | r1 |
| 5 | son-FS-Guser-r2 | sonnet | FS | G-user | r2 |
| 6 | son-FS-U-r1 | sonnet | FS | U | r1 |
| 7 | son-FS-U-r2 | sonnet | FS | U | r2 |
| 8 | son-FS-Gsys-r1 | sonnet | FS | G-sys | r1 |
| 9 | son-FS-Gsys-r2 | sonnet | FS | G-sys | r2 |
| 10 | son-PS-Guser-r1 | sonnet | PS | G-user | r1 |
| 11 | son-FL-Guser-r1 | sonnet | FL | G-user | r1 |
| 12 | son-PL-Guser-r1 | sonnet | PL | G-user | r1 |

Cost order rationale: model tier ≫ prompt length; channel/realization are cost-neutral and keep
enumeration order. Experiments read off the grid: **E2 shape** = 4 vs 10 (FS vs PS); **E3
length** = 4 vs 11 and 10 vs 12 (S vs L within shape); **E1 provenance** = {6,7} vs {4,5} vs
{8,9} on the FIXED a-priori shape FS (decoupled from the shape race by design — no
data-dependent stimulus selection), plus 1 vs 2 vs 3 on haiku. Provenance outcomes pre-declared:
per-case anchored-WS recall, findings-per-row count, guard false-alarm, parse-failure
(pushback) rate. Claims are scoped to THIS wrapper set (2 paraphrase realizations per channel;
single-stimulus caveat stands). G-sys documented confound: `--append-system-prompt` appends to
Claude Code's large default system prompt — the G-user↔G-sys contrast isolates framing
POSITION under identical default baggage, not a clean-room system role.

PL adaptation record (frink-cmd-v1 body; ONLY these edits): opening clause → "Given what was
built (summarized below) and the git diff related to it"; "carried out in the same branch …
what you've built and what we've discussed during the current session" → "in this change …
what was built in this change"; test-building instructions → reporting ("Please report all",
"omit them from your findings", "if you spot a bug, great — report it as a finding"); TDD-cycle
sentence dropped. Everything else verbatim, including the Frink context bullets (kept even for
devkit/qavis rows — authentic long-procedural arm).

## 6. Decision rule

- **Ranking metric**: mean per-case anchored-WS recall (macro) over the 19 bearing rows.
  Micro-recall, per-case F1 and FP-per-row reported secondary; macro/micro robustness stated.
- **Hard gate**: majority-fired guard rows > 20% of the guard-stratum N → disqualified.
- **Soft gate**: < 4 of the 7 receipts recalled → advisory flag (blocks "shippable", not ranking;
  n=7 is too fragile for a hard out — all 7 receipts are gold-audited in the noise audit).
- **Ship target**: T = max(0.6 × C, 0.35), where **C = macro-mean per-case re-extraction recall**
  (ceiling calibration, §7). C < 0.45 → **matcher-limited**: no numeric target derivable, verdict
  qualitative/blocked. A config **clears** iff macro recall ≥ T AND nested-CI lower ≥ T − 0.15
  AND guard gate passed AND no soft flag. Rationale: historical manual runs score 1.0 by
  construction; a zero-marginal-cost judge clearing 60% of the measured achievable ceiling is
  the advisory bar.
- **Winner = cheapest config clearing the target** (grid order). None clears → verdict is
  "no config ships" — a legitimate outcome.
- **Honest power statement**: at n=19 the paired design detects only gross deltas
  (MDE ≈ 15–20pp recall at 80% power). This sweep can disqualify, verify the absolute target,
  and detect large effects; it cannot rank close configs. Near-equivalence claims are deferred
  to sc-1131. All paired Δs vs the best config are reported with CIs, descriptively.

## 7. Ceiling calibration (pre-lock, judge-independent)

Re-extract findings from each bearing row's GOLD RESPONSE text (`raw/candidates.jsonl`,
author-machine store) — response-ONLY input, model **sonnet**, K=3, same JSON footer/enums as
the judge (`CEILING_PROMPT` shares `FOOTER`; test-asserted) — scored through `matchFindings`
against gold. C = per-row mean over K, then mean over rows (SAME aggregator the ranking uses);
median reported descriptively. C measures the matcher+segmentation+phrasing layer that caps ANY
judge; judge skill is not involved. Result recorded in §10 below and in
`results.baseline.json`.

## 8. Statistics

- **Nested label-perturbation bootstrap**: B=2000, seed 1119 (mulberry32), percentile CI. Per
  replicate: resample the 19 cases with replacement → pick ONE of the K runs per case (run
  variance) → draw ε once from the diff-decision-stratum Beta posterior (inverse-CDF-on-grid,
  4096 points — exactly one uniform per draw, bit-reproducible) → flip each anchored-WS gold OUT
  w.p. ε and each anchored-noise gold IN w.p. ε (a flipped-in noise gold counts recalled iff the
  judge had matched it). Flip decisions are SHARED between the two configs of a paired Δ (label
  noise is a property of the gold). Label noise enters ONLY by perturbing gold inside the
  resample — never as a scalar added to a CI.
- ε posterior: **Beta(wrong + 1, right + 1)** per stratum, denominator = the FULL audited
  stratum (agreements count correct); "wrong" = owner-adjudicated label errors (verdict axis +
  well-formedness flags adjudicated against gold).
- Sampling-only BCa CI reported alongside (jackknife over the 19 cases).
- Wilcoxon signed-rank on paired per-case deltas: cross-check, descriptive.
- McNemar: exact mid-p on per-case majority binaries (recalled ≥1 / guard fired), reported as
  discordant counts + Clopper-Pearson CI — **descriptive** (b+c ≤ 7 structurally; a mid-p
  cannot reach 0.05 below b+c=5).
- `--fail` regression gate (house flip-table): per-case binary flips vs the committed baseline,
  worse-direction mid-p < 0.05 → FAIL. Comparability hashes (corpusHash, guardsHash,
  matcherHash, benchCodeHash, promptShas, K, seeds) mismatch → SKIP exit 2, never a
  false PASS/FAIL. Baseline stores the winner WITH its CI (winner's-curse guard: regressions
  trigger on flips, not on the optimistic point estimate).

## 9. Noise audit (REQUIRED first; kappa.mts pilot ≠ the noise floor) + amendments

- Sample: n=60, seed 1119, Fisher-Yates — **all 7 receipts + the 1 anchored-noise finding + 30
  of the 72 remaining anchored-WS diff findings + 22 uniform over the remaining 495**.
  Per-stratum reporting; nothing pooled into one headline.
- **AMENDMENT (recorded before any relabel)**: the contract README says "blind-relabel a uniform
  random 40–60 findings". Uniform-60 would put ≈8 items on the decision slice (80/575 ≈ 14%)
  and ~0.7 on the f2p core — the gate would be estimated off the slice that decides everything.
  The methodology's own sc-1119 prescriptions say "stratified by anchor kind". Registered
  resolution: stratified-60 as above, global floor still measured (its own stratum). The
  contract's "all strata are descriptive" rule governs CONFIG-PERFORMANCE strata; gating LABEL
  reliability on the decision stratum is a different use.
- Blind relabel of HANDED findings (no matching step — segmentation blindness cannot recur),
  judgment axes only. Shown: claim/text/files/category/severity (+ anchor). **Hidden: verdict,
  wasLiveBug, tier, evidence.detail, evidence.confidence** (detail quotes the fix/test and
  would hand the answer). Two-axis split: **verdict truly blind** (finding + anchor only — this
  ε drives the perturbation); **wasLiveBug+tier against a freshly-gathered mechanical bundle**
  (`gatherEvidence`, frozen at sample time to `raw/noise-audit-bundles.jsonl`) — reported as
  evidence-grading reproducibility, never conflated with the verdict floor. Relabelers also
  return a well-formedness flag (`well-formed|mis-segmented|wrong-files|not-a-finding`) feeding
  ε as candidate denominator errors.
- Relabelers: claude **opus** (`claude -p`, subscription — owner cost directive 2026-07-13).
  **Gemini cross-family leg is OPT-IN** (`--with-gemini`; gemini CLI v0.16.0 DEFAULT model —
  never legacy gemini-2.5-pro, which also hard-errors here; neutral cwd, since from a repo cwd
  the CLI goes agentic; byte-identical input to opus). Without it, the contract's non-Claude
  labeler leg is a **documented limitation reported next to headline numbers**; the accuracy
  anchor is owner adjudication either way (recorded before any relabel ran). Residual: no non-Claude BENCH judge exists — gemini covers the
  labeler leg of the contract's "non-Claude judge or labeler"; judge-ranking self-preference
  stays unmeasured (reported as a limitation).
- Evidence-window drift: cases dated > **2026-06-29** (40 of 139) have an open 14-day
  reconstruction window; wasLiveBug stats reported with/without them.
- **GATE**: Gwet's AC1 ≥ 0.667 on the diff-decision stratum, VERDICT axis, OPUS-vs-committed-gold.
  κ/PABAK/raw agreement reported alongside for every stratum. Single-class NaN κ with raw
  agreement ≥ 0.9 = PASS (κ-paradox clause). AC1 miss → owner inspects disagreements for
  information-gap artifacts (the blind view lacks repo/test state, so
  "duplicate-of-existing-test" noise cannot be reproduced — gated stratum holds ~1 noise
  finding, impact ≈ nil) BEFORE any re-audit pivot.
- **Human checkpoints**: (1) owner adjudication of the disagreement+flag queue → ε posteriors —
  blocks Phase-4 interpretation; (2) post-sweep disagreement-triaged queue (gold unmatched by
  ALL configs = candidate label errors; judge extras matched by ≥2 configs = candidate
  omissions). Sensitivity bracket over the FULL disputed set, both directions (Manski bounds):
  ranking robust → verdict stands pending audit; fragile → provisional.

## 10. Measured pre-lock values (filled at lock time, before any judged config run)

- Guard stratum N: **26** (4 true + 22 synthetic).
- Ceiling (run 2026-07-13, sonnet, K=3, 19 rows): **C = 0.512** macro-mean (median 0.667;
  per-case range 0.00–0.87, two rows at 0.00) → NOT matcher-limited (C ≥ 0.45) →
  **T = max(0.6 × 0.512, 0.35) = 0.35** (the floor binds). Reading: the
  matcher+segmentation+phrasing layer already caps ANY judge at ~0.51 macro recall — a judge at
  T=0.35 clears ~68% of the measured achievable ceiling.
- Prompt shas: `PROMPT_SHAS` in `prompts.mts` (footer, arms, wrappers, ceiling), also embedded
  in `results.baseline.json.hashes`.
- Owner amendments before first relabel/judged run: gemini leg opt-in (see §9), recorded
  2026-07-13.

## 11. Outcome (stamped after the run — 2026-07-16)

- Noise audit: opus blind relabel + owner adjudication → decision-stratum label error 1/38
  (ε = Beta(2,38)); global stratum 0/22. Raw verdict-AC1 gate "failed" from blind-protocol
  information poverty (resolved-safe findings need the hidden session context), not label error —
  owner-inspected per the registered miss path.
- Ceiling C = 0.512 (not matcher-limited) → T = 0.35 (floor binds).
- Sweep: 12 configs × 135 rows × K=3 = 1,620 transcripts, 0 outage-poisoned (a mid-run usage-limit
  window wrote 1,267 judge-unavailable cells; purged, and the runner patched so outages no longer
  persist as transcripts — bench.mts "outage is not data" guard).
- **Verdict: NO CONFIG SHIPS** (every config fails ≥1 gate; robust under the full disputed-label
  sensitivity bracket). Provenance (E1) = null. Best recall 0.315 < T; only guard-passer recalls
  0.214. Details in README "Results" + `results.baseline.json` + `raw/bench/analysis.json`.
- Two corpus errata deferred to the next regen (README).
