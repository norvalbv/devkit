# Shared reviewer runtime path scope

## Problem and boundary

Reviewer file eligibility is split across roots, `sourceExtensions`, checklist-local filters, and
reviewer-specific assumptions. The visible failure was correctness: Devkit reviewed `.mts` files but
silently omitted executable `.sh` and `.mjs` runtime paths. Fixing only correctness would leave the
same configuration unable to describe the runtime universe for the rest of the reviewer fleet.

This change introduces one shared review-path boundary. It does not change reviewer charters,
correctness lenses, chunk size, model authority, waivers, or the meaning of `sourceExtensions` for
ratchets, structure checks, and language-aware semantic duplication.

## Prior art and alternatives

CodeRabbit, PR-Agent, and Copilot separate path filtering from language classification. The result is
`SOLVED_ELSEWHERE`: repository-owned include/exclude policy defines eligible review evidence, then
individual reviewers apply their own capabilities. The context-cost findings in
[Same Task, More Tokens](https://arxiv.org/abs/2402.14848),
[Lost in the Middle](https://arxiv.org/abs/2307.03172), and
[ContextCRBench](https://arxiv.org/abs/2511.07017) support excluding known non-runtime evidence before
chunking and fan-out.

Three shapes were evaluated:

1. `review.paths: { include, exclude }` — selected. One policy defines the reviewable runtime
   universe for every reviewer.
2. `review.correctnessPaths: { include, exclude }` — rejected after critique. It fixes the observed
   correctness symptom but leaves reviewer selection fragmented.
3. Per-reviewer include/exclude blocks — rejected. They duplicate repository topology and make drift
   between reviewers the default.

## Configuration contract

`review.paths` is optional:

```json
{
  "review": {
    "paths": {
      "include": ["src/**", "scripts/**/*.sh"],
      "exclude": ["**/__tests__/**", "**/*.test.*", "dist/**"]
    }
  }
}
```

When absent, every reviewer preserves its legacy selector exactly. When present, `include` is
required and non-empty, `exclude` may be empty, patterns are repository-relative POSIX globs, and
exclusion wins. The configured policy is authoritative across the repository and is not intersected
with `sourceExtensions` as a global eligibility test.

After shared eligibility:

- backend and frontend reviewers intersect their configured domain roots and remove prose;
- commit-guard intersects `scanRoots` and `sourceExtensions` because semantic duplication remains a
  language-aware capability;
- correctness and conventions receive the complete eligible runtime set.

The matcher rejects absolute paths, traversal, NULs, Git pathspec magic, empty patterns, and obvious
disable-all exclusions. Opaque binary formats are always denied, while extensionless and unknown
text paths remain eligible when explicitly included.

## Snapshot and evidence semantics

The staged Git index is the current policy authority. When `guard.config.json` changes, reviewer
selection unions the HEAD and staged policy for every reviewer. For HEAD policy A, staged policy B,
and unstaged worktree policy C, the reviewed universe is A union B; C is ignored. A configuration
change therefore cannot exempt its own runtime changes.

The gate passes each reviewer's exact selected file list through `DEVKIT_REVIEW_STAGED_FILES`.
Correctness treats that list as authoritative evidence, including deletions. Its standalone
checklist uses the same shared matcher; a missing config means policy unset, while other read
failures remain fatal. Selected filenames passed to Git use top-anchored literal pathspecs.

## Migration and verification

Absence preserves legacy behavior, so existing consumers do not widen on upgrade. Fresh templates
declare stack-derived shared paths. Devkit includes runtime `.mts`, `.mjs`, and `.sh` surfaces and
excludes tests, eval fixtures, prose, generated output, and assets.

Regression coverage pins:

- legacy behavior for every reviewer when `review.paths` is absent;
- shared inclusion/exclusion across domain, correctness, and conventions reviewers;
- language-tool filtering after shared eligibility for commit-guard;
- HEAD plus staged policy union with an ignored unstaged third policy;
- gate and scan use of the same repository selector;
- missing standalone config, deleted evidence, and literal Git pathspecs;
- malformed, fully excluded, and opaque-binary scope; and
- deeply readonly normalized path declarations.
