# commit-guard corpus seed

The first rows of `gate-engine/review/eval/reviewers/cases-commit-guard.jsonl`, and the rule that
built their fixtures.

## The rule

[`context.mjs`](context.mjs) takes a base commit and one or more diffs against it. It prints one
shared `repo.base` and one staged map per diff. It reads git and the diffs, never a row's label.
`repo.base` holds:

1. the pre-image of every staged file;
2. the base file each staged post-image imports by a relative specifier;
3. every non-test base `.mts` file under `cli/` or `gate-engine/` that defines a top-level symbol
   which a non-test staged file adds;
4. `.co-occurrence-allowlist.json`.

Context files that would fail the corpus leak scan are dropped. A staged file that would fail it
stops the row, unless `--redact FROM=TO` rewrites the literal token. A redacted row is provenance
`adapted`.

Step 3 approximates a repo-wide grep by name. A copy is in reach only when it keeps its original's
name, so renamed duplicates are outside this suite by construction. The rule was written after
reading the seed incident. A worktree-at-base suite with a real semantic index is the measurement
of retrieval recall; this one is not.

## Rows

| Row | Expected | Source | Build |
| --- | --- | --- | --- |
| `cg-tel-sc3700-copied-helpers` | FAIL, names `shellWord` and `canonical` | diff archive `45f03605…` at base `6a2e45d3ef1a`; gate FAILs on ships 8E9DE610 (`shellWord`) and 4767E276 (`canonical`); fix `aff94ba69` | `--base 6a2e45d3ef1a --diff <archived diff> --diff <repair diff>` |
| `cg-tel-sc3700-copied-helpers-pair` | PASS | the same diff with `aff94ba69`'s resolution: `shellWord` imported, one exported `canonicalPath` that `failures.mts` and `gate-shared.mts` import | second staged map of the same run |
| `cg-git-31122e0c6-pure-move` | PASS | commit `31122e0c6`, a relocation under the line cap; commit-guard PASS on ship 332F018A | `--base 5d47750f0279 --diff <git show 31122e0c6> --redact "FRINK'S=A CONSUMER'S"` |

The repair diff applies three edits to the archived post-image:
- the hunk `aff94ba69` makes to `gate-shared.mts`;
- `failures.mts` drops its local `canonical` and imports `canonicalPath`;
- `dependencies.mts` imports `shellWord`, deletes its own copy, and renames `canonical` to the
  exported `canonicalPath`.

[`commit-guard-controls.test.mts`](../../../../gate-engine/review/eval/reviewers/__tests__/commit-guard-controls.test.mts)
holds the executable labels:
- the copies are absent at base, present in the bug and gone in the repair;
- the pair shares one base;
- every line the move deletes, outside imports, reappears in another staged file.

## Limits

- **Holdout floor not met.** There is one FAIL and two PASS rows, all holdout. The sc-3700 family
  is development-exposed: the brief change it motivated was tuned on it.
- **No allowlisted-pair decoy yet.** No commit cleanly isolates a change to an allowlisted pair.
