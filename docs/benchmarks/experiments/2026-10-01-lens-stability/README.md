# Correctness-lens detection stability: PASS→FAIL on unchanged code — 2026-10-01

**Story:** sc-2754 (autonomous report `b070c636`). **Instrument:** E0 from
[`../2026-08-22-ship-attempts-research/reports/synthesis.md`](../2026-08-22-ship-attempts-research/reports/synthesis.md),
built as `gate-engine/review/eval/reviewers/finding-location-audit/` and extended to PASS@k → FAIL@k+1 pairs.
**Counts:** [`summary.json`](summary.json). Counts only: no ship ids, paths or finding text.

## Question

On one ship, the `error-and-edge-classification` lens passed attempt 3 and failed attempt 4 on code
that had not changed between them. How often does a correctness lens fail an attempt on code that
the author had not changed since the same lens passed the attempt before? This is a
single-sample false negative: a finding the earlier run could have reported, not one the fix caused.

## Method

```
USAGE_DB=~/.claude-usage/usage.db node gate-engine/review/eval/reviewers/finding-location-audit/cli.mts --repo devkit --until 2026-10-01T09:00:00Z --out <dir>
```

- **Population.** devkit ships with a `correctness-reviewer` lens breakdown, from 2026-07-27 to
  2026-10-01T09:00Z, frozen by `--until` and recorded in `summary.json` (local collector db, one
  machine). The same command over the same db reproduces these counts; a later `--until` extends them.
- **Pairs.** Consecutive judged rows of one lens on one (repo, branch) chain, with at most 24h between
  them. All three tables are read inside one SQLite read transaction, so the snapshot is consistent.
  - A row is a judge sample only when the collector recorded a judge model for that lens. Lenses
    replayed from the verdict cache have none, even beside fresh lenses on a partly cached attempt.
    They are skipped (393), as are ships where the lens has no row (1,810 skips inside chains).
  - Pending, inconclusive, waived and out-of-charter-dropped rows break the chain (54).
  - Pairs more than 24h apart are excluded (48).
- **Location.** Each k+1 finding's cited `file:line` is resolved against both attempts' archived
  diffs and compared with `identityByPath`, the normalized per-file unit the verdict cache keys on.
  Repo-relative, `./`, `b/`, absolute-worktree and uniquely shortened citations all resolve.
  - A finding is `unchanged` only when every in-diff file it cites carries the same normalized change
    set at k and k+1: identical hunks against the base, the unit the verdict cache treats as "same
    code". It is not a whole-file byte comparison.
  - A pair is `unchanged` when at least one of its findings is.
  - Unresolvable cases are `undeterminable` with a reason, never guessed — including a cited file
    whose evidence was capped (omitted or truncated) on either attempt.

## Result

| | pairs | unchanged | elsewhere | undeterminable |
|---|---|---|---|---|
| PASS→FAIL (all lenses) | 173 | **12** | 58 | 103 (63 chunked, 37 no k diff, 2 no location, 1 outside diff) |
| FAIL→FAIL (all lenses) | 190 | 10 (+13 same-diff) | 109 | 58 |

| lens | PASS→FAIL pairs | determinable | unchanged | share of determinable | per judged PASS (lower bound) |
|---|---|---|---|---|---|
| concurrency-races | 21 | 15 | 2 | 0.13 | 0.0026 (of 759) |
| error-and-edge-classification | 39 | 22 | 3 | 0.14 | 0.0041 (of 726) |
| state-transitions | 22 | 14 | 3 | 0.21 | 0.0040 (of 759) |
| writer-reader-contracts | 91 | 19 | 4 | 0.21 | 0.0068 (of 587) |
| **all** | 173 | 70 | 12 | **0.17** | **0.0042** (of 2,831) |

- About 1 in 6 locatable PASS→FAIL flips lands on code the earlier PASS had already seen unchanged.
  The other 5 in 6 cite a file the author changed in between, so they are findings on the new code.
  A same-diff flip counts only when its finding resolves inside the diff; chunked attempts stay
  undeterminable even when their scope hashes match.
- Counted per judged PASS that has a next attempt, a later same-lens FAIL on unchanged code is rare:
  at least 0.4%. This is a lower bound, because undeterminable flips are not counted.
- The sc-2754 incident is a real member of a small class, not evidence that lens PASS verdicts are
  generally unreliable.
- 13 FAIL→FAIL pairs re-judged an identical diff and cited in-diff code, where the verdict cache
  missed or was bypassed.
  None of them were PASS→FAIL.
- Three `unchanged` pairs were spot-checked by hand (before replay exclusion; the method is unchanged). Each cited file's hunks were identical at k and k+1, and
  the attempts differed only in other files.

## Limits

- **Coverage.** A PASS@k diff is archived only when a sibling lens failed k, so 37 PASS→FAIL pairs
  had no k diff. 63 pairs ran chunked: their archive is keyed by the chunk, not by the scope hash, so
  they are undeterminable. Writer-reader-contracts is the most affected (54 chunked).
  - A per-file identity hash on `review_scope` would close both gaps for future runs. The warehouse
    ingests that event in claude-usage-dashboard, so it is a follow-up there.
- **Change sets, not file bytes.** The warehouse records no base sha per attempt. If the base moved
  between k and k+1 (a rebase onto new upstream code), lines outside the hunks could differ while the
  hunks match. Ship attempts on one branch normally share a base, but this is not verified per pair.
- **Location is a proxy.** A finding on an unchanged file can still be triggered by a change
  elsewhere, for example a caller's new behaviour. `unchanged` is an upper bound on pure misses.
  Conversely, `elsewhere` can include a miss that cites the changed caller.
- **One machine, one repo.** The reported runs also logged a missing codebase MCP on every judge,
  which may affect detection. These counts do not separate runs with and without it.
- **Not a decision.** No verdict policy changes on these numbers. The proposed remedy is to re-run
  lenses and block on the union of their findings. That reverses the unanimous-to-block Target in
  [`correctness-reviewer-precision`](../../../decisions/correctness-reviewer-precision.md), and would
  need a new Target backed by a K-sample bench.
