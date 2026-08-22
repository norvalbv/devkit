# Chunked parallel correctness review — implementation plan (architect angle: first-attempt recall)

Scope: correctness-reviewer only (64.9% of cohort judge $, 86% of all FAILs, the only reviewer whose pinned single-pass FAIL blocks without escalation). Domain reviewers untouched. Ship/review flow untouched except the review engine's task planner and the FAIL report. Plan file: `<home>/.claude/plans/before-we-do-that-zazzy-wombat-agent-a91f4a64b675904fb.md`.

## 1. Goal + success metric (baselines from TELEMETRY/CRITIQUE, cross-repo sink unless noted)

Goal: on attempt 1 every correctness lens judge is responsible for a bounded slice of the staged diff (≤ ~24KB identity bytes ≈ 600 LOC, whole files only), runs in parallel with siblings, plus ONE whole-diff cross-file pass; findings across slices are deduped and disclosed together; each slice's PASS is cached on that slice's identity so attempt k+1 re-pays only the slice(s) the fix touched + the cross-file pass.

| Metric | Baseline | Target (4 weeks flag-on dogfood) | Source |
|---|---|---|---|
| review→review repeat, consecutive same-branch attempts | 413/1,346 = 30.7% of review-blocked; 46.7% of pairs that have a next attempt | ≤ 35% of pairs-with-next | commit_ships LEAD(blocked_gate) |
| new failing reviewer on small diff change | 53/267 = 19.9% | ≤ 12% | commit_review_scope + commit_reviews |
| judge $ per shipped commit (sum over branch attempts, cost era) | review-blocked attempt $9.70 mean (n=329), success $4.13 (n=249); correctness $0.67 (<5KB) → $2.36 (>60KB) per lens run | ≤ +10% per shipped commit (attempt-1 may cost +17–35% on >36KB diffs, paid back by fewer attempts) | commit_judges.cost_usd |
| minutes per attempt | p50 267s all / 416s review-blocked; p90 675/729s | review-blocked p50 ≤ 360s (makespan ≈ slowest slice) | commit_ships.duration_s, gate_timing(review) |
| reviews blind above the 60KB evidence cap | 13.9% of correctness reviews (219/1,580) | 0% for correctness (each slice ≤ cap) | review_scope.diff_bytes vs `diff-evidence.mts:85` |
| bench | blockRecall floor 0.75 / cleanPass 0.85 (`eval/reviewers/bench.mts:333`) | chunk arm ≥ control on stable flips; cleanPass not regressed beyond 4pp noise floor | bench |

