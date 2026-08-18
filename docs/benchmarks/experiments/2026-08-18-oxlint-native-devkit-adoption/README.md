# Devkit JS/TS lint migration to Oxlint — 2026-08-18

**Shortcut:** sc-1787
**Decision:** move Devkit's own ordinary JavaScript and TypeScript linting from Biome to a
small, explicit native Oxlint policy. Keep Biome only where Oxlint is not the owner: JSON/CSS
diagnostics and one named regex-performance rule. This is a one-off adoption measurement, not a
new ongoing benchmark gate.

## In plain English

Before this change, `bun run lint` asked Biome to inspect almost all Devkit source code in one
large pass. After it, Oxlint handles normal JavaScript/TypeScript code problems, and the much
smaller Biome passes handle the few things Oxlint does not own.

On the same machine and source tree, the middle result of ten runs was:

| What matters | Before | After | Change |
| --- | ---: | ---: | ---: |
| CPU time used | 2.34 seconds | 0.70 seconds | **70.2% less** |
| Time waited for the command | 0.42 seconds | 0.26 seconds | **36.7% less** |
| Highest combined memory use | 206 MiB | 128 MiB | 37.8% less |

CPU is the decision metric: less CPU leaves more capacity for local tools and coding agents. The
memory number is recorded as a safety check, not as the reason to migrate.

## What owns what after the change

| Concern | Owner | Why |
| --- | --- | --- |
| Normal JS/TS correctness, suspicious-code, and performance checks | Native Oxlint | The explicit 155-rule profile is fast and has no existing Devkit findings. |
| React hook placement | Native Oxlint `react/rules-of-hooks` | This is a direct named replacement for the former React-hook check. |
| Regex literals repeatedly created in production code | Biome `performance/useTopLevelRegex` | Oxlint 1.78.0 has no native equivalent. Tests remain exempt, exactly as before. |
| JSON and CSS diagnostics | Biome | Oxlint does not lint those file types. |
| Formatting | Oxfmt | Already adopted in the earlier formatter decision. |
| Import organisation | Oxfmt/IDE, not this lint gate | Oxfmt can sort imports, but its sort order differs from the old Biome action and enabling it would reformat 412 files. Keep the existing editor assist available and make a focused formatting decision before enforcing Oxfmt sorting. |
| File/folder topology and import walls | ESLint + `eslint-plugin-project-structure` | These are cross-file filesystem rules, not ordinary source lint. |
| Anti-slop debt | Oxlint's vendored JS plugin, through `anti-slop check` | It has its own baseline and staged-index semantics. |
| Type errors | `tsc --noEmit` | Oxlint is not being used as Devkit's type checker. |

The shipped `biome/base` and `biome/react` presets are deliberately unchanged. They are consumer
contracts, and consumer migration needs its own parity and performance work. This change is only
about Devkit linting Devkit.

## Policy change, made explicit

This is not a claim that every rule in Biome's broad `recommended` preset has the same rule name or
message in Oxlint. There is no trustworthy automatic Biome-to-Oxlint translation. Instead, this
change replaces the implicit ambient preset with an explicit Devkit policy:

- enable Oxlint's native `correctness`, `suspicious`, and `perf` categories plus React hooks;
- deliberately leave `style`, `pedantic`, `restriction`, and `nursery` off, because enabling a
  broad style category created 40,755 existing findings rather than a practical gate;
- keep seven native checks off where Devkit's established source conventions legitimately use
  them: `no-await-in-loop`, `no-console`, `no-extend-native`, `no-shadow`,
  `no-underscore-dangle`, `preserve-caught-error`, and `no-map-spread`;
- keep one file-specific `no-unused-vars` exception for the pre-existing unused helper in
  `skills/upstream-sync/scripts/sync.mjs`, rather than pretending this migration has repaired
  unrelated code; and
- retain the named Biome-only regex, JSON, and CSS responsibilities above.

That makes future additions and removals reviewable in `oxc/oxlint.devkit-lint.json` rather than
being hidden inside a changing recommended preset.

## Why the Biome part is now small

Running a general `biome check` after Oxlint was counterproductive: even with JavaScript lint
disabled, it still parsed the JS/TS tree for its import-organising assist and made the combined
command slower than the old one. `biome/non-js.jsonc` prevents that duplicate JS/TS work. The
remaining Biome command checks the 29 in-scope JSON/CSS files; `biome/regex.jsonc` checks the one
retained regex rule on 324 production JS/TS files.

The import organiser remains enabled in the shared Biome presets for editor users. It is simply no
longer a separate CI/static-lint pass for Devkit itself. Oxfmt's built-in import sorter is available
for a future deliberate format migration, not silently enabled here.

## Measurement protocol

The control is a clean archive of `origin/main` at `8f562e02c7bef763b2aee1903040d05c67e22f70`,
running its original `bun run lint`. The candidate is this worktree running the proposed command of
the same name. Both therefore include their real process startup and all their retained checks.

The machine was macOS arm64 with Node 24.19.0, Bun 1.3.1, and ten logical CPUs. There were three
warm-up runs, then ten measured pairs in alternating order. CPU is user plus system time collected
by `/usr/bin/time -lp`; the memory figure samples the command and its children every 10 ms. Raw
samples and summaries are in [results.json](results.json); the reproducer is
[benchmark.mjs](benchmark.mjs).

The p95 (the slowest of these ten runs) also improved: CPU fell from 2.57 seconds to 0.73 seconds,
and wall time from 0.52 seconds to 0.30 seconds.

## Acceptance checks

- The full proposed `bun run lint` exits clean.
- A fixture proves the native Oxlint profile rejects an unused JS/TS value.
- A fixture proves the retained Biome profile still rejects a regex literal in production code.
- The native runner uses a separate config with `--disable-nested-config`, so anti-slop's baseline
  config cannot accidentally join the ordinary lint pass.
- The prior 412-file Oxfmt import-sort rewrite is intentionally not part of this PR.

## Sources

- [Oxlint configuration](https://oxc.rs/docs/guide/usage/linter/config.html)
- [Oxlint rules and native plugins](https://oxc.rs/docs/guide/usage/linter/rules.html)
- [Oxfmt import sorting](https://oxc.rs/docs/guide/usage/formatter/sorting.html)
- [Earlier retain experiment](../2026-08-16-oxlint-native-devkit/README.md)
