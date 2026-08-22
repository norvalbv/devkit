Now I'll compile the detailed findings on devkit's ship review architecture:

## LIFECYCLE

**Ship-branch.sh (new-ship entry):**
- Line 148: Calls `prepare-gate-worktree.sh` (symlink deps)
- Line 279: Stages diff, untracked, and gitignored files
- Line 299: Calls `commit-with-gate-capture` which runs gates via `run_gates_with_capture`
- On FAIL: EXIT trap (line 226) removes worktree; agent must `devkit ship` again (NO auto-retry)
- On SUCCESS: Push (line 315), PR creation (line 323), manifest write (line 354), cleanup

**Reship.sh (ship --pr, for existing branch):**
- Line 164: `DEVKIT_SHIP_MODE=reship` tags telemetry as retry, not new-ship
- Line 170: Identical `commit-with-gate-capture` call
- Line 189: Fast-forward push only (rejects if branch advanced)
- No auto-retry: agent fixes and re-invokes `ship --pr`

**Commit-with-gate-capture.sh (gate orchestration entry):**
- Line 58: Sets `DEVKIT_GATE_EVENTS` (telemetry sink)
- Line 133: `run_gates_with_capture "$wt" "$root" ship "$log" "$progress"` (line 133)
- Line 106: `DEVKIT_SHIP_MODE` exported by caller (ship|reship)
- Telemetry: `ship_attempt` (line 104), `ship_result` (line 192)
- On FAIL: Gate that blocked is identified by grep (lines 187-189: deterministic|decisions|review)
- Message NOT in cache key: Line 115 comment: "gate keeps message OUT of every reviewer cache key"

**Review-target.sh (review gate execution):**
- Line 737: `DEVKIT_RUN_MODE=review` (vs `ship` for shipping)
- Line 815-826: Two gate modes: overlay vs direct hook
- Lines 724-735: Cache session prepare (4 stores, generation-fenced)
- Lines 879-880: Cache promotion after gates pass (per store)
- Line 829: Progress file cleared on success (no unfinished reviewers)

---

## ENGINE + CACHE

**run-review.mts (reviewer orchestration):**
- Line 342-546: Main gate orchestrator
- Line 397: `const cache = loadCache(cwd)` (loads verdict store)
- Line 422: `const plan = planReviewWork(selected, diffs, cache, targetSalts, cacheKey)` 
- Line 426-429: Cache hits emitted (line 428: `emitCacheHit`)
- Line 469-486: Run cascades under concurrency cap via `mapLimit(plan.tasks, concurrency, ...)`

**Cache key (reviewers.mts:441-455):**
```
sha256(identitySalt + \0 + versionSalt + \0 + diffText)
```
Where:
- `identitySalt` = hash of reviewer ASSET bytes (brief.md, skill.md, checklist script) + gate config (resolveReviewerIdentities, runtime.mts)
- `versionSalt` = devkitVersion() (line 445, 2026-08-06: added to salt per ship-gates-converge decision note at line 36 of that decision)
- `diffText` = staged git diff for that reviewer's files ONLY (line 387: `diffs = selected.map((s) => gitCached(cwd, [], s.files))`)
- NOT in key: commit message (intentional, line 115 of commit-with-gate-capture.sh and judge-verdict-cache-scope decision ruling)

**Verdict stores (cache/session.mts:21-26):**
```
REVIEW_CACHE_STORE_NAMES = [
  'review-cache.json',
  'decisions-verdict-cache.json',
  'prefix-cache.json',
  'sentry-verdict-cache.json',
]
```
Each store has a generation UUID (line 19: `GENERATION` UUID regex). Hydrated at start (line 120, `prepareReviewCacheSession`), promoted back after gates pass if generation still matches (line 99-112, `promoteReviewCacheStore`).

