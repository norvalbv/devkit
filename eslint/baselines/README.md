# `eslint/baselines/`

Generated **grandfather lists** + **permanent exemptions** for the structure-governance lint rules
(see [`docs/structure-governance.md`](../../docs/structure-governance.md) for the story and
[`docs/directory-structure.md`](../../docs/directory-structure.md) for the rules).

These files exist so the structure rules can be turned on **without rewriting the whole repo in one
go**: every file that already broke a rule when the rule was introduced is listed here and exempted;
every *new* file must obey the rule. The lists are **shrink-only** — fix a file, its entry disappears
on the next regen, and the wall closes a little further.

## What's in here

One generated baseline per declared `structure.trees[]` entry, plus the shared ratchet/exempt files:

| File | Kind | Rule it feeds | Goal |
|------|------|---------------|------|
| `<tree>.mjs` (e.g. `cli.mjs`, `gate-engine.mjs`) | debt (generated) | that tree's folder-structure | shrink to `[]` |
| `imports.mjs` | debt (generated) | import walls (`independent-modules`) — only when `structure.walls` is non-empty | shrink to `[]` |
| `size.json` | debt (generated) | `max-lines` / `max-lines-per-function` ratchet | shrink toward 0 |
| `fanout.json` | debt (generated) | folder fan-out ratchet (≤ `fanoutCap` impl files/folder) | shrink toward 0 |
| `exempt.mjs` | **permanent** (hand-edited) | structure + import walls | **never shrinks** |

**Debt vs exempt** is the key distinction:

- **Debt** (everything generated): a file that *should* conform but doesn't *yet*. Temporary. Never
  edit by hand — regen rewrites it.
- **Exempt** (`exempt.mjs`): a deliberate architectural exception that will *never* conform.
  Hand-maintained, one reason per entry.

If a generated entry is really a permanent exception (a vendored file, a generated giant), **move it to
`exempt.mjs`** rather than chasing it to zero.

## Regenerating (only after a deliberate audit — never to silence a new offender)

```bash
devkit init       # re-runs the structure + import-wall baseline generators from guard.config.json
                  # (the size + fan-out ratchets re-freeze via gate-engine/ratchets/* at commit time)
```

You **cannot** game these by hand-deleting an entry: regen re-adds anything still violating, and the
two `.json` ratchets have monotonic gates (the count can only go down). The honest way to remove an
entry is to *fix the file*.

## The end state

Drive each debt file's contents to `[]` / `0`, reclassifying genuine exceptions into `exempt.mjs` as
you go. **Keep the empty files** — an empty baseline is the standing proof that its wall has zero
grandfathered exceptions.
