---
name: dup-detection
description: Use when working with `.co-occurrence-allowlist.json` — fixing a duplication surfaced by the matcher or clone gate, burning down baseline pairs, retiring an allowlist entry, checking allowlist coverage before adding similar code, or invoking matcher / co-occurrence CLI commands (scan, reconcile, prune, add, remove, check).
---

# Duplication detection (frink)

## Overview

Frink catches code duplication at commit via two detectors writing one allowlist (`.co-occurrence-allowlist.json` at repo root): the **embedding matcher** (semantic, symbol-level) and the **clone detector** (verbatim, jscpd, token-level). Entries are keyed by `symFileKey` (pairs) or `fragmentHash` (clones); ranges/similarity/lines are findability metadata only.

## When to use

- An allowlist entry was handed to you with "fix this dup."
- A commit was just blocked by the matcher gate or clone gate (the gate printed a pre-filled `add` / `add-clone` command).
- You're burning down baseline entries (~460 pairs frozen pre-gate).
- Before adding code that might already exist somewhere — check allowlist coverage first.

**Heavy reference:** `scripts/co-occurrence/README.md` (calibration, decay model, full mode list). Don't duplicate — link to it.

## The pre-flight rule (this is the biggest hole)

**Before you declare a dup-fix done — and BEFORE invoking commit-guard reviewers — run the matcher against your staged files:**

```bash
MATCHER_CHANGED_FILES="<fileA>,<fileB>" \
  node scripts/co-occurrence/matcher.mjs scan --new --changed
# exit 0 → dup gone (or covered). Safe to proceed.
# exit 1 → still detected. Refactor more. Do NOT trigger reviewers yet.
# exit 2 → could-not-run (no index / Ollama down). Continue (fail-open).
```

Skipping this = reviewer cascade + tokens torched on a refactor that's actually incomplete. The gate blocks at commit anyway; pre-flight just catches it before the cascade.

## Fixing a dup someone hands you (workflow)

1. **Read the entry's metadata directly.** It already names `fileA:rangeA` + `fileB:rangeB`. Don't `searchCode` for what you already know — read those exact ranges.
2. **Check for the architectural-mirror gotcha** (see below).
3. **Refactor:** extract to `src/shared/lib/` (or feature-shared lib) — let both call sites import the same export.
4. **Pre-flight:** `matcher scan --new --changed` against your two files. Iterate until exit 0.
5. **Retire the allowlist entry:** `co-occurrence.mjs remove <symA> <fileA> <symB> <fileB>` (or `remove-clone <fragmentHash>`).
6. **Then** trigger reviewers + commit.

## The architectural-mirror gotcha

Some pairs are **intentional deploy artifacts**, not real dups: one path is a *generated mirror* of another, where a build step copies shared code into a deploy target's tree. **Do not refactor these**; leave the allowlist entry (or move to a path-rule — README's "Known follow-ups").

- **Example (frink):** `src/shared/X` ↔ `vercel-serverless/_shared/X` — `_shared/` is **generated** by `vercel-serverless/scripts/sync-shared.mjs` from `src/shared/`. Verify with `cd vercel-serverless && bun run check:shared`.
- Detector signal: `similarity: 1` between a source file and its generated mirror (e.g. `src/shared/X.ts` ↔ `vercel-serverless/_shared/X.ts`).

**If the entry matches this pattern, the work is "leave it allowlisted, optionally pursue a path-rule" — not a refactor.**

## CLI quick reference

| Command | What | When |
|---|---|---|
| `co-occurrence.mjs add <symA> <fileA> <symB> <fileB> --description "..."` | Approve a pair | Gate blocked + dup is intentional. **Prefer the gate's pre-filled command** (has `--similarity` + `--range-a/-b` filled). |
| `co-occurrence.mjs add-clone <hash> <fileA> <fileB> --description "..."` | Approve a clone | Same — copy gate's command. |
| `co-occurrence.mjs remove <symA> <fileA> <symB> <fileB>` | Retire an approval | After refactoring the dup away. |
| `co-occurrence.mjs remove-clone <hash>` | Retire a clone approval | After refactoring. |
| `co-occurrence.mjs check <symA> <fileA> <symB> <fileB>` | exit 0 if allowlisted | Before duplicating something — coverage check. |
| `co-occurrence.mjs prune` | **Time-based**: drops entries past `date + decayDays` | Periodic; commit-guard runs it in step 2 setup. |
| `co-occurrence.mjs list` | List entries | Picking a burn-down target. |
| `matcher.mjs scan --new --changed` | **Pre-flight check** (this commit's dups vs the allowlist) | Before declaring a dup-fix done. |
| `matcher.mjs reconcile [--apply]` | **Detection-based**: drops entries `detect()` no longer produces (dead) | After bulk refactors; periodic sweep. Dry-run by default. |
| `matcher.mjs baseline` | Freeze every current candidate | One-shot freeze-the-past (already done). |

`reconcile` vs `prune` — easy to confuse:

- `prune` asks "is this entry past its expiry?" (calendar). Drops 7-day `add` entries. **Doesn't hit baseline** (decayDays 3650).
- `reconcile` asks "does this dup still exist?" (detection). Drops dead baseline entries. **Doesn't care about expiry.**

## Burning down the baseline

1. `co-occurrence.mjs list` — pick a target. **Skip `src/shared ↔ _shared` mirrors** (gotcha above).
2. `co-occurrence.mjs remove …` the entry.
3. Next commit touching that code → gate re-surfaces it → refactor (use the workflow above).
4. Periodically `matcher reconcile --apply` to sweep entries that died incidentally (someone else's refactor killed the dup without removing the entry).

## Common mistakes

| Mistake | Fix |
|---|---|
| Running `searchCode` to find a dup the entry already pinpoints | Read `fileA:rangeA` + `fileB:rangeB` directly. searchCode is for *discovering* dups; entries are pre-discovered. |
| Declaring done after `bun run test:run` without pre-flighting the matcher | Run `matcher scan --new --changed` — gate will block at commit if you don't. |
| Refactoring a `src/shared ↔ _shared` mirror | It's a deploy artifact (`sync-shared.mjs`). Don't touch; either path-rule it or keep the allowlist entry. |
| Confusing `reconcile` and `prune` | `prune` = calendar age. `reconcile` = detection miss. See table. |
| Forgetting `co-occurrence.mjs remove` after a real refactor | The entry doesn't auto-clean. `reconcile` will catch it eventually; `remove` is faster. |
| Hand-building `add` instead of pasting the gate's pre-filled command | Hand-built commands omit `--similarity` + `--range-a/-b` → metadata empty in the allowlist. Paste the gate's command. |

## Red flags — STOP and re-check

- "I'll just commit and see if the gate blocks." → No — pre-flight first.
- "I'll `searchCode` to find the dup." → No — entry already names it.
- "This generated mirror (e.g. `vercel-serverless/_shared/`) shouldn't exist; let me refactor." → No — it's generated.
- "What does `prune` do again?" → Re-read the table above; do not guess.

**Full reference:** [`scripts/co-occurrence/README.md`](../../../scripts/co-occurrence/README.md).
