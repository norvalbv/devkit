---
slug: electron-backends-toggle-externalised
created: 2026-06-29
---

# electron-backends-toggle-externalised

## Target · 2026-06-29 — The electron eslint snapshot stays devkit-owned, but the backend toggle moves to guard.config.json

**Context:** `devkit migrate` treats `eslint.config.mjs` as fully devkit-owned and full-replaces it on any drift (migrate.mjs `eslintChange`). The electron template is a 760-line inline snapshot whose socket-server + vercel-serverless structure-lint blocks ship commented with an invitation to uncomment. A consumer (frink) that accepted that invitation had its whole file overwritten on `migrate --apply` — its backend structure governance silently re-disabled. The conflict: the file is owned by devkit (wants updates) yet has a region the template itself invites the consumer to edit.
**Ruling:** Keep electron's `eslint.config.mjs` as a devkit-owned snapshot (full-replaceable), and externalise the ONE consumer-editable fact — *which backend processes to structure-lint* — to `guard.config.json` as `backends: { socketServer, vercel }`, read at lint-load. The template builds the backend flat-config blocks conditionally from that boolean; the file is fully devkit-owned again, so full-replace is safe and `migrate.mjs` needs zero change (the existing `guardConfigChange` merge already preserves the consumer's value). Template default is **both-on** (`true,true`) — the template already declares both backends in `scanRoots`/`boundaries`/`review.backendRoots` and loads their baselines unconditionally; a both-off default would let migrate re-disable an existing consumer's governance through the front door (the very bug). Missing/partial key degrades to off via `?? {}`.
**Consequences:**
- Positive: migrate can never again silently disable backend governance — it preserves an explicit `backends` choice or applies the both-on default. Enabling/disabling a backend is a one-line data edit in the merge-safe file, not a hand-edit of a 760-line devkit-owned config. Conforms to [[synced-assets-layout-agnostic]] (config-at-runtime, not hardcoded layout).
- Negative: the electron eslint config now reads `guard.config.json` at load (one `readFileSync` + parse, missing-file-safe). The structure-const evaluation is unchanged (always built; the boolean only gates the spread). The 760-line snapshot itself remains — the real end-state is the engine pivot (below), deferred.
**Vision-fit:** n/a — internal tooling; layout/topology-as-data is devkit's portability stance across consumers.
**Researched:** live repro on frink's clobbered `eslint.config.mjs`; feature-critique adjudication (Approach D over sentinel-splice B; B in tension with [[synced-assets-layout-agnostic]]); `loadBaseline` missing-file guard (template L54); `guardConfigChange` merge-preserve (migrate.mjs:55-75).
**Rejected:**
- (a) **Sentinel-region text-splice (B)** — REJECTED: restructures the 760-line file, near-duplicates `husky-block.mjs`, fragile non-AST splice, and treats topology as text inside a stack-shaped file — against [[synced-assets-layout-agnostic]].
- (b) **Engine pivot — move electron onto `buildStructureConfigs(guard.config.json)` (C)** — DEFERRED, not viable today: `gate-engine/structure/eslint-config.mjs` compiles folder-structure trees only; electron's import-walls (`createIndependentModules`/`independent-modules`) have no engine compiler, so the topology cannot move. Remains the end-state once wall-compilation lands (see Anchored-bet).
- (c) **migrate warn-and-skip on drift** — REJECTED: stops the data loss but abandons auto-update; forces a manual hand-merge of a 760-line file every release.
**Anchored-bet:** [DEFERRED] electron's preset moves fully behind the engine once import-wall compilation (`independent-modules`) lands in `buildStructureConfigs`; until then this snapshot + externalised-toggle is the bridge. Do not rip out the `backends` toggle before that lands.
**Scope:** templates/electron/**
**Source:** collab · v0.24.0 migrate-clobber fix
