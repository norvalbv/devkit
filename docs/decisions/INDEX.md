# Decision Index

Living architecture record — the current ruling per axis. Each row links to its full
timeline. New rationale lives in the per-axis file.

| Axis | Current ruling | Why (hook) | Updated |
|------|----------------|------------|---------|
| [devkit-self-dogfood](devkit-self-dogfood.md) | devkit dogfoods its own assets by running its sync commands (sync-skills, sync-agents), which copy skills/ and agents/ into .claude and .cursor as committed files with sha256 manifests — never devkit init (self-dep) and never --overlay (git-invisible, skips skills entirely, hijacks core.hooksPath that husky reclaims on every bun install). Gates run in-repo via node gate-engine/..., never the published bin. | devkit authors the skills, agents and gates it ships, but its own r… | 2026-06-24 |
| [synced-assets-layout-agnostic](synced-assets-layout-agnostic.md) | Every synced gate, script and asset resolves directory roots from the consumers guard.config.json (scanRoots, structure.trees, review roots), never a hardcoded stack layout. Docs frame any concrete layout as a labelled example, not universal. Conservative fallback (all-staged, or the electron DEFAULT_ROOTS) when config is absent — never match-nothing. | devkit syncs gate scripts and skills into EVERY consumer repo, but … | 2026-06-24 |
