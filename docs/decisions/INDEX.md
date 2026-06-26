# Decision Index

Living architecture record — the current ruling per axis. Each row links to its full
timeline. New rationale lives in the per-axis file.

| Axis | Current ruling | Why (hook) | Updated |
|------|----------------|------------|---------|
| [devkit-self-dogfood](devkit-self-dogfood.md) | devkit dogfoods its own assets by running its sync commands (sync-skills, sync-agents), which copy skills/ and agents/ into .claude and .cursor as committed files with sha256 manifests — never devkit init (self-dep) and never --overlay (git-invisible, skips skills entirely, hijacks core.hooksPath that husky reclaims on every bun install). Gates run in-repo via node gate-engine/..., never the published bin. | devkit authors the skills, agents and gates it ships, but its own r… | 2026-06-24 |
| [overlay-self-heal](overlay-self-heal.md) | Overlay installs a per-clone LOCAL git alias (alias.ci, in .git/config, uncommitted, dies with the clone) that re-points core.hooksPath back to .devkit/hooks and then commits — it never re-runs init. And runFreezes is now freeze-if-absent: it freezes a baseline only when that baseline file is missing, so re-applying the overlay never re-snapshots an existing one. The explicit guard-size/guard-fanout freeze CLI still re-snapshots on demand. | Overlay sets core.hooksPath (local, uncommitted) to .devkit/hooks, … | 2026-06-26 |
| [synced-assets-layout-agnostic](synced-assets-layout-agnostic.md) | Every synced gate, script and asset resolves directory roots from the consumers guard.config.json (scanRoots, structure.trees, review roots), never a hardcoded stack layout. Docs frame any concrete layout as a labelled example, not universal. Conservative fallback (all-staged, or the electron DEFAULT_ROOTS) when config is absent — never match-nothing. | devkit syncs gate scripts and skills into EVERY consumer repo, but … | 2026-06-24 |
