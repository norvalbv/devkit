---
slug: typescript-source-prebuilt-mjs
created: 2026-07-05
---

# typescript-source-prebuilt-mjs

## Target · 2026-07-05 — TypeScript source, shipped as prebuilt .mjs

**Context:** devkit shipped raw JSDoc-typed .mjs under a no-build, what-you-install-is-what-runs contract. As the codebase grew to ~15k LOC across 148 files, that type layer was near-vacuous: tsconfig ran strict:false and only ~40/148 files carried any JSDoc, so tsc caught almost nothing and refactors + new-contributor changes landed with no type guardrail; the JSDoc that existed was dead weight (TypeScript ignores @param types in .ts). Simply renaming to .ts was blocked because Node refuses to execute TypeScript from a node_modules path and devkit runs from the consumer node_modules (the W-3 invariant), so raw-.ts source would break every consumer gate run under node.
**Ruling:** Author cli/ + gate-engine/ as strict TypeScript (.mts). Dev runs the .mts source directly via Node 23.6+ type-stripping / bun, with no build in the dev loop. devkit release compiles .mts to .mjs into a self-contained dist/ (tsc + an asset-copy of every non-TS file) and commits that dist ON the release commit only (gitignored on working branches), behind a non-bypassable node smoke gate that runs the built bin first. Consumers keep bun add git+https#tag and receive prebuilt .mjs. Every self-referential module path carries a SELF_EXT idiom (derived from import.meta.url) because tsc rewrites import specifiers but not string-literal paths.
**Consequences:**
- Positive: Full strict type safety over 15k LOC (tsc --strict 0 errors, inline types, import-type, discriminated unions, real refactor + onboarding guardrails) with zero consumer-facing change: the install command, the git-URL source, and running .mjs straight from node_modules are all unchanged, and nothing compiles on the consumer machine.
- Negative: The no-build, no-dist property devkit advertised is gone: there is now a maintainer-side build and a generated dist/ committed onto every release tag (build artifacts in git history on tags). Dev + release require Node >=23.6. Every spawn / new-URL / packageDir path to a devkit-own module must carry SELF_EXT (.mts in dev, .mjs in dist) or it ENOENTs in one context, a permanent authoring tax that the migration own regressions came from.
**Vision-fit:** n/a - internal developer tooling.
**Researched:** web: Node docs (Node refuses TS under node_modules; type-stripping default-on 23.6+; --experimental-transform-types removed in Node 26 so only erasable syntax runs natively) and bun docs (lifecycle/prepare scripts do NOT run for git/github deps unless the consumer allowlists the package in trustedDependencies, off by default). brainstorm: a 4-dimension adversarial critique workflow that killed the first (uncommitted-dist) design.
**Rejected:** (a) keep .mjs + strict checkJs + a shared types.d.ts + expanded JSDoc - REJECTED: zero-build and zero-risk, but not real .ts authoring (write @param import('x').T not x: T) and JSDoc ergonomics do not scale at 15k+ LOC, which fails the actual ask. (b) consumer-side prepare build on git install - NON-VIABLE: bun does not run lifecycle scripts for a git dependency unless the consumer adds devkit to trustedDependencies (default-off), so most installs would get raw .ts and break under node. (c) publish a built tarball to a private npm registry - REJECTED: forces every consumer onto an authenticated scoped registry, changing install from git+https#tag to registry auth.
**Anchored-bet:** [BET]
**Revisit-when:** Node ships stable execution of TypeScript from inside node_modules (removing the need to compile at all), OR devkit moves to a published registry package (build-at-publish replaces the committed dist).
**Scope:** cli/commands/release.mts,scripts/copy-dist-assets.mjs,tsconfig.build.json,package.json
**Source:** web · https://nodejs.org/api/typescript.html

## Target · 2026-07-26 — Required new dist artifacts ship with their source

**Context:** The release-only dist policy hid newly generated ignored files from normal status and ship discovery. Three independent source changes landed without their required artifact; a later rebuild then rewrote tracked importers to reference files absent from the package, putting every installed consumer gate at risk of failing before it could run.
**Ruling:** Keep ordinary regenerated dist changes release-only, but ship each newly generated dist artifact in the feature change that first makes tracked output depend on it. Devkit self-host ship and reship fail before worktree creation when physical dist files are untracked, newly added dist paths are unbriefed, or tracked relative imports are unresolved.
**Consequences:**
- Positive: The introducing change owns every new runtime file it requires, so later rebuilds cannot reveal a delayed missing-module failure and release tags retain a self-contained package.
- Negative: A feature PR that introduces a module now carries its narrow generated artifact and must brief that path explicitly; each self-host ship also pays one local dist, index, and import scan.
**Vision-fit:** n/a — internal devkit release reliability
**Researched:** Shortcut sc-1246 evidence from three independent omissions; current ship worktree and release implementation.
**Rejected:** Release smoke only — it executes the CLI entrypoint and missed guard-dup relative imports. Doctor warning only — it does not block the publish path. Commit all regenerated dist on every feature PR — it adds broad generated churn unrelated to the new runtime file.
**Anchored-bet:** [VALIDATED]
**Revisit-when:** The package moves to a registry build-at-publish pipeline that constructs and verifies dist from source without committing generated output.
**Scope:** cli/lib/ship/**,cli/commands/release.mts,scripts/copy-dist-assets.mjs,tsconfig.build.json,package.json
**Source:** shortcut · sc-1246
**Evidence-change:** Three independent post-ruling omissions showed that release-only bulk staging did not protect newly introduced runtime artifacts from disappearing before the release boundary.
