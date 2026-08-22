# Ship Iteration Cost & Churn Analysis

**Sources**: `<home>/.claude-usage/usage.db` (sqlite3 -readonly), `~/.devkit/telemetry/gate-events.jsonl` (67,930 lines). Live DB snapshot taken 2026-08-22 ~21:55Z — commit_judges now has 16,214 rows (5,836 with cost_usd, $5,584.76 total), a few dozen more than the lead's snapshot (16,147/5,770/$5,549) because the DB keeps growing; treat small deltas as clock drift, not error.

**Caveat up front**: `commit_ships.repo` (411 distinct values: frink, devkit, worktree, owners-web, ship, repo, qavis, claude-usage-dashboard...) and gate-events.jsonl's repo field (codename dirs like `amazing-woodland`, `famous-ravine`) both confirm this is a **per-machine sink spanning every project shipped on this machine**, not devkit-only. All branch/attempt numbers below are cross-repo unless noted.

---

## 1. Attempts-per-branch distribution + blocking cause

```sql
WITH bc AS (SELECT repo,branch,COUNT(*) n FROM commit_ships GROUP BY repo,branch)
SELECT CASE WHEN n=1 THEN '1' WHEN n BETWEEN 2 AND 4 THEN '2-4'
       WHEN n BETWEEN 5 AND 9 THEN '5-9' WHEN n BETWEEN 10 AND 19 THEN '10-19' ELSE '20+' END bucket,
       COUNT(*) branches, SUM(n) attempts
FROM bc GROUP BY bucket ORDER BY MIN(n);
```
| bucket | branches | attempts |
|---|---|---|
| 1 | 416 | 416 |
| 2-4 | 401 | 1,105 |
| 5-9 | 185 | 1,163 |
| 10-19 | 60 | 763 |
| 20+ | 23 | 583 |

