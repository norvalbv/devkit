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

## Target · 2026-07-13 — devkit init self-host mode is the canonical dogfood writer (no self-dep, source hook)

**Context:** The hand-authored .husky/pre-commit was a SECOND source of truth for the gate chain and drifted silently from the generator: the review reviewer fleet never ran on a devkit commit (only decisions was wired) and no test kept the hand hook in sync, so devkit shipped a reviewer gate it never ran on itself and a generator change could leave the dogfood hook stale unnoticed.
**Ruling:** devkit init gains a first-class self-host mode, auto-detected by package name @norvalbv/devkit. It adds NO self-dependency (skips patchPackageJson) and generates the pre-commit hook from the SAME generator as consumers, rewriting each bunx guard-* invocation to node gate-engine/*.mts (source). devkit upgrade regenerates it and a parity test locks it to the generator; assets still sync via sync-skills/sync-agents and the configs stay hand-owned.
**Consequences:**
- Positive: devkit dogfoods its own reviewer fleet plus the full recommended gate set on every commit; the dogfood hook can no longer drift from the generator (one source of truth plus a CI parity test); a generator change propagates to devkit's own hook automatically on the next upgrade.
- Negative: The reviewer fleet now runs on every devkit commit (real model spend per commit); dup and clone now gate devkit's own tree and needed a one-time co-occurrence-allowlist grandfather; the bespoke hand-hook header comment is replaced by generated output.
**Vision-fit:** n/a - internal tooling; dogfooding is how devkit validates what it ships.
**Researched:** cli/commands/init.mts (applyInit + patchPackageJson self-dep source), cli/lib/husky/husky-block.mts (the hook generator), gate-engine/deterministic/run.mts (SELF_EXT source resolution), collab feature-critique review.
**Rejected:** (a) keep the hand hook and add only a drift test - REJECTED: leaves two sources of truth, the generator and hook still diverge in shape and the test only catches drift after the fact; (b) devkit init as a normal consumer with a self-dep - INFEASIBLE (unchanged): a package cannot depend on itself by name; (c) devkit init --overlay - REJECTED (unchanged): git-invisible, skips assets, hijacks core.hooksPath which husky reclaims on every bun install.
**Anchored-bet:** [BET]
**Scope:** cli/commands/init.mts,cli/commands/upgrade.mts,cli/commands/doctor.mts,cli/lib/self-host.mts,cli/lib/husky/husky-block.mts
**Source:** collab
**Evidence-change:** The prior ruling rejected devkit-init-in-repo as INFEASIBLE (a self-referential @norvalbv/devkit dep breaks bun install) and DEFERRED the self-repo-guard variant as more surface than the sync commands. The self-host mode removes the infeasibility (no self-dep is ever added), and new evidence - the hand hook's silent drift plus the reviewer gate never running on devkit - shows the sync-commands-only ruling left the GATE half of dogfooding unaddressed.
