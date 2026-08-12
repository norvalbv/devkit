---
name: commit-guard
description: Guard commits against unintentional code duplication using semantic search. Invoke before committing staged changes under your scanRoots (see guard.config.json).
---

# Commit Guard

Dispatch the `commit-guard` agent before committing. It runs semantic search queries against staged files via `mcp__codebase__searchCode`; when that tool is unavailable, use the externally installed `search-code search "<text>"` CLI from the repo root. `search-code` is intentionally not vendored: if its executable or this repo's index is unavailable, report semantic retrieval as unavailable and continue with the deterministic matcher and clone checks. Queries describe what the staged symbol DOES (purpose/behaviour) — not its name. searchCode is hybrid (dense + sparse BM25); use grep for exact-name lookups.

**REQUIRED SUB-SKILL:** Use `dup-detection` for allowlist mechanics, matcher/clone-detector CLI, burn-down workflow, and the pre-flight rule (`matcher scan --new --changed` before declaring done).

## When to use

- User says "ready to commit", "commit this", or stages changes under your `scanRoots` (the source roots declared in `guard.config.json`)
- User adds new utilities, hooks, or components that might duplicate existing ones

**Default (single root `guard.config.json`):** the gates run from the **repo root** — read config and run the scripts relative to the root, where `guard.config.json` lives. **Per-package monorepo (only if you set it up):** when each package keeps its **own** `guard.config.json` with package-relative `scanRoots` and the husky guard block does `( cd "<pkgRel>" … )`, config and git pathspecs both resolve to that package and siblings don't cross-trigger. Do **not** `cd` into a package when the repo uses one root config — that breaks `scanRoots` resolution.

## Scripts

The checklist script lives beside this skill, but the containing provider directory varies:
`.agents/skills` (Codex), `.claude/skills`, or `.cursor/skills`. Resolve it before invoking it;
duplication and allowlist operations use the installed devkit bins (`guard-dup`, `guard-clone`,
and `guard-dup-allowlist`), not a provider-projected sidecar:

```bash
COMMIT_GUARD_SKILL=""
for candidate in \
  .agents/skills/commit-guard \
  .claude/skills/commit-guard \
  .cursor/skills/commit-guard
do
  if [ -f "$candidate/scripts/checklist.mjs" ]; then
    COMMIT_GUARD_SKILL="$candidate"
    break
  fi
done
if [ -z "$COMMIT_GUARD_SKILL" ]; then
  echo "commit-guard checklist unavailable: run devkit sync-skills" >&2
  exit 2
fi
```

| Script | Purpose |
|--------|---------|
| `checklist.mjs` | Per-file review checklist — `init`, `status`, `check-file`, `finalize` (refuses an incomplete/failed checklist), `cleanup` |

## Two detectors, one allowlist (overview)

- **Embedding matcher** (`guard-dup`) — semantic, symbol-level. Catches renamed/paraphrased dups. Runs as the **blocking pre-commit gate** (`scan --new --changed --gate`, scoped to staged files) + the advisory `.husky/pre-push` net. Exit codes: 1 = block, 0 = clean, 2 = fail-open. A fail-open gate is NAMED in guard-deterministic's report (it proved nothing); if the dup gate opts out unexpectedly, `devkit doctor` reports whether the index is present but unwired. `GUARD_DETERMINISTIC_STRICT=1` makes an opt-out fatal.
- **Clone detector** (`guard-clone`) — verbatim, token-level (jscpd). Catches sub-chunk + inline-JSX (molecules) dups the matcher misses.

This skill's agent runs both as a best-effort EARLY surface (step 3 searchCode = semantic; step 3b = clone detector); the husky gate is the deterministic authority. When the gate blocks, it prints a **pre-filled `add` / `add-clone` command** — **copy that command** rather than hand-building one (hand-built = empty metadata).

For the allowlist model (decay, fragmentHash, symFileKey), CLI reference, burn-down workflow, mirror gotcha, and `reconcile` vs `prune`: **`dup-detection` skill**.

→ **Heavy reference:** [co-occurrence detector architecture and operations](references/co-occurrence.md).
