# edge-cases-eval

Ground-truth corpus of historical **`/edge-cases`** runs (sc-1118, epic 1117 Track A). The
`/edge-cases` prompt is a diff-scoped adversarial review the owner runs at the end of substantive
sessions; it reliably surfaces real bugs. sc-1119 benchmarks prompt/channel variants of an
automated edge-cases judge against this corpus; sc-1120 ships the judge. **No judge or bench lives
here** — this directory is the dataset plus the tooling that produced it.

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
4. `reconstructed-from-date-window` — commits authored up to the invocation whose files overlap
   what the session edited;
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
   hallucinations; on session-summary rows = excluded.
5. **No LLM matcher unless it gets its own mini-eval first** (sc-1061 lesson).

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
- Label-noise floor (blind haiku second pass, seed 1118, matched via the pre-registered rule):
  on 12 sampled cases the two labelers' MATCHED findings agree perfectly
  (raw 100% on verdict and wasLiveBug; κ_wasLiveBug = 1.0; κ_verdict degenerate — every matched
  pair was positive-class), but **only 25 of sonnet's 82 findings (30%) were matched by haiku at
  all** (haiku produced 56). The label-noise floor is FINDING SEGMENTATION, not label values:
  any sc-1119 variant delta smaller than the segmentation/matching noise is unresolved, and
  matcher quality dominates the benchmark's error budget (the sc-1061 lesson, now quantified).
  Rerun: `bun gate-engine/edge-cases/eval/kappa.mts --cases 12`.
