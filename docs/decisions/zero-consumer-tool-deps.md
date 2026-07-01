---
slug: zero-consumer-tool-deps
created: 2026-07-01
---

# zero-consumer-tool-deps

## Target · 2026-07-01 — devkit BUNDLES the gate tools and runs them from its OWN install: jscpd via optionalDependencies (cl

**Context:** A consumer of devkit had to add up to four tool deps to their OWN package.json — @norvalbv/devkit + jscpd + eslint + eslint-plugin-project-structure + @typescript-eslint/parser — because the clone/structure gates resolved those binaries from the CONSUMER's node_modules. This polluted every consumer manifest, and standalone (no-package) repos could not run structure-lint AT ALL (the eslint plugin was unresolvable without a package), so the gate silently no-op'd.
**Ruling:** devkit BUNDLES the gate tools and runs them from its OWN install: jscpd via optionalDependencies (clone-detector resolves it hoist-agnostically from devkit's dir), and eslint + eslint-plugin-project-structure promoted to dependencies, driven by a new guard-structure bin that lints via buildStructureConfigs. init stops adding jscpd/eslint/plugin/parser to consumers (electron keeps its consumer-side preset).
**Consequences:**
- Positive: A consumer package.json gains ZERO tool deps: package mode adds only @norvalbv/devkit (+ biome/husky); standalone adds nothing. Structure-lint now runs in standalone too (config-driven stacks), via the global guard-structure bin. The pinned devkit version in .devkit/config.json is the single source of tool versions.
- Negative: Every devkit install now pulls eslint + the structure plugin (install-size bloat, even for non-structure consumers). Standalone gates are fail-open, so CI/contributors MUST install the pinned global devkit or the gates silently skip. Package-mode IDE eslint squiggles become best-effort (the consumer can re-add eslint locally if wanted).
**Vision-fit:** n/a — internal tooling (devkit is dev infrastructure).
**Researched:** fallow's model (the tool ships its own deps; consumer copies only config) — the pattern the maintainer cited.
**Rejected:** (a) consumer-owned tool deps (the status quo) — LOSES: pollutes every consumer manifest and makes a zero-dep / standalone-full-gate install impossible; explicitly rejected by the maintainer. (b) global-only tools without bundling — LOSES: a standalone/global consumer without the tool present gets a silently fail-open clone + no structure-lint, and tool versions drift per machine (non-reproducible).
**Anchored-bet:** [BET]
**Scope:** cli/commands/init.mjs,gate-engine/co-occurrence/clone-detector.mjs,gate-engine/structure/**,package.json
**Source:** collab
