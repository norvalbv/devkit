# Synthesized plan — per-file PASS memory for the ship review gate, measured before it is built

Plan file: `<home>/.claude/plans/before-we-do-that-zazzy-wombat-agent-ab0955e798fc0146f.md`

Winner by summed judge totals: measure-first 76 (27+27+22) > incremental-first 72 (26+21+25) > chunk-fanout 53 (18+20+15). This plan = measure-first's skeleton (E0-first, nothing ships ungated, honest devkit numbers) + incremental-first's build (PASS-only per-file memory, import-closure guard, SHADOW mode on live ships, attempts-as-guardrail) + chunk-fanout's two graftable ideas (mode-salted keys so `off` is byte-identical; bounded deduped multi-finding FAIL report as its own story). Removed as fatal: $2–2.8k skeleton-fixture bench as the deciding evidence; building ~950 LOC of chunking before the audit; writing delta-judged PASSes under the whole-diff key; minting memory into the shared 100-cap store while the flag is off; a P1 with no cross-file guard.

## 1. Context

Every ship attempt re-sends each reviewer its WHOLE domain diff (`gate-engine/review/run-review.mts:387` `diffs = selected.map(s => gitCached(cwd, [], s.files))`) and a PASS is cached as one key `sha256(identitySalt\0versionSalt\0diffCacheIdentity(diff))` (`gate-engine/review/reviewers.mts:441-455`, identity `gate-engine/judge/diff-focus.mts:131`, keyed `gate-engine/review/lens/split.mts:336-346`). Any one-line fix misses every key. Evidence: (i) the retry loop is serial single-finding disclosure — 777/782 (99.4%) failing lenses carry 1 issue, 720/772 blocked ships = 1 reviewer — windowing cannot lower attempt counts; (ii) devkit-only severity is modest — $14.85/shipped commit, 3.42 attempts/shipped (cost era), max 19 attempts, 0 branches ≥20; the 23/55/$466 frame is the cross-repo sink; (iii) 73% of devkit attempts and 88% of judge $ ($405/$460) sit on k≥2; correctness on k≥2 = 289 runs / $244, cached 4/76 — the addressable slice; (iv) `judge-verdict-cache-scope` Rejected (b) rules "diff minus failing reviewer's files" UNSOUND; `ship-gates-converge-not-restart` Rejected (a) forbids a wall of findings; (v) no paper measures whole-vs-chunked or incremental LLM review; SWE-PRBench: cross-file Type3≈0 regardless; PR-Agent `/review -i` / CodeRabbit incremental are existence proofs only. So: build per-file PASS memory (cache repartition, not windowing), gate on a $0 offline audit, measure recall loss in production shadow before it can cause it, keep chunking measure-only.

## 2. Baseline numbers (devkit-only unless marked; `~/.claude-usage/usage.db`, 2026-08-22)

| metric | value | source |
|---|---|---|
| attempts/shipped commit | 2.08 all-time (993/477); **3.42 cost era** (195/57) | `commit_ships` |
| attempts/branch | 1: 170 · 2-4: 142 · 5-9: 50 · 10-19: 11 · 20+: 0 (max 19) | same |
| blocked_gate | NULL 514 · review 217 (21.9%) · deterministic 211 (21.3%) · unknown 48 | same |
| judge $/shipped commit (cost era) | **$14.85** ($460.20/31); $5.11/attempt; review-blocked $6.61 vs success $4.90 | `commit_judges.cost_usd` |
| k≥2 share | 142/195 attempts (73%), $405/$460 (88%); correctness k≥2 289 runs / $244, cached 4/76 | same |
| minutes/attempt | p50 168 s, p90 524 s (n=919); review-blocked p50 359 s, p90 649 s (n=207) | `duration_s` |
| correctness diff sizes (cost era, n=91) | <5K 18 · 5-20K 39 · 20-36K 19 · 36-60K 15 · >60K **0** | `commit_review_scope` |
| correctness $/lens-run (cross-repo) | ≈ $0.55 fixed + $0.03/KB; $0.67 <5KB → $2.36 >60KB; sonnet 4,880/4,880 | `commit_judges` |
| serial disclosure (cross-repo) | 777/782 failing lenses = 1 issue; 720/772 blocked ships = 1 reviewer | `commit_review_lenses` |
| new failing reviewer after small edit (cross-repo) | 53/267 = 19.9% | scope ⋈ reviews |
| 60KB cap blindness | 219/1,580 = 13.9% cross-repo; devkit cost-era 0/91 | `diff-evidence.mts:85` |
| true cache waste | ≈40–49 rows ≈ $30–50 lifetime (not $147: 95 inconclusive + 19 fail never cached) | pairs ⋈ k-status |
| offline labeled inputs | 416 archived FAIL diffs (7.0 MB); 373 distinct correctness-FAIL diffs; fail→fail pairs both archived **274–322 (re-derive in PR0)** | `~/.devkit/telemetry/diffs/` ⋈ scope |
| noise floor | ~4pp / ~5 flips per 140 rows (`bench-gates-on-flips-not-deltas`) | bench README |