**Re-ship cache behavior:**
- Same diff on same branch -> cache HIT, PASS replays from review-cache.json
- Amended diff on same branch -> new diff hash, reviewers re-run only that subset
- Message amendment (only, no code change) -> cache HIT on diff, message OUT of key
- File deletion -> diff changes hash, reviewer re-runs
- Completeness judge (separate cache): keyed on `branch + normalized_message` (judge-verdict-cache-scope ruling), so re-runs ONLY if message or branch change

**Existing splitting/chunking:**
- **Correctness-reviewer lens split** (lens/split.mts:1-100): ONE judge per lens by default
  - Four lenses: state-transitions, concurrency-races, writer-reader-contracts, error-and-edge-classification
  - Line 67: `GUARD_CORRECTNESS_SPLIT=off` disables, `on` uses paired two-group shape
  - Line 509 (run-review.mts): `emitMergedLensResults(splitParts, firstModel)` merges lens results into one reviewer row
  - Each lens runs as a separate cascade (haiku + opus escalation), results merged after
  - Line 509: Cache HIT only when EVERY lens group was cached (split.mts, no excerpt shown but derived from context)

---

## INPUT + PROMPT

**Diff passing (run-review.mts:205-214):**
- Line 199: Full stat (file list + line counts)
- Line 205: `input = buildCappedDiffEvidence(gitCached(cwd, [], files), stat)`
- Diff passed on stdin (judge runs with `-p` flag, reads evidence from stdin)

**Capping (diff-evidence.mts):**
- `EVIDENCE_TOTAL_CAP = 60000` bytes (line 195, confirmed in previous grep)
- `SEGMENT_CAP = 8000` bytes per file (no single file eats budget)
- `OMITTED_LIST_MAX = 40` (pointer lines; full --stat always present)
- Archive max: `ARCHIVE_MAX_BYTES = 8 * 1024 * 1024` (8 MiB, for diff-archive.mts, line visible in grep)
- OMITTED/TRUNCATED files named explicitly; judge warned to investigate

**Prompt wrapping (reviewers.mts:200-202):**
- Checklist reviewer: `wrapPrompt(body, reviewer, files, assetRoot, checklistRecoveryReason, promptExtras)` (line 201)
- Skill-less reviewer (conventions): `wrapConventionsPrompt(body, files, renderGoverningClaudeMd(...), promptExtras)` (line 202)

**File routing (selectReviewers, not in read files, inferred):**
- Domain selection: backend/frontend/code/all (resolveGuardConfig resolves review.backendRoots, frontendRoots from guard.config.json)
- Per reviewer: files matched against domain roots, only matching files passed to that reviewer

**Escalation:**
- Line 206-289 (cascadeVerdict): haiku first-pass (line 220-230: exec with model `passModel ?? firstModel`)
- Line 254-265: If PASS -> return (no escalation)
- Line 276-284: If model-pinned (e.g., correctness) -> FAIL is final (no escalation)
- Line 286-297: Otherwise, opus escalation (line 288: `escalatePrompt(prompt, first)` with model 'opus')
- BOTH passes read same stdin input (line 289: same `input` variable)

**Concurrency cap (reviewConcurrency, not shown in reads, but mentioned):**
- run-review.mts line 399: `const concurrency = reviewConcurrency()`
- Line 432: "≤${concurrency} concurrent"
- Default: 6 (mentioned in docblock line 24 as '(default 6, floor 1)', and GUARD_REVIEW_CONCURRENCY knob)
- Line 469: `mapLimit(plan.tasks, concurrency, ...)` enforces it

---

## TELEMETRY

Per-review telemetry emitted to `DEVKIT_GATE_EVENTS` (JSONL):

**review_scope (evidence/scope.mts, emitReviewScope call at line 424):**
- reviewer (name)
- domain
- prompt_identity (hash of reviewer asset bytes + brief identity)
- diff_sha256
- diff_bytes (UTF-8 byte count)
- file_count
- files_sha256
- files (JSON array, inlined if <SCOPE_FILES_INLINE_BUDGET; else scope_ref to transcript file)
- has_checklist (boolean)
- cached (boolean: true if this review_scope is from a cache hit)
- commit_msg (boolean: sc-1442 advisory context)
- targets_via (scope|scope+semantic: sc-1442 intent semantic retrieval)

