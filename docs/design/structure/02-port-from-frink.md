# Piece 2 — Port missing frink assets + frink-migration checklist

> Design doc written first (compaction-safe) per the master plan's per-piece gate. Piece 1 (the
> config-driven engine) is done + committed (`c7c7c66`). This piece ports the *knowledge* assets, not
> code: the developer docs, the baselines README, the exempt template, the research report, and a
> tracked checklist of what the user does in **frink** later (frink is NOT touched by this work).

## Scope

Port the generalizable governance knowledge from frink into devkit, adapted to devkit's **config-driven**
model (one `structure` block + one generic walker), and record the frink-side migration as a checklist.

## Deliverables

| File | Source | Adaptation |
|------|--------|------------|
| `docs/design/structure/research-auto-foldering.md` | `/tmp/structure-report.md` | verbatim minus the agent preamble line — the durable rationale |
| `docs/structure-governance.md` | frink `docs/developer-docs/structure-governance.md` (337L) | **rewritten** for the config model: walls + grandfather-and-shrink + debt-vs-exempt + regenerate≠silence concepts kept; six-electron-tree specifics replaced by the `structure` block + generic walker; paths point at `gate-engine/`, not `scripts/` |
| `docs/directory-structure.md` | frink `docs/developer-docs/directory-structure.md` (218L) | **condensed** — the *spec* is now the `structure` schema in `01-generalize-engine.md`; this doc keeps the generalizable placement *principle* (process-boundary-first → kind → one-home) + points to the schema |
| `eslint/baselines/README.md` | frink `eslint/baselines/README.md` (55L) | generalized file list (`<tree>.mjs` per declared tree, not the fixed six); debt-vs-exempt + shrink-only + keep-empty kept |
| `templates/_shared/exempt.mjs` | frink `eslint/baselines/exempt.mjs` (35L) | generic template: a `structureExempt` array + an `importWallExempt` array with the doctrine comment, no renderer/main specifics |
| `docs/design/structure/frink-migration.md` | — | the tracked checklist: what the user does in frink later to move it onto this engine + the exact files to delete |
| `docs/design/structure/05-suggester-DEFERRED.md` | research §5.2 | the deferred-suggester stub (note, not built) |

## What devkit already covers (no port needed)

- **Ratchet bins.** Frink's `scripts/size-disable-ratchet.mjs` + `folder-fanout-ratchet.mjs` are already
  devkit's `gate-engine/ratchets/*` (language-aware via `sourceExtensions`, per Task 6). Different paths,
  same mechanics — no gap.
- **Baseline generators.** Frink's `scripts/generate-eslint-baseline.mjs` + `generate-import-wall-baseline.mjs`
  are devkit's `cli/lib/generate/generate-{structure,import-wall}-baseline.mjs`, now config-driven (Piece 1).
- **The decisions log + skill.** Frink's `docs/decisions/renderer-structure-governance.md` and the
  `structure-governance` skill are frink-internal history — not portable assets; the *why* is captured
  in `research-auto-foldering.md` instead.

## Verification

- Docs render; internal links resolve (relative paths from devkit root).
- `eslint/baselines/README.md` describes the generic `<tree>.mjs` shape, matching what Piece 3 generates.
- `templates/_shared/exempt.mjs` is valid `.mjs` (parses, exports two arrays).
- `frink-migration.md` lists exact frink paths to author/delete — actionable without re-deriving.
- No frink file is modified (this work is devkit-only).