## 3. Recommendation

1. **Build first (gated): per-file PASS memory ("file grain")** — `GUARD_REVIEW_CACHE_GRAIN=reviewer|shadow|file`. Existing store, planner, identity, merge. Proceeds past PR0 only if E0 says ≥30% of k+1 correctness findings/bytes land in identity-unchanged files.
2. **Build second (independent): PR1 telemetry** `evidence_bytes_shown / omitted_files / truncated_files` on `review_scope` (~120 LOC); lands regardless of E0.
3. **Only measure: overflow chunking and haiku-per-chunk.** E0 bucket (c) decides whether a chunk experiment is even opened; devkit has 0/91 cost-era correctness diffs >60KB. Haiku needs a superseding `correctness-reviewer-precision` note — not funded.
4. **Spin out (separate story): bounded deduped multi-finding FAIL report** (~200 LOC at `run-review.mts:510-516`). Only idea attacking serial disclosure — the measured attempt driver — but collides with `ship-gates-converge-not-restart` Rejected (a) (maintainer ruling); E0's disclosure share decides whether to open that decision.

Success metric (compound, pre-registered): k≥2 judge $/attempt on delta-eligible reviewers −20% on devkit over 4 weeks (fixed-cost bound: at p50 27KB halving judged bytes saves ~30% of $1.36/lens-run; −30% is the ceiling) AND attempts/shipped not up AND review-blocked p50 minutes not up AND shadow skip-miss ≤5%. Attempts/branch is a GUARDRAIL, not a target.

## 4. Design

### 4.1 Reused primitives (verified)
- Key: `cacheKey` `reviewers.mts:441-455`; planner `planReviewWork` `lens/split.mts:308`, `keyOf(name, idText, \`${salt}|split:<group>\`)` :341, `allCached` :348 — `|split:` IS the mode-in-key idiom.
- Identity: `diffCacheIdentity` `judge/diff-focus.mts:131`, `splitDiffByFile` :24, `filePathOf` :32.
- PASS write: `settleReviewOutcome` `recovery/settle.mts:60-85` → `savePasses({[t.key]: {...}})` :77-84; FAIL archives (:85), never cached.
- Store: `review-cache.json` shared by all worktrees; `MAX_ENTRIES = 100` module const `judge/verdict-store.mts:38`, applied :176 via `retainNewest` (`cache_evicted`). Session fence: 4 stores `gate-engine/review/cache/session.mts:21-26` + `= 4` `cli/lib/ship/review-target.sh:730-734` — NOT touched.
- Judge input: `stat` `run-review.mts:199`; `buildCappedDiffEvidence(gitCached(cwd,[],files), stat)` :205; caps `diff-evidence.mts:85-87` (60000/8000/40). `PromptExtras` `reviewers.mts:278` → `wrapPrompt` :296 / `wrapConventionsPrompt` :358.
- Staged-files env + valve fingerprint stay on the FULL list (`runtime.mts:386`, `run-review.mts:160`).
- `es-module-lexer` is in **`dependencies`** (`package.json:84-88`); the "dev-only" comment at `cli/lib/ship/dist-integrity.mts:102-103` describes that call site, not the package section.
- Telemetry: `emitReviewScope` `evidence/scope.mts:159`; `items[].issues` file:line mandated by `agents/correctness-reviewer.md:11`.
- Branch-sticky precedent: `verdictBranch` `completeness.mts:66`, sticky key :157.

