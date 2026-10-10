---
slug: repository-glob-grammar
created: 2026-10-08
---

# repository-glob-grammar

## Target · 2026-10-08 — Repository config globs share one grammar

**Context:** devkit matched consumer-declared repository globs with four implementations: node:path.matchesGlob for review.paths, private regex builders for decision Scope globs and eval suite hashes, and a hand-written grammar for generated paths. matchesGlob applies dotfile rules, so a review.paths include of src/** silently dropped every file under a dot-directory (src/.generated/, app/.storybook/) from AI review with no warning; the eval builder also left ? as a raw regex quantifier. Each new glob consumer re-derived semantics and reviewers spent rounds on the same gap.
**Ruling:** One repository glob grammar, compileRepoGlob/matchesRepoGlob in skills/_devkit/review-roots.mjs (dependency-free because it is synced into consumer repos): a dot is an ordinary character, * and ? stay within one segment, a whole ** segment spans any depth, everything else is literal. Compiling never throws; config boundaries (review.paths, generated[]) reject classes, braces and extglob groups at parse time with an error naming the pattern. review.paths, decision Scope matching, eval suite hashing and generated-path classification all call it. overlay-home's gitignore-derived runtime rules are a different grammar and stay on matchesGlob.
**Consequences:**
- Positive: A glob means the same files wherever a consumer writes it, and an include that looks like it covers a subtree does cover it, dot-directories included. Unsupported syntax fails loudly instead of matching a different set.
- Negative: review.paths no longer accepts braces, character classes or extglob that matchesGlob allowed; a consumer using them gets a hard config error and must list alternatives as separate patterns. No brace expansion is offered. Editing review-roots.mjs shifts the review runtime asset identity once.
**Vision-fit:** n/a — internal tooling
**Researched:** node:path.matchesGlob exposes no dot option (nodejs/node#59015 closed not planned); picomatch {dot:true} has the semantics but cannot resolve from synced consumer copies and still accepts braces/classes; arXiv 2608.02610 documents divergent glob semantics across implementations. Differential over git ls-files: 0 changed matches across 292 decision Scope globs and 184 eval catalog globs.
**Rejected:** (a) picomatch dependency — does not resolve from synced skill copies in consumer repos; (b) keeping matchesGlob plus more special cases — the bare ** special case already existed and missed src/**; (c) brace expansion — no known consumer uses it and it widens the grammar for generated[] too.
**Scope:** skills/_devkit/review-roots.mjs,gate-engine/decisions/check-alignment.mts,gate-engine/eval/source.mts,cli/lib/ship/generated-paths/registry.mts
**Source:** web · https://github.com/nodejs/node/issues/59015
