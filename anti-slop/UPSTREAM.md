# Vendored anti-slop provenance

- Repository: https://github.com/norvalbv/anti-slop, the maintained fork of https://github.com/dmmulroy/anti-slop
- Commit: `b9dbc740905baa1123a3ee4f512fe0933d9e916b` (tag `v0.2.2`)
- Vendored: 2026-11-18 (previous pin `e8c4880471b23ab7f216fba7b27d173a6ef07d4c`, dmmulroy/anti-slop `v0.1.2`, 2026-10-18)
- License: MIT (see `LICENSE`)

The 15 rule implementations under `src/rules/` and the 6 helpers they import under `src/shared/` are
copied unchanged from the fork's production source at the pinned commit. Fix a bug in these files in
the fork, then re-pin here; never edit them in place. `src/index.ts` is Devkit's composition seam: it
registers those byte-pinned rules together with separately named, default-error extensions under
`src/devkit/`. Devkit installs the composed plugin with a self-contained `@oxlint/plugins@1.78.0`
runtime.

Not vendored: the fork's tests, the opt-in `src/effect/` plugin, and the rules added after upstream
`v0.1.2` (`no-array-filter-map`, `no-reduce-accumulator-copy`, `require-readable-spacing`). Adding a
rule changes the managed rule surface, so it needs its own activation profile and debt migration.