### 4.2 Algorithm (`planReviewWork`, ship/reship only)
For each task T (reviewer R, lens g, domain files D_R, per-file segments seg_f):
1. Whole-diff key hit → cached (fast path unchanged).
2. `grain=reviewer` (default): today's behaviour byte-identical; per-file keys never read or written.
3. `grain ∈ {shadow,file}`: per-file key `keyOf(R, diffCacheIdentity(seg_f), \`${salt}|split:<g>|file:<path>\`)` — mode-distinct, so `reviewer` grain can never be served a file-grain verdict. `unchanged = {f : key_f ∈ cache}`, `changed = D_R \ unchanged` (new files are changed).
4. Cross-file guard: `es-module-lexer` over post-image bytes (`git show :path`) of every f ∈ D_R → undirected import edges within D_R (relative specifiers with ext/index fallback; bare/alias → no edge). `pulled = closure(changed)`; `judged = changed ∪ pulled`. Any unlexable file in D_R (sh/py/json/binary/throw) or any import with `n === undefined` (`dist-integrity.mts:118-120`) → **full review for T**.
5. Exemptions: `writer-reader-contracts` ALWAYS full (cross-root pairs are ONE finding). Eligible: other 3 correctness lenses + api-security/backend-perf/frontend-perf/frontend-security/conventions. Out: completeness, commit-guard, sentry, decisions.
6. Floors: `judged = ∅` → cached (cache_hit); `bytes(judged) ≥ 0.8·bytes(D_R)` → full.
7. Judge input under `file`: full `--stat` of D_R; diff = `gitCached(cwd,[],judged)`; `PromptExtras.deltaBlock` listing unchanged-since-PASS + pulled files, "fetch with `git diff --cached -- <path>`". Escalation reads same input. Under `shadow`: plan computed + logged, judge gets FULL input.
8. Mint on PASS only (FAIL/inconclusive/checklist-void mint nothing): per-file keys for every f ∈ judged. Whole-diff key written ONLY when `judged == D_R`; a partial judgement never lands under the whole-diff key → flipping back to `reviewer` can never replay a partial PASS. Reused files are not refreshed (age out).
9. Retention: per-store cap param on `verdict-store.mts` (default 100; review-cache.json → 400). Minting only under `shadow|file` (≈ +9 entries/PASSing attempt) → zero store pressure under `reviewer`.
10. Dedup: none — reused files not re-judged, cannot re-flag; waiver fingerprints unaffected.

### 4.3 Telemetry (additive)
- PR1: `review_scope` + `evidence_bytes_shown`, `omitted_files`, `truncated_files` (emit at `run-review.mts:424` / `scope.mts:159`) + collector column.
- PR2+: `review_scope` + `cache_grain`, `delta_mode` (full|delta|cached|full-fallback), `delta_reason` (no-memory|unlexable|floor|exempt|dynamic-import), `files_cached`, `files_judged`, `files_pulled`, `judged_bytes`; `cache_hit` label `review:<name>:file`; new `review_delta_shadow` {reviewer, group, skipped_files, finding_files, parse_failures}.

