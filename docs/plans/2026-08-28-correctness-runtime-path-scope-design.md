# Correctness reviewer runtime path scope

## Problem and boundary

Correctness currently inherits `scanRoots` and `sourceExtensions`, even though those fields describe
ratchet and structure-analysis capability rather than runtime behavior. In Devkit this excludes
runtime shell scripts and executable skill helpers from correctness review while still reviewing
every matching `.mts` file. The correctness checklist repeats the same extension filter after the
gate has already selected files, so the evidence can silently shrink a second time.

This change separates correctness scope from language tooling. It does not change the four lenses,
chunk-size policy, test-review charter, verdict authority, waivers, or the meaning of
`sourceExtensions` for ratchets, structure checks, or commit-guard.

## Prior art and alternatives

CodeRabbit, PR-Agent, and Copilot use reviewer-owned path/glob filters to define review scope;
language classification is a separate concern. The research result is `SOLVED_ELSEWHERE`: explicit
path policy is the established boundary, and extension allowlists should not be the positive
eligibility test. The context-cost findings in [Same Task, More Tokens](https://arxiv.org/abs/2402.14848),
[Lost in the Middle](https://arxiv.org/abs/2307.03172), and
[ContextCRBench](https://arxiv.org/abs/2511.07017) support excluding known non-runtime evidence before
chunking rather than paying for broad, weakly relevant context.

Three shapes were evaluated:

1. `review.correctnessPaths: { include, exclude }` — selected. It is a cohesive optional block and
   does not collide with the existing flat `correctnessModel` and `correctnessChunkLoc` knobs.
2. `review.correctness: { include, exclude }` — rejected. It creates a partial namespace beside
   those existing flat correctness fields and forces a second migration later.
3. Declared roots plus `correctnessExclude` — rejected. It cannot admit runtime files outside
   `scanRoots` or with extensions outside `sourceExtensions` without preserving the current bug or
   widening unrelated gates.

## Configuration contract

`review.correctnessPaths` is optional:

```json
{
  "review": {
    "correctnessPaths": {
      "include": ["src/**", "scripts/**/*.sh"],
      "exclude": ["**/__tests__/**", "**/*.test.*", "dist/**"]
    }
  }
}
```

When the block is absent, correctness preserves the legacy algorithm exactly: the union of declared
roots, filtered by `sourceExtensions`, with `.test` and `.spec` implementation files excluded. When
present, `include` is required and non-empty, `exclude` may be empty, patterns are repository-relative
POSIX globs, and exclusion wins. Configured includes are authoritative across the repository and are
not intersected with declared roots or `sourceExtensions`.

The matcher rejects absolute paths, traversal, NULs, Git pathspec magic/negation, empty patterns,
and obvious disable-all exclusions. Obvious opaque binary formats are always denied, while
extensionless and unknown text paths remain eligible when explicitly included. Git-reported
repository-relative names are the only matcher input; globs are never passed to Git.

## One evidence path

A shared packaged helper owns validation and matching for both gate selection and standalone
checklist execution. The gate passes its exact selected file list through
`DEVKIT_REVIEW_STAGED_FILES`; when present, the checklist validates the repository-relative names
but never filters that list again. Standalone checklist runs use the same helper and effective
config. Added, modified, renamed, and deleted runtime paths stay in semantic evidence; the staged
diff, not worktree existence, is authoritative.

Selected filenames passed back to `git diff` use top-anchored literal pathspecs so a crafted filename
cannot be interpreted as pathspec syntax. The shared matcher is a packaged review asset, and its
bytes join reviewer identity so behavior changes invalidate cached PASSes.

## Migration and governance

Absence means legacy behavior, so existing consumers do not widen on upgrade. Fresh examples
document the optional block, and Devkit's own `guard.config.json` opts in explicitly. Devkit includes
runtime `.mts`, `.mjs`, and `.sh` paths under `cli`, `gate-engine`, `scripts`, `templates`, and
executable skill scripts/helpers; it excludes tests, eval/bench fixtures, prose, generated `dist`,
and assets.

Malformed configured scope fails loudly instead of becoming an empty pass. A valid scope matching no
files is reported as “no configured runtime paths matched,” which is distinct from invalid policy.
Configuration changes cannot exempt themselves: selection considers both the baseline and staged
scope and uses their union when `guard.config.json` changes.

## Verification

Regression coverage will pin:

- legacy behavior when the block is absent;
- `.mts`, `.mjs`, `.sh`, extensionless, and unknown-text inclusion without changing commit-guard;
- test/prose/generated/fixture and opaque-binary exclusion, including exclude precedence;
- validation of hostile or disabling patterns;
- exact gate/checklist parity, including deleted and unusual filenames;
- literal Git evidence pathspecs;
- review-mode and oversized-injection fallback behavior;
- packaged-helper identity/cache invalidation; and
- Devkit's effective configured runtime surface.