**review_result (recovered from split.mts and settle.mts):**
- reviewer (name)
- verdict (pass|fail|error|inconclusive — inferred from context)
- reason (brief explanation)
- model (haiku|opus — escalation model used)
- escalated (boolean)
- duration_ms
- items (findings/passes from checklist)
- item_count (before any cap)
- waivers (override valve state)
- lens_parts (per-lens status for correctness-reviewer split, per correctness-lens-split-shipped decision)

**cache_hit (emitCacheHit, line 428):**
- Type: cache_hit
- Reviewer and model of cached verdict
- Duration saved

**Completion:**
- Judge_exec events (per judge invocation)
- Judge outages tagged with KIND (timeout|transient|empty)

---

## EXISTING SPLITTING

**Correctness-reviewer lens split (lens/split.mts):**
- Default: FOUR_WAY_LENS_GROUPS (one judge per lens, line 60-63)
- Option 1: DEFAULT_LENS_GROUPS (paired: {strong, strong} + {weak, weak}, line 52-54)
- Option 0/off: null (monolith, line 73)
- Each group runs independently through the cascade (haiku first-pass, opus escalation)
- Results merged: line 509 (run-review.mts) `emitMergedLensResults(splitParts, firstModel)`
- Merged items sorted with non-passing first (correctness-lens-split-shipped, line 13: "failing lens sorts first so truncation never keeps passes and drops findings")
- Cache key: includes lens group id (lensGroupId, line 68: `[group].sort().join('+'`)

**No other splitting in current code:**
- Other reviewers (api-security, conventions, completeness, sentry, commit-guard, frontend-accessibility) run as monolithic judges
- No file-level parallelization (each reviewer gets its scoped file list, runs once)
- No diff-chunking per judge (one stdin per judge, capped at 60KB total)

---

## DECISIONS CONSTRAINTS

Key rulings that CONSTRAIN incremental/chunked review:

**ship-gates-converge-not-restart (line 12 ruling):**
- "Reviewer PASSes checkpoint per-completion" → cached per diff hash
- "Message stays OUT of cache key" → amended message on re-run must reuse PASSes
- **Constraint**: Incremental review must preserve diff-hash cache identity; chunking a diff breaks the key
- Line 18 rejection (a): "run-all-and-aggregate for AI gates too — LOSES: wall of AI findings raises agent confusion/hallucination risk"
- **Consequence**: Chunked parallel review cannot reduce findings per chunk; must merge across chunks in gate chain

**judge-verdict-cache-scope (line 11 ruling):**
- Completeness judge cached per `branch + normalized_message + reviewer_brief`
- Other judges cached per `diff_hash + identity_salt + version`
- **Constraint**: Incremental delta review (only changed files) breaks completeness cache if message unchanged but re-run is triggered by OTHER reviewers' failures
- Line 13: "Opus completeness paid once per branch+message across retry chain"

**correctness-lens-split-shipped (line 12 ruling):**
- Per-lens judges run under concurrency cap
- Line 11: "lens_parts vector carries per-group status" — split results must survive merge
- **Constraint**: Lens split is the ONLY approved splitting; expanding beyond lenses needs measured evidence per the A/B framework (line 10: "corpus cannot resolve question at 46 gold / 32 decoy", rejected monolith drop)

**review-gate-in-chain (line 11 ruling, 2026-07-16 note line 39):**
- Review-only cache identity includes brief, skill, checklist, registry metadata
- Line 39: "old PASS cannot authorize changed reviewer" → cache must reflect asset version
- **Constraint**: Incremental review cannot reuse cached PASSes across asset updates; chunking must account for per-reviewer cache expiry

**Ship-gates-converge, line 36 note (2026-08-06):**
- Verdict cache key now salts on devkitVersion()
- **Constraint**: Devkit upgrade invalidates all cached PASSes; chunking across versions is impossible

---

## OPEN QUESTIONS

