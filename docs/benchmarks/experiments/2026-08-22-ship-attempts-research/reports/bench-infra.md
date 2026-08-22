Based on systematic reading of the benchmark infrastructure files, here are the comprehensive findings:

## ROW-SCHEMA

**All fields in a corpus row** (corpus.mts:ROW_ENUMS + lintRows):
- `id` (string, required, unique per reviewer)
- `reviewer` (string, required — must match file's reviewer name)
- `expected` (enum: 'FAIL' | 'PASS', required)
- `expectItems` (string[], required only when expected='FAIL', non-empty)
- `reasonPattern` (string, optional regex for right-reason attribution, fails scoring if malformed)
- `note` (string, required — "why the label is right")
- `repo` (object, required: `{base: {...}, staged: {...}}`)
  - `base`: key→string map of files (committed state)
  - `staged`: key→string map of files (staged changes)
- `difficulty` (enum: 'clear' | 'borderline' | 'adversarial', optional)
- `provenance` (enum: 'authored' | 'mined' | 'adapted' | 'known-answer', optional)
- `holdout` (boolean, optional; excluded by `--dev` flag)
- `caseId` (string, optional — clusters rows for flip-table reporting)
- `sourcePr` (number, optional)
- `outcomeEvidence` (optional enum, for mined-corpus metadata)
- `scopeConfirmed` (optional enum: 'confirmed' | 'out-of-scope' | 'unverifiable')
- `variantOf` (string, optional — documentation-only, no metric reads it)

**Fixture materialization** (corpus.mts:validateRow, bench.mts:runRow):
- Gate assets (guard.config.json, agent brief, checklist script, shared helpers, SKILL.md) are INJECTED into `repo.base` at runtime
- Backend rows stage under `api/`, frontend rows under `web/`, correctness under any of `api/web/src/`
- `selectReviewers` must fire exactly the target reviewer; if selection fails, row scores as "not-selected" miss
- Fixture is ephemeral: `materializeFixture()` creates a temp repo, test runs, `cleanup()` removes it

**Size limits**: 
- Individual files: no stated cap per file; practised ~25 lines or less (README.md line 71: "hold fixtures ≤25 lines" *in the methodology doc* — this is a MEASUREMENT design rule, not a hard gate limit)
- Repository cap: corpus-growth.md notes mined examples average 7.9 files / 26 KB (real production inputs); bench fixtures are intentionally *smaller* to isolate the bug, not representative of real diff scale
- Diff archival cap (diff-archive.mts:30): ARCHIVE_MAX_BYTES = 8 MiB raw (pre-gzip), capped to prevent disk bloat; judge sees 60KB cap (evidence/diff-evidence.mts, different purpose)
- **No hard rowHash-level enforcement** — a row *can* carry multi-file diffs; nothing prevents it technically, but the corpus's DESIGN CHOICE is small, focused fixtures so attention dilution won't dominate the measurement (methodology.md addendum: "fixtures are 1–2 files ≤25 lines while production correctness inputs average ~7.9 files / 26 KB")

**To support large multi-file diffs (2–10k LOC):**
- Would require a NEW corpus track: "scale-limited" rows alongside "focused" ones, pre-registered separately
- Would need validation that `selectReviewers` fires correctly on that file layout
- Would need updated difficulty/provenance labeling calibrated for scale (items currently sparse at smaller scales)
- Diff archival ALREADY supports it (8 MiB cap, content-addressed gzip storage at `<telemetry-dir>/diffs/<sha256>.diff.gz`)
- Judge input ALREADY caps at 60KB, so only the first ~1500 LOC would be visible to the reviewer; a full 10k LOC diff would be truncated

## BENCH-DRIVER

**How `runCascade` is called** (bench.mts:runRow, lines 217–258):
- `runRow(row, {model, cascade, exec})` materializes fixture → resolves guard config → selects reviewers → runs `runReviewerCascade(selection, (s) => runCascade(s, {cwd, cfg, exec, firstModel}))`
- Spy exec (bench.mts:makeSpyExec, lines 131–155) wraps `execJudgeAsync` to:
  - Capture raw verdict text + wall-clock ms per pass
  - Snapshot the checklist state-file artifact immediately after each judge subprocess (runCascade deletes it after returning)
  - If cascade=false and escalate pass, inject synthetic FAIL (zero opus spend)

**Knobs**:
- `BENCH_MODEL` (env, default 'sonnet') — first-pass model, ignored for model-pinned reviewers (correctness runs 'sonnet' always)
- `BENCH_CASCADE=off` (env) — skip opus escalation (short-circuits to synthetic FAIL for e2e metrics; first-pass metrics only)
- `BENCH_CONCURRENCY` (env, default 2) — bounded worker pool (mapLimit)
- `--only <idPrefix>` (cli) — filter rows by id prefix before running
- `--dev` (cli) — exclude holdout rows (for quick iteration)
- `--baseline` (cli) — write results.baseline.json after run completes
- `--fail` (cli) — enforce floors + print flip table vs baseline
- `--against <before.json>` (cli) — A/B a prompt edit: directional flip table, bypasses gateHash guard, exits 0 (informational only)
- `--fresh` (cli) — discard checkpoint file and re-run everything

**Metrics computed** (bench.mts:summarize, lines 264–308):
- `firstFailRecall` = {k: count(gold where firstVerdict='FAIL'), n: gold.length} — haiku headline
- `firstCleanPass` = {k: count(decoys where firstVerdict='PASS'), n: decoys.length}
- `blockRecall` (cascade only) = {k: count(gold where okFinal), n: gold.length}
- `cleanPass` (cascade only) = {k: count(decoys where okFinal), n: decoys.length}
- `overturnRate` (cascade only) = opus flipped a first-pass FAIL back to PASS
- `rescueRate` (cascade only) = opus flipped a first-pass FAIL-decoy to PASS
- `escalations` = live opus passes run
- `escalateMeanSecs` = average escalation runtime
- `reasons` = dict of right-reason attribution counts (`right-item`, `pattern-only`, `fail-unattributed`, `unattributed`)
- `inconclusive` = dict of subcause counts (`outage`, `no-verdict`, `checklist-void`, `not-selected`, etc.)

All wrapped in Wilson 95% intervals (via stats.mts:fmtCi)

**Per-row checkpoint/salvage** (progress.mts, loaded by bench.mts):
- On completion, every row appends to `progress-<model>-<cascade>.jsonl`: `{reviewer, gateHash, rowHash, behaviorHash, res}`
- On re-run of same command, `salvageMap()` detects `(reviewer, gateHash, rowHash)` matches → reuses cached result, prints "SALVAGED"
- If `rowHash` changed (content edit), row is excluded from pairing and reported as "changed", not silently flipped
- `behaviorHash` (bench.mts + corpus.mts:188–195) hashes only behavior-bearing fields (`reviewer`, `expected`, `expectItems`, `reasonPattern`, `repo`), allowing metadata-only corrections without staling a baseline
- Checkpoint is deleted after full run completes; paused runs preserve it for resume

**A/B arm declaration** (pre-registration-lens-split.md, lines 43–48):
- Control arm: `GUARD_CORRECTNESS_SPLIT` unset (single-pass monolith), section key `correctness-reviewer@sonnet@cascade-off`
- Treatment arm: `GUARD_CORRECTNESS_SPLIT=1` (two judges), section key gains `@split:lens1+lens2_lens3+lens4` suffix
- Arms are pre-registered (markdown file written before any bench run, with hypothesis + stopping rule)
- Metrics declared in advance as co-primary + guardrail; McNemar flip table is the gate (mid-p, pooled + gold-only + decoy-only + clustered-by-case)

**Pre-registration** (README.md:158–175, pre-registration-lens-split.md):
- Decision rule written BEFORE the sweep; sweep does not move goalposts
- Haiku is DEFAULT candidate — expensive models must *justify* cost, not the other way round
- Production haiku decision: keep haiku iff BOTH (1) sonnet shows no *statistically significant one-directional improvement* on end-to-end block recall (McNemar mid-p ≥ 0.05, per-reviewer, holdouts included), AND (2) haiku *first-pass clean-pass ≥ 0.70* (below that, wasted opus escalations erase latency/cost win)
- Opus sweep is a ceiling reference only, does not gate the decision

## DIFF-ARCHIVE-AS-BENCH

**Storage structure** (diff-archive.mts + mine-telemetry.mts):
- Layout: `<telemetry-dir>/diffs/<sha256(diffText)>.diff.gz` (404 files currently per notes)
- Content-addressed, gzip compressed; archive only on FAIL paths (runReviewGate, not bench.mts or runCascade directly)
- Never throws — fail-open, best-effort (capped at 8 MiB raw, errors degrade to null gracefully)
- Fires only from `runReviewGate`'s FAIL path (run-review.mts), never from bench direct calls — **bench runs do NOT archive anything**

**Telemetry labels on real ship FAILs** (mine-telemetry.mts:177–243):
- `commit_reviews`: `{ship_id, reviewer, status, reason}` — reviewer-level status (fail|pass) and optional failure reason text
- `commit_review_scope`: `{ship_id, reviewer, diff_sha256}` — diff content hash (join key to archive)
- `commit_review_lenses`: `{ship_id, reviewer, lens, status, disposition, issues_json}` — per-lens verdicts (failing lens with disposition='blocking'|'waived'|'dropped_out_of_charter')
- `commit_ships`: `{ship_id, repo, branch, ts_start, exit_code}` — ship metadata for correlation

**Could real archived ship diffs be used as 'whole-PR' bench inputs?** 

YES, with caveats:

1. **Fail-fix correlation already proven** (corpus-growth.md capture-point-1): next attempt in same (repo, branch) touching flagged lines = fix (mine-telemetry-lib.mts:findNextLensOutcome validates this; real 5-ship sequence verified)
2. **Gold candidate path already implemented**: mine-telemetry.mts → candidates-telemetry.jsonl → human disagreement-triage only (no authoring) → corpus rows
3. **Decoy path (waived-decoy) works**: override valve waive events stamp `disposition='waived'` → mine-telemetry.mts produces waived-decoy candidates with human's rationale as `note`

**What's missing for that:**

1. **Bytes availability**: Before 2026-07-27, `commit_review_scope` didn't exist; FAILs predating then have only `failReason` text, no `diff_sha256`, no archived bytes — reconstruction is fallible and triggers item-13 (solution-leakage) concerns (methodology.md:98–146). Archive went live in a LATER commit; backlog of pre-archive FAILs (~12/day for correctness alone) are **irreversibly unreplayable** (amended at commit time in methodology.md).
2. **Per-row fixture construction**: Archived diff bytes are the RAW staged changes; turning them into a corpus row requires wrapping them in a committed `repo.base` state (prior commit? canonical clean state?). The CURRENT mine-telemetry.mts path does NOT reconstruct a full fixture — it produces only `{diffSha256, failReason}` candidates for human oversight. Fixture materialization would need:
   - Base state (prior tree sha? master HEAD at time of fail?)
   - File-relative paths from diff hunk headers
   - Validation that the diff applies cleanly to that base
3. **Decoy sourcing**: Real ship FAILs are gold candidates (reviewer missed a bug); CodeRabbit comment misses are gold candidates too (external bot found what reviewer missed). Decoys must come from real PASS ships (reviewer stayed silent when it should have → hard to construct from telemetry alone; waived-decoy path covers this). A full "PRs as benchmarks" would need both paths working together.

## PUBLISH+FLOORS

**How a change is published** (eval/cli.mts, README.md:41–45):
```bash
bun gate-engine/eval/cli.mts publish --suite <name> --tree <ref|HEAD> \
  --change-type <coverage|quality|methodology-reset|no-ship> \
  --assessment <improved|regressed|flat|mixed|unknown> \
  --note "prose justification"
```

- Reads committed tree (Git worktree mode locks on `.publish.lock` to prevent concurrent edits)
- Derives `gateHash` (run-review.mts + reviewers.mts + corpus source + brief + checklist + SKILL.md) and `corpusHash` (sorted list of per-row hashes)
- Baseline must have matching `gateHash` or publication fails (immutable guard — a baseline earned under old bytes is not comparable)
- Writes atomic checkpoint artifact (sanitized row-level evidence, no prompts/paths/secrets), keyed by SHA-256 of its bytes
- Appends event to history.jsonl (immutable append-only ledger)
- Regenerates views (dashboard SVG, README table) deterministically

**Acceptance floors** (README.md:106–116, bench.mts:333):
```
FLOORS = {
  blockRecall: 0.75,           # end-to-end (cascade on)
  cleanPass: 0.85,             # end-to-end (cascade on)
  firstFailRecallSonnetOnly: 0.6  # first-pass haiku only, production baseline only
}
```
- Pooled (48–53 domain rows is a tripwire, not a per-reviewer detector)
- Enforced by `--fail` flag (gates exit code, prints flip table)
- firstFailRecall floor applies ONLY when actual model is sonnet (haiku/opus sweeps use it as decision input, not a gate)

**Noise floor rule** (README.md:119–131, benchmark-methodology.md:39):
- ~4pp (measured label-error floor via methodology audit, Northcutt 2103.14749 reference: 3–6% label error flips rankings)
- Delta < (noise floor + paired CI width) = unresolved, not a win
- Pre-registration declares the stopping rule to prevent post-hoc goalposts (bench-gates-on-flips-not-deltas decision)

**Pre-registered decision** (README.md:158–175):
- Must be written BEFORE first sweep (committed markdown with hypothesis + stopping rule + metric declaration)
- Not modified after data is collected
- Haiku production default: keep iff (1) sonnet no significant *one-directional improvement* on block-recall (McNemar mid-p ≥ 0.05) AND (2) haiku first-pass clean-pass ≥ 0.70

## EXPERIMENT-FORMAT

**Structure** (docs/benchmarks/experiments/2026-08-04-correctness-lens-split/README.md):

```markdown
# [Name] — [method], [date range]

**Outcome: [shipped|UNRESOLVED|no-ship]**. [One-sentence summary of why.]

Pre-registration: [`../../pre-registration-<name>.md`]

## Question
[Hypothesis in plain English]

## Arms
[Table: arm name | command | purpose]
- All arms on SAME CORPUS (pin commit/blob hash)
- All arms on SAME MODEL + CASCADE settings
- Report concurrency, wall-clock per row, total cost

## Results
[Table: metric rows (pooled recall, clean-pass, weak-pair breakdown, guardrails, stable flips)]
- Per-row flip table (mid-p, pooled + gold-only + decoy-only + clustered-by-case)
- Null adjustment (control run twice, subtract shared flips from treatment)
- Stale-pin command (git show blob > temp.jsonl for reproducibility)

## Reading
[Interpretation against pre-registered stopping rule]
- Did co-primaries move as predicted?
- Did guardrails hold?
- Noise floor subtraction (shared flips with null)

## Two [claims these runs falsified / prior predictions confirmed]
[Unexpected empirical findings, cost measurements, etc.]

## Provenance — why [PUBLISHED|nothing is published]
[Commits/uncommitted changes in the measured tree; behavior fixes landed after; why epoch break or not]

## Next
[Corpus growth targets, stopping rule for re-run, new arms to test]
```

**Reproducibility artifacts in `runs/` subdir:**
- `.json` baselines (snapshot of each arm's results at time of run)
- `.log` files (the raw per-row run ledger, parsed by lens-analysis.mjs)
- `lens-analysis.mjs` (reproduces mid-p flip tables, filters shared flips with null)
- Corpus pin command (git show blob → temp.jsonl when corpus moved on)

## GAPS-FOR-CHUNK-EXPERIMENT

**To design a chunking experiment ("~N-LOC pieces, one reviewer per chunk vs whole diff"):**

1. **Corpus design missing:**
   - New track: "scale-realistic" rows with 2–10k LOC diffs (current corpus is intentionally minimal ≤25 lines)
   - File layout: multi-file diffs (current mostly single-file)
   - Pre-registration: declared co-primaries (e.g., "chunk recall 0.70+", "whole-diff haiku vs chunk-haiku precision parity", "cost ratio <2x")
   - Decoy sourcing for large diffs (real FP examples needed, not easy to author)

2. **Chunking strategy not yet in reviewers.mts:**
   - No `diffChunkSize` knob; no `GUARD_CHUNKING` dark flag
   - Chunk boundary logic (preserve hunks? split by file? split by logical change?—consensus not yet established)
   - Multi-reviewer orchestration (how do per-chunk verdicts merge? unanimous fail? any fail? weighted?)
   - Fixture materialization would need to apply only one chunk's staged diff per row variant (currently fixture = full staged state)

3. **Metrics not pre-registered:**
   - firstFailRecall on chunked vs whole (gold finding distribution across chunks)
   - cleanPass on chunked vs whole (cross-chunk false positives)
   - "merged verdict consistency": do all chunks agree? flip rate when one chunk disagrees?
   - Cost: tokens/seconds per chunk vs whole; judge call count (chunks × reviewers × escalations)
   - Model pairing: haiku per chunk vs sonnet on whole (cost-quality tradeoff)

4. **Existing infrastructure that helps:**
   - `runRow` already isolates one variant's fixture → cost to run chunks serially or parallel is straightforward
   - Telemetry pipeline (mine-telemetry.mts) can mine real multi-file fails if bytes are available (pre-2026-07-27 FAILs unplayable)
   - `behaviorHash` allows metadata (chunk-id, merge-strategy) edits without staling baselines
   - Spy exec + checklist snapshots work per-judge, so per-chunk verdicts are capturable

5. **Operational unknowns:**
   - File chunking determinism: does hunk boundary order matter? will re-runs chunk identically?
   - Escalation cost at scale: does a 10k LOC diff fit in the 60KB judge input even after chunking?
   - Judge cache collision: does the verdict cache (sc-1437, added after latest runs) collide between chunk-1 and chunk-2 of the same diff? (almost certainly yes — need to salt by chunk-id)

---

**Final note**: The current benchmark is precisely calibrated for small, focused fixtures (methodology.md: this is INTENTIONAL design for attention-dilution measurement). Scaling to realistic diffs is a separate effort; the experiment design outlined above would require pre-registering the new corpus AND validating that chunk strategy & metrics are orthogonal to fixture size before spending judge tokens.