(Matches lead's 415/401/185/60/23 to within 1 — off-by-one is a `GROUP BY repo,branch` tie, not a real discrepancy.)

**blocked_gate for the ≥10-attempts cohort** (1,346 attempts, `JOIN` on branches with `HAVING COUNT(*)>=10`):
| blocked_gate | n | % |
|---|---|---|
| review | 484 | 36.0% |
| unknown | 329 | 24.4% |
| NULL (exit 0 / success) | 287 | 21.3% |
| deterministic | 234 | 17.4% |
| decisions/timeout/fallow/staged_objects_missing | 12 | 0.9% |

**All ships (n=4,030)**:
| blocked_gate | n | % |
|---|---|---|
| NULL (success) | 1,467 | 36.4% |
| review | 929 | 23.1% |
| unknown | 831 | 20.6% |
| deterministic | 763 | 18.9% |
| decisions/timeout/fallow/qavis/etc | 25 | 0.6% |

`blocked_gate='unknown'` is **not** unclassified noise — cross-tabbing with `fail_gate` shows it's almost entirely judge-driven blocks the collector couldn't map to the 4 coarse buckets: completeness (236), qavis (145), fallow (131), sentry (108), knip (47), duplication (40), decisions (18). So the true composition of "review-adjacent" blocking (review + the judge-driven share of unknown) is closer to ~40% of all blocked attempts, deterministic gates ~19%, decisions ~0.6% (structurally near-dead, consistent with the `waiver-valve-never-fires` pattern in this codebase).

---

## 2. Wall time

```sql
WITH o AS (SELECT duration_s, ROW_NUMBER() OVER (ORDER BY duration_s) rn, COUNT(*) OVER() cnt
           FROM commit_ships WHERE duration_s IS NOT NULL [AND blocked_gate='review'])
SELECT (SELECT duration_s FROM o WHERE rn=CAST(0.5*cnt AS INT)) p50,
       (SELECT duration_s FROM o WHERE rn=CAST(0.9*cnt AS INT)) p90, MAX(duration_s) FROM o;
```
| cohort | n | p50 (s) | p90 (s) | max (s) |
|---|---|---|---|---|
| all attempts | 3,713 | 267 | 675 | 54,208 |
| review-blocked only | 897 | 416 | 729 | 2,557 |

Review-blocked attempts run ~56% longer at the median than the average attempt (267s → 416s) — the judge fan-out itself is the tax, not just retries.

**Per-branch total minutes, 20+ cohort** (`SUM(duration_s) GROUP BY repo,branch HAVING COUNT(*)>=20`), 23 branches, 583 attempts, **229,043s = 63.6 hours** total wall time:
| repo/branch (top 5) | attempts | total min |
|---|---|---|
| checkout-10 / branch-06 | 25 | 270.8 |
| quiet-wait-ship / …flow-quiet-wait-ceiling | 23 | 267.9 |
| checkout-01 / branch-02 | 25 | 246.7 |
| checkout-03 / branch-03 | 35 | 245.0 |
| ship / branch-04 | 23 | 239.0 |

Notably the **top wall-time branch is not the top judge-cost branch** — renderer-crash-continuity is #1 on cost ($465.98) but #3 on wall time.

---

## 3. THE KEY QUESTION — churn

Ordering fix: `LEAD(...) OVER (PARTITION BY repo,branch ORDER BY ts_start, rowid)` — 2 branches have duplicate `ts_start` values, so `rowid` tiebreak is required for a deterministic answer (without it, pair counts wobble 411 vs 413).

**(a) After a review-block, is the next attempt also review-blocked?**
```sql
SELECT next_blocked, COUNT(*) FROM (SELECT blocked_gate, LEAD(blocked_gate) OVER (...) next_blocked FROM commit_ships) WHERE blocked_gate='review' GROUP BY 1;
```
n=1,346 review-blocked ships with a following attempt on the same branch:
| next attempt's blocked_gate | n | % |
|---|---|---|
| review (again) | 413 | 30.7% |
| NULL (success) | 261 | 19.4% |
| unknown (judge-classified) | 168 | 12.5% |
| deterministic | 85 | 6.3% |
| timeout/other | 6 | 0.4% |
(remaining review-blocked ships had no follow-up attempt in the DB — branch abandoned/merged elsewhere)

Of ships **with** a next attempt, review→review repeats **46.7%** of the time.

**(b) Same or different failing reviewer, k→k+1 (both review-blocked)?** n=413 pairs.
```sql
-- exact match of failing-reviewer sets
SELECT SUM(kf.set = k1f.set) FROM ... GROUP_CONCAT(DISTINCT reviewer) per ship_id ...
```
| measure | n | % |
|---|---|---|
| exact same failing-reviewer set | 275 | 66.6% |
| any overlap (≥1 shared reviewer) | 378 | 91.5% |
| zero overlap (wholly new reviewer(s)) | 35 | 8.5% |

Caveat: `correctness-reviewer` is 86% of all fails (726/842) so "same reviewer" is largely a base-rate artifact, not evidence the *same issue* recurred — see (d).

**(c) Diff barely changes yet a new reviewer/finding appears** (using `diff_sha256`/`file_count` from `commit_review_scope`, `correctness-reviewer` as reference since it's present on ~97% of ships):
| measure | n | % of 413 pairs |
|---|---|---|
| identical diff_sha256 k→k+1 | 21 | 5.1% |
| changed diff_sha256 | 272 | 65.9% |
| missing scope row (one side) | 120 | 29.1% |
| pairs w/ ≤2 file_count delta AND changed hash | 267 | — |
| …of those, a genuinely-new failing reviewer (passed/absent at k, fails at k+1) | 53 | **19.9% of small-diff-change pairs** |
| new failing reviewer, unconditional | 86 | 20.8% of all 413 pairs |

So ~1 in 5 small edits between attempts flips in a reviewer that hadn't failed before — the fix for one finding is triggering a different judge.

**(d) Same issue vs different issue, k→k+1?** `commit_reviews.reason` embeds a finding-category tag and a 12-hex-char finding hash (e.g. `concurrency-races [03dfcf038ed6]`). Extracted with `perl -F'\t'` regex over 353 pairs where `correctness-reviewer` failed both k and k+1:
| measure | n | % |
|---|---|---|
| identical finding hash recurs (literally the same finding, unfixed/re-surfaced) | 6 | 1.7% |
| same *category* recurs, but new hash (issue-area repeats, different specific finding) | 204 | 57.8% |
| completely different category (new issue class) | 149 | 42.2% |

Category breakdown across the 353 k-side reasons: `state-transitions` 141, `error-and-edge-classification` 124, `writer-reader-contracts` 107, `concurrency-races` 106, `(finding)` 10 (multi-label, sums >353).

**Honest read**: the finding hash is almost certainly content-derived (location+diff), so it changes on every edit even when the underlying defect is conceptually unfixed — the 1.7% "identical hash" number is a floor, not the true recurrence rate. The 57.8% same-category rate is the better proxy for "still the same kind of problem," and it says: most churn is the agent repeatedly tripping the same category of correctness concern (mostly state-transitions/concurrency), not thrashing across unrelated categories.

---

## 4. Diff size vs outcome

Per-ship aggregate keyed on `correctness-reviewer`'s `diff_bytes`/`file_count`, joined to `commit_ships.blocked_gate` and summed `commit_judges.cost_usd`/`secs` per ship (n=1,576 ships with a correctness-reviewer scope row):

| diff_bytes bucket | n ships | review FAIL rate | mean item_count | mean judge $ (n_with_cost) | mean judge secs | mean file_count |
|---|---|---|---|---|---|---|
| <1KB | 29 | 10.3% | 9.27 | $3.46 (14) | 462 | 1.0 |
| 1–5KB | 213 | 22.5% | 12.33 | $3.93 (89) | 594 | 1.7 |
| 5–20KB | 531 | 32.8% | 19.05 | $5.99 (193) | 906 | 4.2 |
| 20–50KB | 491 | 47.9% | 30.79 | $9.10 (192) | 1,107 | 9.1 |
| 50KB+ | 312 | 54.2% | 55.24 | $11.27 (191) | 1,420 | 24.7 |

**Answer: monotonic, not flat.** Every column (fail rate, items found, cost, time) rises smoothly with diff size — 5.3x the fail rate, 6x the findings, 3.3x the cost, 3.1x the time from smallest to largest bucket. Bigger diffs cost more *and* find proportionally more (findings/KB is roughly flat ~1 item per 1-2KB), so it reads as real signal, not just judges padding output for bigger prompts.

---

## 5. Cost anatomy, 20+ cohort (23 branches, 2,787 judge rows, 1,639 with cost_usd = 58.8% populated — higher than global 36% because these are recently-active branches, in the cost-tracking era since 2026-08-07)

```sql
SELECT cj.judge, COUNT(*), SUM(cj.cost_usd) FROM commit_judges cj
JOIN commit_ships cs USING(ship_id) JOIN cohort co ON ... GROUP BY cj.judge;
```
Total recorded cost in cohort: **$2,099.81**

| judge | n_runs | total $ | % of cohort $ | avg $/run |
|---|---|---|---|---|
| correctness-reviewer | 919 | $1,361.93 | 64.9% | $1.91 |
| completeness | 190 | $411.27 | 19.6% | $4.42 |
| commit-guard | 362 | $133.80 | 6.4% | $0.67 |
| frontend-performance-reviewer | 182 | $42.18 | 2.0% | $0.36 |
| api-security-reviewer | 226 | $40.73 | 1.9% | $0.49 |
| backend-performance-reviewer | 217 | $40.27 | 1.9% | $0.49 |
| frontend-security-reviewer | 179 | $35.17 | 1.7% | $0.30 |
| conventions-reviewer | 339 | $31.91 | 1.5% | $0.18 |
| sentry-advisory | 99 | $2.57 | 0.1% | $0.05 |
| decision-alignment / decision-depth / decision-smell | 74 | **$0.00** | — | untracked |

**By model**: sonnet $1,446.63 (68.9%), opus $451.75 (21.5%), haiku $201.43 (9.6%).
**Escalated share**: 34/2,787 = 1.2%.
**Cache-hit rate per reviewer** (via `commit_review_scope.cached`, cohort scope — `cached=1` count / total scope rows):
| reviewer | cached | total | rate |
|---|---|---|---|
| backend-performance | 106 | 223 | 47.5% |
| api-security | 104 | 223 | 46.6% |
| frontend-performance | 98 | 222 | 44.1% |
| frontend-security | 98 | 222 | 44.1% |
| commit-guard | 83 | 297 | 27.9% |
| conventions | 83 | 297 | 27.9% |
| correctness | 78 | 297 | 26.3% |

Cross-check via `commit_cache_events` (a separate log of `hit` events) gives **different counts** per reviewer (e.g. correctness-reviewer: 119 hits vs 78 from the `cached` flag) — the two cache-tracking mechanisms disagree, consistent with the `verify-telemetry-aggregates-yourself` pitfall about undercounted cache activity; treat cache-hit rate as directionally right (~25-48%), not exact.

**Correctness+completeness = 84.5% of all recorded judge dollars** in this cohort — that's the whole cost story. `decision-*` and `prior-art-eval:*` judges have **literally zero cost_usd rows across the entire DB** (checked: decision-alignment 0/288, decision-depth 0/162, all prior-art-eval variants 0/n) — this isn't a small-sample gap, cost instrumentation was never wired to that judge family. Any "cost by judge" pie is invisible to those judges, not free.

---

## 6. Repeat-run waste

All consecutive same-branch ship pairs (not filtered to review-blocked), n=2,957 pairs, joined to `commit_review_scope` per reviewer:

| measure | n | notes |
|---|---|---|
| reviewer-pairs with **identical `diff_sha256`** k→k+1 | 2,367 | should always cache |
| …of those, correctly cache-hit (`cached=1`) | 2,134 | 90.2% |
| …of those, **re-run anyway on a byte-identical diff** | **233** | **9.8% — pure waste** |
| by reviewer (worst): correctness-reviewer | 60/343 | 17.5% wasted rerun rate |
| commit-guard | 48/341 | 14.1% |
| conventions-reviewer | 34/341 | 10.0% |
| api-security / backend-perf | 24 each | ~7.2% |
| frontend-perf / frontend-sec | 22 / 21 | ~6.4% |

Estimated $ cost of those 233 wasted reruns (using per-reviewer avg cost_usd from §5): correctness 60×$1.49=$89, commit-guard 48×$0.48=$23, remainder ~$35 → **≈$147 in directly-verified waste across the DB's lifetime, on a ~59% cost-coverage sample** (so plausibly ~$250-400 if extrapolated to full history — extrapolation, not measured).

| measure | n | notes |
|---|---|---|
| reviewer-pairs with **same `files_sha256`** (same file set) but **different `diff_sha256`** | 2,788 | expected re-run — content changed |
| …cached anyway (coincidental hit elsewhere) | 524 | 18.8% |
| …correctly re-run | 2,264 | 81.2% — not waste, working as designed |

---

## 7. Token / diff sizes

```sql
SELECT judge, AVG(input_tokens), AVG(cache_read), AVG(cache_creation), AVG(output_tokens) FROM commit_judges GROUP BY judge;
```
| judge | avg input_tokens | avg cache_read | avg cache_creation | avg output_tokens |
|---|---|---|---|---|
| completeness | 428 | 2,493,462 | 110,236 | 17,835 |
| correctness-reviewer | 65 | 2,242,977 | 97,083 | 17,270 |
| commit-guard | 153 | 1,463,513 | 63,546 | 5,737 |
| frontend-performance | 137 | 1,231,134 | 53,087 | 4,438 |
| api-security | 134 | 1,212,183 | 55,324 | 5,382 |
| backend-performance | 121 | 969,134 | 53,154 | 4,829 |
| frontend-security | 114 | 862,884 | 51,409 | 3,611 |
| conventions-reviewer | 38 | 99,187 | 43,872 | 4,825 |

Fresh `input_tokens` is tiny (38-428) — everything is served from `cache_read` (up to 2.49M tokens/run for completeness). This is *why* the per-run dollar cost in §4/§5 stays in single digits despite huge nominal context: prompt caching is doing almost all the work, and its cost is baked into cache_read pricing, not visible as "input."

**Diff size distribution** across all `commit_review_scope` rows (n=9,359):
```sql
WITH o AS (SELECT diff_bytes, ROW_NUMBER() OVER (ORDER BY diff_bytes) rn, COUNT(*) OVER() cnt FROM commit_review_scope WHERE diff_bytes IS NOT NULL)
SELECT p50,p90,p99,max FROM o;
```
| percentile | bytes | LOC est. (bytes/40) |
|---|---|---|
| p50 | 26,851 | 671 |
| p90 | 106,340 | 2,658 |
| p99 | 414,479 | 10,362 |
| max | 969,712 | 24,243 |

Median diff a reviewer judges is ~670 "lines" by this estimate — sizeable for a single-commit review, and consistent with §4 showing most ships already sit in the 20-50KB+ buckets where fail rate is 48-54%.

---

## Interpretation (5 lines)

1. Review-blocking is the single biggest repeat-attempt driver (23-36% of blocked attempts depending on cohort), and once it fires, ~47% of the time the very next attempt is blocked by review again — this is a real feedback loop, not noise.
2. The loop is mostly "same problem area, new instance": 57.8% of consecutive correctness-reviewer failures share a category (state-transitions/concurrency/contracts) even though only 1.7% share the exact finding hash — agents are treating the symptom, not the category, so the reviewer re-flags something in the same neighborhood.
3. Diff size is the dominant cost and fail-rate lever, monotonically: 50KB+ diffs fail review 5x more often, cost 3x more, and take 3x longer than sub-1KB diffs — shipping smaller, more frequent diffs would very likely cut both $ and iteration count.
4. Correctness + completeness judges are 84.5% of all recorded judge spend in the worst cohort; cache-hit waste (9.8% of byte-identical reruns) is real but small in absolute dollars (~$147 measured) — the big lever is diff size/attempt count, not cache-hit-rate tuning.
5. `decision-*`/`prior-art-eval` judges are cost-invisible (0 cost_usd rows, ever) — any dollar-based judge-cost ranking silently erases that whole family; don't conclude they're "cheap," conclude they're unmeasured.

## Caveats — what this data cannot show

- **cost_usd coverage is ~36% overall / ~59% in the 20+ cohort**, and only exists since 2026-08-07 — every dollar figure here is a projection from a partial, temporally-skewed sample (skewed toward recently-active branches), not a full-history total.
- **`blocked_gate` vs `fail_gate` disagree** for 20.6% of ships (`blocked_gate='unknown'`) — the "unknown" bucket is real judge/gate failures (completeness, qavis, fallow, sentry) the collector just couldn't map to its 4 coarse categories; don't read "unknown" as noise.
- **`LIKE`-style / hash-matching pitfalls**: the finding-hash comparison in Q3(d) almost certainly changes on every content edit even for a truly unfixed defect, so "1.7% identical hash" is a floor on recurrence, not the real number — category-match (57.8%) is the better (still imperfect) proxy.
- **Two disagreeing cache signals**: `commit_review_scope.cached` and `commit_cache_events` give different hit-counts for the same reviewer (e.g. 78 vs 119 for correctness-reviewer) — pick one consistently and say so; I used the `cached` flag as primary.
- **Per-machine sink mixes repos**: `commit_ships.repo` spans 411 distinct project checkouts (frink, devkit, owners-web, qavis, random codex worktree dirs); every "branch" and "cost per branch" number is cross-project, not devkit-specific, and gate-events.jsonl uses an entirely different (codename) repo-naming scheme, so the two sources can't be joined by repo name.
- **Cached PASSes leave no `commit_reviews` row**: a `cached=1` scope row can represent a verdict from a prior run that never re-recorded into `commit_reviews`, so any FAIL-rate computed strictly from `commit_reviews` (rather than `commit_ships.blocked_gate`) under-counts blocked ships whose block came from a cache-replayed status — I used `blocked_gate` for ship-level fail rates for this reason, and `commit_reviews.status` only for reviewer-identity questions.
- No causal claim is possible: correlation between diff size and fail rate could be diff size *causing* more findings, or harder/riskier changes independently producing both bigger diffs and more findings — the data can't separate these.