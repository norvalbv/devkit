# Vendored anti-slop provenance

- Repository: https://github.com/dmmulroy/anti-slop
- Commit: `446268e5d15baa968eaec669ff65358d36ae6259`
- Vendored: 2026-08-16
- License: MIT (see `LICENSE`)

The 15 rule implementations under `src/rules/` and their helpers under `src/shared/` are copied
unchanged from the upstream production source at the pinned commit. `src/index.ts` is Devkit's
composition seam: it registers those byte-pinned rules together with separately named,
default-error extensions under `src/devkit/`. Devkit installs the composed plugin with a
self-contained `@oxlint/plugins@1.78.0` runtime.
