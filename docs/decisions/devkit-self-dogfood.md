---
slug: devkit-self-dogfood
created: 2026-06-24
---

# devkit-self-dogfood

## Target · 2026-06-24 — devkit dogfoods its own assets via sync commands, never init (self-dep) or overlay (git-invisible)

**Context:** devkit authors the skills, agents and gates it ships, but its own repo had none installed (.claude and .cursor absent) — so Claude/Cursor sessions in devkit ran without devkits own skills, and architectural changes went un-gated. The naive fix, devkit init in-repo, would add @norvalbv/devkit as a git devDependency on ITSELF: a self-referential dep that breaks bun install (a package cannot depend on itself by name) and pins node_modules to a lagging published tag on every version bump.
**Ruling:** devkit dogfoods its own assets by running its sync commands (sync-skills, sync-agents), which copy skills/ and agents/ into .claude and .cursor as committed files with sha256 manifests — never devkit init (self-dep) and never --overlay (git-invisible, skips skills entirely, hijacks core.hooksPath that husky reclaims on every bun install). Gates run in-repo via node gate-engine/..., never the published bin.
**Consequences:**
- Positive: devkit sessions get devkits own skills and agents; the assets ship committed with the repo; zero package.json dependency, so version bumps never create an install cycle.
- Negative: The synced copies are committed duplicates of skills/ and agents/ — re-run sync after editing a source skill or the copy drifts (the manifest sha256 lets doctor detect drift); doubles the file count across two surfaces.
**Vision-fit:** n/a — internal tooling; dogfooding is how devkit validates what it ships.
**Researched:** cli/commands/init.mjs patchPackageJson (the self-dep source), cli/lib/overlay.mjs (git-invisible design plus the husky core.hooksPath caveat), cli/commands/sync-skills.mjs (copy plus manifest, no dep).
**Rejected:** (a) devkit init in-repo — INFEASIBLE: adds a self-referential @norvalbv/devkit git devDep that errors or diverges on bun install and lags the pin on every bump; (b) devkit init --overlay — REJECTED: deliberately git-invisible (.git/info/exclude) so nothing ships with the repo, does not sync skills/agents at all, and seizes core.hooksPath which devkits own husky reclaims every bun install; (c) add a self-repo guard to patchPackageJson and run full init — DEFERRED: more surface than the sync commands already give.
**Anchored-bet:** [VALIDATED]
**Scope:** cli/commands/sync-skills.mjs,cli/commands/sync-agents.mjs,cli/commands/init.mjs
**Source:** collab · commit 37346c3
