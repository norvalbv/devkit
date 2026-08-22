# Queries behind the numbers (2026-08-22)

All against the local collector DB `~/.claude-usage/usage.db` (open read-only: `sqlite3 -readonly` or `sqlite3.connect('file:...?mode=ro', uri=True)`). Population: every repo on this machine unless stated. LOC ≈ `diff_bytes / 40`.

## Attempts per branch

```sql
select repo, branch, count(*) n, sum(exit_code=0) shipped, round(sum(duration_s)/60.0) total_min
from commit_ships where branch is not null and branch!='' group by repo,branch order by n desc limit 12;

with b as (select repo,branch,count(*) n from commit_ships where branch!='' group by 1,2)
select case when n>=20 then '20+' when n>=10 then '10-19' when n>=5 then '5-9' when n>=2 then '2-4' else '1' end bucket,
       count(*) branches, sum(n) attempts from b group by 1;
-- 1:415 · 2-4:401 · 5-9:185 · 10-19:60 · 20+:23 (max 55)
```

## Judge cost per branch (cost_usd populated since ~2026-08-07 only)

```sql
select s.repo, s.branch, count(distinct j.ship_id) ships, count(*) judge_runs, round(sum(j.cost_usd),2) usd
from commit_judges j join commit_ships s using(ship_id) group by 1,2 order by usd desc limit 8;
select count(*), sum(cost_usd is not null), round(sum(cost_usd),2), min(ts), max(ts) from commit_judges;
-- 16147 rows, 5770 costed, $5549.35 (floor)
```

## Attempt-to-attempt churn (Python)

```python
# consecutive attempts per (repo,branch) ordered by ts_start; for pairs where attempt k had a
# commit_reviews row with status='fail': how often k+1 also fails, same reviewer vs different.
# Result: 740 pairs; k+1 review-FAIL 345 (47%); same reviewer 328 (95%); different reviewer 17.
```

## Blocked-gate classes

```sql
select coalesce(blocked_gate, fail_gate, case when exit_code=0 then 'shipped' else 'none' end) g, count(*)
from commit_ships group by 1 order by 2 desc;
-- shipped 1316 · review 929 · unknown 831 · deterministic 763 · none 150 · timeout 15 · ...
select gate, count(*) from commit_gate_results group by 1 order by 2 desc;  -- decisions 3058, coverage 652, size 363, ...
```

## Findings per blocked attempt (reason text) and per lens (issue_count)

```python
# commit_reviews.reason for correctness-reviewer status='fail': regex r'(\d+) un-overridden finding'
# -> 1:675, 2:48, 3:3 of 726. (The bracketed 12-hex ids are waiver fingerprints, one per failing lens.)
```

```sql
-- per-lens issue counts, the real unit:
select s.diff_bytes, s.ship_id, coalesce(sum(l.issue_count),0) issues, sum(l.status='fail') lenses_fail
from commit_review_scope s left join commit_review_lenses l on l.ship_id=s.ship_id and l.reviewer=s.reviewer
where s.reviewer='correctness-reviewer' and s.cached=0 and s.diff_bytes is not null group by s.ship_id;
-- bucket by diff_bytes/40 in Python: 0-100:115 rows 0.28 issues/review 4.9/kLOC ... 4000+:26 rows 1.00 issues/review 0.14/kLOC
-- issues per failing review: 1×335, 2×145, 3×31, 4×13, 5×1
```

## Per-branch chain yield (branches with ≥5 attempts)

```python
# per branch: sum of correctness findings across all attempts vs max correctness diff LOC seen
# final LOC 0-300: 32 branches, median 1 finding / 6 attempts, 4.4 per kLOC
# 300-1000: 79, 2 / 7, 3.1 ; 1000-3000: 41, 3 / 10, 1.9 ; 3000+: 9, 5 / 18, 0.6
```

## Corpus fixture sizes vs production diffs

```python
# cases-*.jsonl: rows 261, staged LOC p50 21, p90 46, max 71, files ≤2
```
```sql
select count(*), round(avg(diff_bytes)/40), round(max(diff_bytes)/40), sum(diff_bytes>40*1000), sum(diff_bytes>40*5000)
from commit_review_scope where reviewer='correctness-reviewer' and cached=0;
-- 1043 · mean ~945 LOC · max ~12.9k · 307 over 1k · 24 over 5k
```

## 60 KB evidence cap exposure (critic)

```sql
select sum(diff_bytes>60000), count(*) from commit_review_scope where reviewer='correctness-reviewer';
-- 219 / 1580 = 13.9%
```

## The frink PR #443 branch

```sql
select count(*) attempts, sum(exit_code=0) shipped, round(sum(duration_s)/60.0) mins from commit_ships where branch='<branch-01>';
-- 67 · 28 · 246 ;  judge cost $328.21 over 363 runs ; correctness diffs 32–6082 LOC, avg 13 files ; 19 issues / 19 lens fails
```
