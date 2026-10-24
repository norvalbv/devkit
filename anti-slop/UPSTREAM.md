# Vendored anti-slop provenance

- Repository: https://github.com/dmmulroy/anti-slop
- Commit: `e8c4880471b23ab7f216fba7b27d173a6ef07d4c` (tag `v0.1.2`)
- Vendored: 2026-10-18 (previous pin `446268e5d15baa968eaec669ff65358d36ae6259`, 2026-08-16)
- License: MIT (see `LICENSE`)

The 15 rule implementations under `src/rules/` and the 5 helpers they import under `src/shared/` are
copied unchanged from the upstream production source at the pinned commit. `src/index.ts` is
Devkit's composition seam: it registers those byte-pinned rules together with separately named,
default-error extensions under `src/devkit/`. Devkit installs the composed plugin with a
self-contained `@oxlint/plugins@1.78.0` runtime.

Not vendored: upstream tests, the opt-in `src/effect/` plugin, and rules upstream added after
`v0.1.2` (`no-array-filter-map`, `no-reduce-accumulator-copy`, `require-readable-spacing`). Adding a
rule changes the managed rule surface, so it needs its own activation profile and debt migration.
