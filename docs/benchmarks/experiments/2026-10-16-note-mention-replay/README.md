# Note-mention advisory: can "a diff changes a name a decision note mentions" be quiet and still catch the miss?

**Status: MEASURED, NOT BUILT.** No arm met the pass rule, which was fixed before this run. No
production code ships.

## Question

A dated decision note can keep describing behaviour after a commit changes it. In the motivating
case, `a7ca89a3` (PR #628) changed `withStagedFiles` so that a staged list over 100 KB travels by temp
file. `review-gate-in-chain` `note:2026-08-04~3` still said the list "falls back loudly to
script-side resolution". Only the completeness judge caught it, on ship attempt 7.

The proposal was a deterministic, advisory pointer run at commit time, before any judge: list the
live notes whose text names, as a whole word, an identifier the staged diff changes, and ask whether
each is still true. The pointer is only worth shipping if it catches this miss in both forms and
stays quiet enough to be read.

## What is frozen

| Input          | Pin                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------- |
| Commits        | the 200 newest non-merge commits reachable from `53bda204`; 152 change a non-test source file |
| Decision log   | each commit's own `<sha>^:docs/decisions`, so a note added later is never matched           |
| Live notes     | every note on every axis (all Target sections), minus notes a declared `**Amends:**` targets and `**Scope:**`/`**Check:**` notes |
| Matching       | unscoped (every axis); a Scope-gated match misses the incident today, because `review-gate-in-chain`'s current Scope no longer covers `gate-engine/review/evidence/staged-files-env.mts` |
| Name filter    | code-shaped (camelCase or containing `_`, length at least 6) and declared in the parent version of the changed file |

## Arms

- **A**: names on removed lines.
- **B**: A plus every token in the `git diff -U0` hunk header (git's funcname: the enclosing
  declaration).
- **C**: B with `-w`, skipping comment-only removed lines, and keeping a name only when one tracked
  file declares it or the note names the hunk's file.
- **D** (added after A to C had run, so it is reported, not gating): A plus only the declared name in
  the hunk header.

## Pass rule (fixed before the run)

All three must hold:
1. The arm lists `review-gate-in-chain#note:2026-08-04~3` for `a7ca89a3` as committed, where the
   function moved files.
2. The arm lists the same note for an in-place edit of the same branch: `a7ca89a3^:gate-engine/review/runtime.mts`
   with only the fallback message changed. That removed line does not contain the name; only the hunk
   header does.
3. The arm prints at most 0.5 lines per source-changing commit.

A precision bar (a Wilson lower bound of at least 25% on 40 blind-labelled lines per arm) was also
set. It was not run, because every arm already fails a deterministic clause, and labelling cannot
reverse that.

## Result

`node docs/benchmarks/experiments/2026-10-16-note-mention-replay/replay.mjs > summary.json` regenerates
`summary.json`; a comma-separated arm list (`… replay.mjs C`) runs a subset.

| Arm | Commits firing | Lines | Lines per commit | Moved | In place | Pass |
| --- | -------------- | ----- | ---------------- | ----- | -------- | ---- |
| A   | 24 / 152       | 54    | 0.36             | yes   | no       | no   |
| B   | 66 / 152       | 189   | 1.24             | yes   | yes      | no   |
| C   | 64 / 152       | 169   | 1.11             | yes   | yes      | no   |
| D   | 64 / 152       | 182   | 1.20             | yes   | yes      | no   |

The quiet arm is quiet because it is blind: A fires on moves, renames and deleted call sites, and
misses any edit inside a function body, which is the class the incident belongs to. Every arm that
sees body edits fires on 42 to 43% of commits.

The volume is broad, not a few repeat offenders: D's 182 lines come from 120 distinct note-and-name
pairs. Notes name central functions (`readDiagnosis` 13 lines, `execJudge` 11,
`familyOverrideRemedy` 10), so every body edit of such a function lists every note that names it.
C's collision and comment filters remove 20 of B's 189 lines. The collision filter counts declaring files
with POSIX bracket classes, because Apple git's `git grep -E` matches nothing for `\s` or `\b`.

## Reading

An identifier is the wrong unit. The incident note is about one branch of `withStagedFiles`, and
other notes name the same function for other reasons. Telling them apart needs the note read against
the change: the same limit `decision-note-supersession-declared` recorded for keyword detection of
undeclared supersession.

Revisit if notes gain a structured anchor that names the behaviour they bind. A declared
`**Check:**` for a note, in the way `decision-ruling-checks` links one for a Target, would be such
an anchor, and so would a symbol plus a predicate.
