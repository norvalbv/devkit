---
name: commit-guard
description: Guard commits against unintentional code duplication using semantic search. Invoke before committing staged changes under your scanRoots (see guard.config.json).
---

# Commit Guard

Dispatch the `commit-guard` agent before committing. It runs semantic search queries against staged files via `mcp__codebase__searchCode` (CLI fallback: `node .claude/tools/search-code/bin/semantic-search.mjs search "<text>"`), surfaces unapproved duplicates for human review, and enforces per-file DRY rules. Queries describe what the staged symbol DOES (purpose/behaviour) — not its name. searchCode is hybrid (dense + sparse BM25); use grep for exact-name lookups.

**REQUIRED SUB-SKILL:** Use `dup-detection` for allowlist mechanics, matcher/clone-detector CLI, burn-down workflow, and the pre-flight rule (`matcher scan --new --changed` before declaring done).

## When to use

- User says "ready to commit", "commit this", or stages changes under your `scanRoots` (the source roots declared in `guard.config.json`)
- User adds new utilities, hooks, or components that might duplicate existing ones

**Monorepo:** gates run from the **package directory**, not the git root — the husky guard block does `( cd "<pkgRel>" … )`, so `guard.config.json` and git pathspecs both resolve to that package and sibling packages don't cross-trigger. Read config and run scripts relative to the package dir, not the repo root.

## Scripts

`.claude/skills/commit-guard/scripts/`:

| Script | Purpose |
|--------|---------|
| `checklist.mjs` | Session tracking — `init`, `status`, `check-file`, `finalize`, `cleanup` |
| `co-occurrence.mjs` | Allowlist CRUD — `add`/`remove`/`check`/`prune`/`list` (pairs) + `add-clone`/`remove-clone`/`check-clone`/`baseline-clones` (clones). **See `dup-detection` skill.** |

## Two detectors, one allowlist (overview)

- **Embedding matcher** (`scripts/co-occurrence/matcher.mjs`) — semantic, symbol-level. Catches renamed/paraphrased dups. Runs as the **blocking pre-commit gate** (`scan --new --changed --gate`, scoped to staged files) + the advisory `.husky/pre-push` net. Exit codes: 1 = block, 0 = clean, 2 = fail-open.
- **Clone detector** (`scripts/co-occurrence/clone-detector.mjs`) — verbatim, token-level (jscpd). Catches sub-chunk + inline-JSX (molecules) dups the matcher misses.

This skill's agent runs both as a best-effort EARLY surface (step 3 searchCode = semantic; step 3b = clone detector); the husky gate is the deterministic authority. When the gate blocks, it prints a **pre-filled `add` / `add-clone` command** — **copy that command** rather than hand-building one (hand-built = empty metadata).

For the allowlist model (decay, fragmentHash, symFileKey), CLI reference, burn-down workflow, mirror gotcha, and `reconcile` vs `prune`: **`dup-detection` skill**.

→ **Heavy reference:** [`scripts/co-occurrence/README.md`](../../../scripts/co-occurrence/README.md).