### 4.4 Decisions
Extends `judge-verdict-cache-scope` (altitude principle; does NOT hit Rejected (b) — every changed file's full diff shown, only identity-unchanged files replay; dated note naming residual non-import-coupling risk + the shadow metric bounding it), `ship-gates-converge-not-restart` guarantee (1) + 2026-08-07 identity note (Rejected (a) untouched), `review-gate-in-chain` (salts reused; `devkit review` lane excluded), `correctness-lens-split-shipped`, `gate-verdict-attribution`/`gate-telemetry-self-describing`, `detect-judge-evidence-only-input`, `benchmarks-grow-from-telemetry`, `devkit-self-dogfood`, `zero-consumer-tool-deps`. Respects `correctness-reviewer-precision`. Conflict to record: `reviewers.mts:428-432` "reviewed object is the diff itself" weakens to per-file-given-full-inventory, bounded by writer-reader exemption + import guard + shadow gate.

## 5. Experiment + decision rule (pre-registered in `docs/benchmarks/pre-registration-review-file-grain.md`, merged in PR0 before engine code)

**E0 — finding-location audit, $0, ~1 day** (`gate-engine/review/eval/reviewers/finding-location-audit.mts`). Inputs: consecutive fail→fail pairs with both diffs archived (`mine-telemetry-lib.mts:140 findNextLensOutcome`, `:204 isSameDiff`, `:227 diffArchiveRelPath`; re-derive the 274-vs-322 count) + `raw/candidates-telemetry.jsonl`. Classify each k+1 lens finding: (a) file identity unchanged k→k+1 (addressable), (b) in changed file, (c) OMITTED/TRUNCATED at k (re-run `buildCappedDiffEvidence` on archived k diff), (d) already verbatim in k's `issues_json` (serial disclosure). Also addressable-bytes share per pair and lexable share of D_R.
Rules: GO to PR2 iff (a) ≥ 30% of findings AND median addressable bytes ≥ 30% AND lexable ≥ 80%. Open chunk-measurement story only iff (c) ≥ 15%. If (a) < 30% AND (d) ≥ 40% → STOP windowing; open disclosure-count decision. Otherwise record no-ship.

**E1 — live shadow, $0 marginal (PR2).** Default `shadow` on devkit for ≥100 k≥2 attempts or 3 weeks, whichever later, until ≥40 k+1 findings. skip-miss = findings in files the plan would have skipped / all findings (Wilson 95%). ≤5% → PR3 flips to `file`; 5–10% → widen guard once (same-dir pull), re-measure, second miss → no-ship; >10% → no-ship. Also require planned reuse ≥30% of correctness bytes on k≥2. Power: ~195 attempts/6wk × 21.9% review-blocked → ~40 findings in ~3–4 weeks; extend rather than lower n.

**E2 — `file` on devkit, 4 weeks (PR3/PR4).** vs prior 4 weeks: k≥2 $/attempt on eligible reviewers −20% (noise 4pp); attempts/shipped ≤ baseline + noise; review-blocked p50 minutes not up; new-failing-reviewer (19.9%) not up; inconclusive/checklist-void not up (sc-1476); `cache_evicted` 0 evicted-then-needed. Verify savings via `judge_exec.cache_read`, not bytes. Fleet bench byte-identical `reviewer` vs `file`.

**Not funded now:** measure-first's skeleton bench ($1.5–2.0k + $0.8k; MDE ~15pp at n=60) — only if E0 (c) ≥ 15%, then K=1-probe-gated with ≥60% W-re-find sanity bar.

Cost of experiment: $0. Scaffolding ~250 LOC (PR0) + ~120 LOC (PR1).

## 6. Rollout / flags / kill switch
- `GUARD_REVIEW_CACHE_GRAIN=reviewer|shadow|file` (config mirror `review.cacheGrain`, env-over-file-over-default). PR2 default `shadow`; PR3 `file` opt-in; PR4 default `file` after E1 clears.
- Kill: `reviewer` — mode-distinct keys + no partial PASS under whole-diff key = today's engine byte-for-byte, no cache clear; `guard-review clear-cache` remains the hatch. Version/asset salts invalidate memory as today.
- Ship/reship only; `devkit review` lane excluded.

## 7. Risks → mitigation
- Non-import coupling (env/JSON/shell↔TS/events/DI): writer-reader always full; full `--stat` + Bash fetch; shadow skip-miss gate; 0.8 floor; pre-registered no-ship >10%.
- Import resolution gaps (tsconfig paths, barrels, `require`, template imports): no edge → counted in `parse_failures`; `n === undefined` → full; shadow measures residual.
- Transitive reuse compounding: no refresh on reuse → entries age out at cap; E2 new-failing-reviewer guardrail.
- Store pressure: per-store cap 400; mint only under shadow/file; `cache_evicted` watched.
- sc-1476 load: no new fan-out; inconclusive rate is a guardrail.
- Lossy file:line regex: `parse_failures`; hand-sample ≥50 transcripts in E1.
- Confounds: devkit-only, cost-era, pre-registered; per-machine sink caveat.
- Bounded upside: fixed-cost-dominated runs cap savings ~30%; target −20%; if E0 says lever is disclosure, stop.

## 8. PR list (<400 LOC each)
- **PR0** (~250) `finding-location-audit.mts` + pre-registration doc + README queries; re-derive pair count; confirm es-module-lexer runtime status.
- **PR1** (~120) `review_scope` + `evidence_bytes_shown/omitted_files/truncated_files` + collector column + test.
- **PR2** (~350, gated E0) planner: per-file keys, import-closure guard (`gate-engine/review/lens/file-grain.mts`, pure + tests), lens exemption, floors/fallbacks, `judgedFiles` on `ReviewTask`, PASS-only minting with whole-key-only-on-full rule, per-store cap param, flag parse, `review_delta_shadow` + scope fields; default `shadow`; tests asserting `reviewer` grain byte-identical.
- **PR3** (~200) apply under `file`: input from `judgedFiles`, `deltaBlock` PromptExtra, troubleshooting doc, decision notes.
- **PR4** (~50 + docs, gated E1) default `file` on devkit, experiment README `docs/benchmarks/experiments/2026-xx-review-file-grain/`, decision via `guard-decisions`.
- **Separate story:** bounded deduped multi-finding FAIL report (~200, `run-review.mts:510-516` + `evidence/findings.mts`), only if E0 (d) ≥ 40%, needs maintainer note on converge Rejected (a).
- **Separate story (measure-only, gated E0 (c) ≥ 15%):** overflow-chunk bench arm via `runReviewerCascade` files-subset seam (`bench.mts:251-253`), K=1 probe first.

## 9. Explicitly not doing
No production chunking/fan-out (first-attempt recall on >60KB, 0/91 on devkit; converge Rejected (a); sc-1476; SWE-PRBench Type2/3; +17–35% attempt-1 cost). No haiku (sonnet 4,880/4,880; precision ruling). No hunk-level memory (Rejected (b), writer-reader charter). No FAIL-run minting. No whole-diff key for partial judgements. No new store. No completeness/commit-guard/deterministic changes. No K-sample self-consistency. No 60KB-cap change (PR1 measures only). No skeleton-fixture spend before E0 says chunking matters. No gitnexus/ts-morph graph. No `devkit review` lane. No cache-waste work (≈ $30–50).

## 10. Open questions for the owner (recommended default bold)
1. Chunk experiment: open only if E0 (c) ≥ 15%, else never? — **Yes; on devkit the trigger basically never fires (0/91 >60KB).**
2. Disclosure-count story (collides with converge Rejected (a) maintainer ruling): create now or wait for E0 (d)? — **Create now as a blocked story; build only if E0 (d) ≥ 40% and you are willing to revisit Rejected (a).**
3. Retention: per-store cap raise (review-cache.json → 400) vs dedicated store? — **Per-store cap; a new store touches `session.mts:21-26` + `review-target.sh:730-734` for no benefit.**
4. Import guard: `es-module-lexer` at consumer runtime vs ~30-LOC regex scanner? — **Use es-module-lexer (already in `dependencies`, package.json:88); fix the stale "dev-only" comment in dist-integrity.mts:102-103 in PR2.**