1. **Incremental re-review scope**: If agent fixes one file, should reviewers re-run on:
   - Only that file's new diff? (Cache MISS; breaks diff-hash key for other reviewers whose files didn't change)
   - The full new diff? (Cache HIT on unchanged files' diffs, but re-runs changed file diffs)
   - How to handle completeness judge (keyed on message + branch, not diff)?

2. **Chunked parallel review contract**: How should findings from N chunks merge?
   - One reviewer runs N judge instances in parallel, each on a diff chunk?
   - Findings sorted with non-passing first (per correctness-lens-split model)?
   - Item cap re-applied after merge, or per-chunk cap?
   - Waiver fingerprints (depends on full diff, line sc-1439) — invalid across chunks?

3. **Cache key stability**: Must incremental/chunked review preserve these?
   - Diff-hash cache key (means chunking must NOT change the key)
   - Completeness cache key (branch + message, independent of diff split)
   - Per-lens identity (correctness-reviewer split already stable across changes)

4. **Convergence guarantee**: Can chunked review converge as well as monolithic?
   - Line 18 of ship-gates-converge: "a killed ship keeps every earned verdict"
   - Does per-chunk caching preserve this, or does merging create un-cacheable states?

5. **File-domain routing in chunks**: How to split?
   - One chunk per domain (backend, frontend, code) per reviewer?
   - One chunk per N files, respecting domain boundaries?
   - Completeness judge (scoped to ALL files, message-only intent) — run once or per chunk?

6. **Fault isolation**: If one chunk fails, do all re-run or just that chunk?
   - Cache miss on one chunk could pollute N parallel judges' results
   - Strict mode (ship) vs non-strict (review) — different fail-closed behavior needed?

---

**FILES CITED:**
- `<home>/Desktop/Personal and learning/devkit/cli/lib/ship/ship-branch.sh`: lines 148, 226, 279, 299, 315, 323, 354
- `<home>/Desktop/Personal and learning/devkit/cli/lib/ship/commit-with-gate-capture.sh`: lines 58, 104, 106, 115, 133, 187-189, 192
- `<home>/Desktop/Personal and learning/devkit/cli/lib/ship/reship.sh`: lines 164, 170, 189
- `<home>/Desktop/Personal and learning/devkit/cli/lib/ship/review-target.sh`: lines 724-735, 737, 815-826, 829, 879-880
- `<home>/Desktop/Personal and learning/devkit/gate-engine/review/run-review.mts`: lines 254-265, 276-284, 286-297, 342-546, 397, 422, 426-429, 432, 469-486, 509
- `<home>/Desktop/Personal and learning/devkit/gate-engine/review/reviewers.mts`: lines 441-455
- `<home>/Desktop/Personal and learning/devkit/gate-engine/review/cache/session.mts`: lines 21-26, 99-112, 120
- `<home>/Desktop/Personal and learning/devkit/gate-engine/review/diff-evidence.mts`: EVIDENCE_TOTAL_CAP=60000, SEGMENT_CAP=8000, OMITTED_LIST_MAX=40
- `<home>/Desktop/Personal and learning/devkit/gate-engine/review/evidence/scope.mts`: review_scope event structure (diff_sha256, diff_bytes, file_count, etc.)
- `<home>/Desktop/Personal and learning/devkit/gate-engine/review/lens/split.mts`: lines 52-63, 68, CORRECTNESS_LENSES, lensGroupId, resolveLensGroups
- `<home>/Desktop/Personal and learning/devkit/docs/decisions/ship-gates-converge-not-restart.md`: lines 12, 18, 36
- `<home>/Desktop/Personal and learning/devkit/docs/decisions/judge-verdict-cache-scope.md`: lines 11, 13
- `<home>/Desktop/Personal and learning/devkit/docs/decisions/correctness-lens-split-shipped.md`: lines 10-13
- `<home>/Desktop/Personal and learning/devkit/docs/decisions/review-gate-in-chain.md`: 2026-07-16 note line 39, 2026-08-04 lines 49-56