Devkit-only honesty: devkit has 0 branches ≥20 attempts, max 19, review 21.9% vs deterministic 21.3% of blocks (CRITIQUE #1). Devkit dogfoods the flag; frink/consumers are where the win lands.

## 2. Design

### 2.1 What exists (file:line)
- One diff per reviewer `run-review.mts:387 diffs = selected.map(s => gitCached(cwd, [], s.files))`; plan `:422 planReviewWork(...)`; fan-out `mapLimit(plan.tasks, concurrency, …)` `:469`; cap `telemetry/timing.mts:8 DEFAULT_REVIEW_CONCURRENCY = 6`.
- Lens split `lens/split.mts:62-64 FOUR_WAY_LENS_GROUPS`; `:114-129 deriveLensReviewer` (state file `:122 .claude/.correctness-review-<lens>.json`); keys `:341 keyOf(name, idText, \`${salt}|split:${lensGroupId(g)}\`)`, `:336 idText = diffCacheIdentity(diffs[i])`, `:348 allCached`; merge `:170-198 mergeLensOutcomes`; `:217-262 emitMergedLensResults` (lens_parts `:248-254`); `:471-487 mapLimit`.
- Cache key `reviewers.mts:441-455` = sha256(identitySalt\0versionSalt\0diffText); identity normalization `judge/diff-focus.mts:131-173 diffCacheIdentity`; per-file split `diff-focus.mts:24-29 splitDiffByFile`.
- Per-task PASS checkpoint `recovery/settle.mts:65-78 savePasses({[t.key]: …})`; lens parts held `:93`; FAIL archive `:80`. Store retention `judge/verdict-store.mts MAX_ENTRIES = 100`.
- Judge file scoping already exists: `runtime.mts:386-400 withStagedFiles` → `DEVKIT_REVIEW_STAGED_FILES` (100,000B cap), consumed by `skills/correctness/scripts/checklist.mjs:127-132 getStagedFiles()` override; state path `checklist.mjs:64-66 lensPath`. Evidence on stdin `run-review.mts:205 buildCappedDiffEvidence(gitCached(cwd, [], files), stat)`; caps `diff-evidence.mts:85-87` (60000/8000/40). Model pin `run-review.mts:216 passModel = reviewer.model ?? firstModel`. Valve fingerprint `overrides.mts:52-55` over `gitCached(cwd, [], sel.files)` (`run-review.mts:160`).
- Items `evidence/items.mts:17 ITEM_CAP=40`, `:25 ITEMS_INLINE_BUDGET=2000`, `:55-77 mergeItemVectors`. FAIL print dumps full transcripts `run-review.mts:510-516`.
- Brief charter `agents/correctness-reviewer.md` architecture_context: "Correctness is NOT domain-sliceable — a writer in a backend root and its reader in a frontend root are ONE finding"; general_rules "trace BEYOND the hunk". Judges keep Read/Grep/Glob/git — chunking partitions RESPONSIBILITY for hunks, not investigative reach.

### 2.2 Chunking rule — new pure module `gate-engine/review/lens/chunk.mts`
- Input: `sel.files` (already source-only/test-free, `reviewers.mts:234-239`), per-file identity bytes from `diffCacheIdentity(splitDiffByFile(diff)[i])`. No new diff parser (`zero-consumer-tool-deps`; `parse-diff`/`p-limit` not added — `splitDiffByFile`/`mapLimit` exist).
- `CAP = GUARD_CORRECTNESS_CHUNK_BYTES` (default 24000 identity bytes ≈ 600 LOC). Chunk only when total identity > 1.5×CAP (36KB): p50 diff 26.8KB stays ONE chunk = today, byte-identical keys. `MAX_CHUNKS = 4` (cost bound). Files never split.
- Placement: sort by path, first-fit in path order with capacity CAP (siblings together); a file > CAP gets its own chunk (judge still `git diff --cached` full hunks, as today past `SEGMENT_CAP`). If > MAX_CHUNKS, re-pack with CAP' = ceil(total/MAX_CHUNKS).
- Sticky replan: persist `chunk-plan:correctness-reviewer:<files_sha256> → assignment` in `review-cache.json` via `cache.mts:44 savePasses` (VerdictMeta open shape). Same file set ⇒ plan reused verbatim; changed set ⇒ surviving files keep their chunk, new files to least-full chunk. A 1-line edit cannot move a bin boundary and void sibling PASSes.
- Lens assignment: `state-transitions`, `concurrency-races`, `error-and-edge-classification` per chunk (3×C tasks); `writer-reader-contracts` ONCE over the whole diff (cross-file guard; its charter findings are cross-root pairs). Tasks = 3C+1 ≤ 13 (+ ~4 domain reviewers).

### 2.3 Cache key + delta
- Chunk key: `cacheKey('correctness-reviewer', diffCacheIdentity(gitCached(cwd, [], chunk.files)), \`${salt}|split:<lens>|chunk:<sha12(sorted chunk.files)>\`)` — extends `split.mts:341`. C=1 ⇒ no `|chunk:` suffix ⇒ today's key exactly (flag off/on is a no-op for small diffs).
- Cross-cut key: today's `|split:writer-reader-contracts` over whole-diff identity, unchanged.
- Attempt k+1: sticky replan; only chunks whose identity changed miss ⇒ work = 3×(changed chunks) + 1 cross-cut (always re-runs when any ± line changed — one sonnet call, accepted). Message stays out of every key (`commit-with-gate-capture.sh:115`, ship-gates-converge-not-restart).
- `allCached` (`split.mts:348`) extends to lens×chunk parts; ONE `review_scope` row per reviewer kept (gate-verdict-attribution); cached parts re-seed `splitParts` as `split.mts:359-387` does today.
- Retention: raise `MAX_ENTRIES` 100 → 400 for review-cache.json (up to 13 keys/attempt + domain keys; long branches would otherwise churn their own PASSes). Ships in the wiring PR.

### 2.4 Judge-side scoping
- `deriveChunkReviewer(lensReviewer, chunkId)` in `split.mts`: state file `.claude/.correctness-review-<lens>@<chunkId>.json`, cmds append `--chunk <chunkId>`; `checklist.mjs` `lensPath` gains the suffix. Files reach the script via existing `DEVKIT_REVIEW_STAGED_FILES` because `runCascade(sel)` gets `sel.files = chunk.files` (`run-review.mts:183`). Asset byte change ⇒ one-time identitySalt invalidation (same as any release).
- Prompt (`reviewers.mts:307` "Staged files in scope: …") for chunk tasks adds: "This commit also stages: <≤40 names>. Sibling judges own those hunks; trace into them freely but report a finding there only if YOUR hunk introduces it." Full `--stat` still first on stdin (`run-review.mts:199`); per-file evidence = chunk diff only (≤ CAP ⇒ never truncated).
- Waiver fingerprint becomes per lens×chunk — voids only when that chunk's identity changes (narrower than today).

### 2.5 Dedup + bounded disclosure
- Findings per part: checklist `items[].issues` + transcript lines matching `/([\w./-]+\.\w{1,4}):(\d+)/`. Fingerprint `sha12(lens|file|floor(line/5))`, fallback `sha12(lens|normalize(first 80 chars))` (PR-Agent `inline_comment_dedup.py` shape). Keep first; count → `findings_deduped`.
- `run-review.mts:510-516`: print `correctness-reviewer FAILED — N finding(s) across C slice(s):` + ≤12 one-liners sorted (lens,file,line) + `transcripts: <refs>`; no multi-transcript dump. One reviewer's bounded deduped list, fewer bytes than today's concatenated transcripts — record a note on `ship-gates-converge-not-restart` (Rejected (a) "wall of findings").
- `mergeLensOutcomes` unchanged (worst wins); `lens_parts[]` += `chunk`, `bytes`; `mergeItemVectors` already non-pass-first + cap 40.

### 2.6 Concurrency + cost bounds
- Keep cap 6; ≤13 correctness + ~4 domain tasks ⇒ 3 waves; slice judges ~3–4× smaller ⇒ makespan ↓ on >50KB. sc-1476 (`settle.mts` header: checklist compliance degrades under concurrent load) ⇒ measure `review_result.retried`/checklist-void by in-flight count BEFORE any cap raise; deferred serial recovery already exists.
- Cost model (CRITIQUE #10: ≈ $0.55 fixed + $0.03/KB per lens run): 60KB diff today 4×$2.36=$9.4; C=2 → $11.1 (+17%); C=3 → $12.7 (+35%). Bounds: MAX_CHUNKS=4, threshold 36KB (sub-p60 diffs pay nothing). Re-derive the fixed/variable split with a K=1 probe before the bench.

### 2.7 Telemetry
- NEW `review_chunk_plan` {reviewer, chunks, cap_bytes, total_identity_bytes, parts_total, parts_cached, sticky, chunk_files_sha256[] (≤4)} emitted beside `review_scope`.
- `review_result.lens_parts[]` += `chunk`, `bytes`; merged row += `findings_deduped`. Existing: `judge_exec` (cost/tokens/session per part), `cache_hit`, `gate_timing(review)`, `ship_attempt/ship_result`, `review_scope.diff_bytes`.

### 2.8 Decision slugs
Extends: `correctness-lens-split-shipped` (fan-out axis lens → lens×chunk, same name-invariant/merge); `review-gate-in-chain` (PASS cache altitude per lens×slice — prior-art's "repartition, don't window"); `judge-verdict-cache-scope` (cache at the question's altitude: local lenses per-slice, writer-reader whole-diff; NOT its Rejected (b) — nothing dropped from judgement); `detect-judge-evidence-only-input` (less evidence per judge); `gate-verdict-attribution`/`gate-telemetry-self-describing` (new event, one scope row); `bench-gates-on-flips-not-deltas` + `benchmarks-grow-from-telemetry`; `zero-consumer-tool-deps`. Conflicts recorded as notes: `ship-gates-converge-not-restart` Rejected (a); `correctness-reviewer-precision` Rejected (b) — haiku-per-chunk bench-arm only, never default.

## 3. Experiment / bench plan + decision rule
0. Finding-location audit (no code; CRITIQUE must-experiment 1): ≥50 cost-era correctness fail→fail pairs; join `commit_judges.transcript_ref` file:line to `git diff k..k+1` (archive `<telemetry>/diffs/<sha>.diff.gz`); classify (a) changed lines / (b) unchanged already-reviewed / (c) OMITTED. GO iff (b)+(c) ≥ 40%; if (a) dominates, stop — lever is precision (K-sample), not slicing.
1. Scale corpus track in `eval/reviewers/cases-correctness.jsonl` (`track:'scale'`): 36 rows, 3–8 files, 30–60KB, ≥10 cross-file writer/reader gold, ≥12 decoys (waived-decoy mints + authored). Pre-register `docs/benchmarks/pre-registration-chunk-split.md` BEFORE any run.
2. Arms (same corpus blob pin, sonnet, 4-way split on, `BENCH_CONCURRENCY=2`): A control; B `GUARD_CORRECTNESS_CHUNK=24000` cross-cut on; C chunk on, cross-cut off (prices the guard); D haiku-per-chunk + sonnet cross-cut (separate pre-registered arm). Section key suffix `@chunk:<cap>[:nocross][:haiku]` mirroring `lensArmSuffix` (`split.mts:394`). K=1 probe per arm, then `BENCH_RUNS=3` stable flips.
3. Co-primaries: pooled blockRecall on the scale track; cross-file gold recall (guardrail B ≥ A − 1 row). Guardrails: cleanPass ≥ 0.85; cost/row ≤ 1.4×A; inconclusive/checklist-void ≤ A + 2 rows.
4. Decision rule: flip on iff McNemar mid-p < 0.05 with ≥5 net one-directional stable recall flips AND zero guardrail breach; C vs B decides whether cross-cut stays mandatory (stays unless C loses 0 cross-file rows); D ships only if it clears the same bar vs B at ≥25% lower cost/row. Else UNRESOLVED: stays off, decision recorded either way.
5. Dogfood (devkit + one consumer) 4 weeks flag-on: §1 metrics + `review_chunk_plan`; kill if $/shipped commit > +10% or review→review repeat rises.

## 4. Rollout + flags + kill switch
- `GUARD_CORRECTNESS_CHUNK` = `off` (default through PR4) | `on` (24000) | `<bytes>`; `GUARD_CORRECTNESS_CHUNK_MAX` (4); config mirror `review.correctnessChunk` (env-over-file-over-default like `completenessHard`); `FRINK_*` alias.
- Kill: `off` restores today's plan and keys byte-for-byte (C=1 has no `|chunk:` suffix) — no cache clear needed; `guard-review clear-cache` remains the hatch.
- Order: planner + checklist scoping dark → wiring dark → dedup report (useful even with 4 lens parts) → bench arm → experiment → default flip by decision record.

## 5. Risks → mitigation
- Cross-file blindness (SWE-PRBench Type3≈0): whole-diff writer-reader pass; judges keep tools + full `--stat` + sibling-file list; cross-file gold guardrail.
- More blocks short-term (un-truncated 14% + per-slice attention): bounded deduped disclosure lets the agent fix N findings in one attempt; 36KB threshold; kill on attempts-to-green regression.
- Duplicate/contradictory findings across slices: file:line-bucket + text fingerprint dedup; worst-wins merge.
- Concurrency compliance (sc-1476): cap stays 6; deferred serial recovery; metric by in-flight count before raising.
- Cost ↑ on big diffs (+17–35% attempt-1): MAX_CHUNKS, threshold, $/shipped-commit kill criterion; probe first.
- Plan instability ⇒ cache misses: sticky plan per files_sha256; C=1 keys unchanged.
- Same-lens slice judges colliding on the state file: chunk-suffixed path (PR2) is a blocking prerequisite for PR3.
- Store churn: MAX_ENTRIES 100 → 400.
- Waiver fingerprint shift on upgrade: one-time; fingerprints already void on any real change.

## 6. Ordered PR list (< ~400 LOC each)
1. `gate-engine/review/lens/chunk.mts` + tests: deterministic sticky first-fit planner over per-file identity bytes; pure, unwired. (~250)
2. `skills/correctness/scripts/checklist.mjs` `--chunk <id>` state-path suffix + `split.mts deriveChunkReviewer`; synced copies. (~150)
3. `planReviewWork` wiring under `GUARD_CORRECTNESS_CHUNK` (default off): lens×chunk tasks, cross-cut task, keys, sticky plan, `review_chunk_plan`, `lens_parts.chunk/bytes`, sibling-file prompt line, `MAX_ENTRIES` raise; tests asserting C=1 key identity. (~350)
4. Finding dedup + bounded FAIL report (`run-review.mts:510-516`, new `evidence/findings.mts`), `findings_deduped`; decision note on ship-gates-converge. (~200)
5. Bench: scale-track rows + `chunkArmSuffix` + pre-registration doc + step-0 audit script under `eval/reviewers/`. (~300 + jsonl)
6. Experiment README `docs/benchmarks/experiments/<date>-correctness-chunk-split/`, decision via `guard-decisions`, default flip if cleared.

## 7. Explicitly NOT done, and why
- No incremental/delta-since-last-attempt windowing: judge-verdict-cache-scope Rejected (b) rules it UNSOUND; strictly weaker than identity-keyed slices.
- No hunk/LOC splitting inside a file: breaks per-file identity, checklist file lists, waiver fingerprints, function-local context; file-group slices keep every primitive.
- No haiku default for slices: correctness-reviewer-precision pins sonnet for recall (`run-review.mts:216`); haiku is bench arm D only.
- No change to completeness ($4.42/run, #2 cost, different altitude) or domain reviewers (~2% each).
- No K-sample self-consistency: ruled, unbuilt, precision lever — step 0 audit decides whether it outranks slicing.
- No new deps (parse-diff, p-limit): existing `splitDiffByFile`/`diffCacheIdentity`/`mapLimit`.
- No change to the checklist's one-reason-per-item shape or to cross-gate fail-fast (ship-gates-converge).