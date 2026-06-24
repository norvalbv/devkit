---
slug: synced-assets-layout-agnostic
created: 2026-06-24
---

# synced-assets-layout-agnostic

## Target · 2026-06-24 — Synced assets are layout-agnostic — roots from guard.config.json, never a hardcoded stack layout

**Context:** devkit syncs gate scripts and skills into EVERY consumer repo, but several hardcoded frinks electron layout (src/renderer, src/main, socket-server/, vercel-serverless/). On any non-electron or monorepo consumer those gates misfired or silently no-op'd — move.mjs pruneBaselines never pruned a moved files stale baseline entry, and skill docs taught universal-looking paths that do not exist there. Silent wrong behaviour across the whole consumer base.
**Ruling:** Every synced gate, script and asset resolves directory roots from the consumers guard.config.json (scanRoots, structure.trees, review roots), never a hardcoded stack layout. Docs frame any concrete layout as a labelled example, not universal. Conservative fallback (all-staged, or the electron DEFAULT_ROOTS) when config is absent — never match-nothing.
**Consequences:**
- Positive: Gates run correctly on any consumer layout (single-package, monorepo, non-electron); no silent no-op or misfire; synced docs stop misleading non-frink readers.
- Negative: Each script must read and resolve config instead of a literal, and a shared canonical-roots helper is needed to keep prune and writer in sync; the electron default is retained as a fallback, so the frink-coupling is demoted to a default, not fully deleted.
**Vision-fit:** n/a — internal tooling; layout-agnosticism is devkits portability USP across stacks.
**Researched:** HANDOVER-decouple-frink.md audit cataloguing every hardcoded frink path across cli/ and skills/; gate-engine/config.mjs resolveGuardConfig cwd-relative W-3 invariant.
**Rejected:** (a) keep per-stack hardcoded layouts — INFEASIBLE: misfires on every non-electron consumer, the bug this fixes; (b) full genericization of structure-governance docs to placeholders — REJECTED: guts the electron-specific placement table (the skill IS frinks multi-process model), chose a scoping banner pointing at guard.config.json instead; (c) per-skill sync-scoping so structure docs ship only to structure stacks — REJECTED: a new sync mechanism beyond this fixs scope.
**Anchored-bet:** [VALIDATED]
**Scope:** skills/**,cli/commands/move.mjs
**Source:** collab · v0.16.9..v0.16.11 de-frink
