# Devkit's lint hard cutover to Oxlint — 2026-08-18

**Shortcut:** sc-1787

Devkit now runs **Oxlint only** for its own ordinary source-code linting. Its local lint command,
pre-commit hook, and CI do not invoke Biome. This is a deliberate hard cutover, made because CPU
time is the limiting resource for local coding and agent loops.

## Result in plain English

The same Devkit lint command was run ten times before and after the change. The middle result was:

| What you feel | Before | After | Improvement |
| --- | ---: | ---: | ---: |
| CPU occupied by the check | 2.41 seconds | 0.18 seconds | **92.5% less CPU** |
| Time waiting for it to finish | 0.41 seconds | 0.10 seconds | **74.5% faster** |
| Peak memory used by the command and children | 208 MiB | 91 MiB | 56.4% lower |

CPU is the reason for the decision. Memory is only a safety measure here; an increase would have
been acceptable if the CPU saving still made the agent loop materially faster.

## What runs now

| Responsibility | Tool | Reason |
| --- | --- | --- |
| Ordinary JavaScript and TypeScript lint | Native Oxlint | Fast explicit policy: correctness, suspicious-code, performance, and React hook checks. |
| Formatting | Oxfmt | Already selected for Devkit formatting; it is separate from linting. |
| Folder/file topology and import walls | ESLint + `eslint-plugin-project-structure` | These are cross-file filesystem rules, not normal source lint. |
| Anti-slop debt | Oxlint's vendored JS plugin | It uses its own explicit baseline lifecycle. |
| Type errors and build compatibility | `tsc --noEmit` | Oxlint is not a type checker and does not replace Devkit's TypeScript compiler lane. |

`bun run lint` is now exactly `bun run lint:oxlint`. It uses
`oxc/oxlint.devkit-lint.json` and `--disable-nested-config`, so it cannot accidentally inherit the
separate anti-slop policy.

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
  unrelated code.

That makes future additions and removals reviewable in `oxc/oxlint.devkit-lint.json` rather than
being hidden inside a changing recommended preset.

## Checks consciously retired from Devkit's lint command

This cutover removes every Devkit self-hosted Biome pass. Nothing was silently left running as a
fallback.

| Retired check | Why it is not reimplemented |
| --- | --- |
| Biome's `useTopLevelRegex` performance rule | Oxlint 1.78 has no equivalent. A one-rule custom plugin would recreate the maintenance burden this cutover is intended to remove. |
| JSON duplicate-key and CSS-property diagnostics | Oxlint does not lint JSON or CSS. These 29 Devkit config/style files still go through Oxfmt, but their extra Biome lint diagnostics are intentionally no longer a CI gate. |
| Static import organisation assist | The old Biome assist was not a sound part of the lint gate once formatting moved to Oxfmt. Oxfmt import sorting remains deliberately off because its ordering would make an unrelated 412-file rewrite. |

This is a policy decision, not a claim that Oxlint produces the same message for every previous
Biome rule. The explicit native policy and its seven established Devkit exceptions are recorded in
`oxc/oxlint.devkit-lint.json`.

## Important compatibility boundary

The published `biome/base` and `biome/react` files remain in the npm package for existing consumer
projects. They are **not part of Devkit's own runtime toolchain** and no Devkit self-host command
uses them. Removing published configuration paths before Frink is ported would break installed
projects without making Devkit itself faster. Their replacement is therefore consumer migration
work, not an invisible second lint lane.

## Measurement protocol

The control is a clean archive of `origin/main` at `76383ff117bcd64f10cceb0d8cbea12e4d8df3a2`,
running its original `bun run lint`. The candidate is this worktree running the new command of the
same name. Both include normal command startup; each side installs its locked dependencies before
timing, and that setup time is excluded.

The machine was macOS arm64 with Node 24.19.0, Bun 1.3.1, and ten logical CPUs. There were three
warm-up runs, then ten measured pairs in alternating order. CPU is user plus system time collected
by `/usr/bin/time -lp`; the memory figure samples the command and its children every 10 ms. Raw
samples and summaries are in [results.json](results.json); the reproducer is
[benchmark.mjs](benchmark.mjs).

The slowest measured candidate run still used only 0.18 seconds CPU and took 0.11 seconds wall
time, compared with 2.48 seconds CPU and 0.44 seconds wall time for the slowest old run.

## Acceptance checks

- `bun run lint` runs Oxlint only and exits clean.
- A fixture proves the configured native policy rejects an unused TypeScript value.
- A regression test proves the root lint script cannot regain either of the retired Biome fallback
  commands unnoticed.
- The native runner uses a separate config with `--disable-nested-config`, so anti-slop's baseline
  config cannot accidentally join the ordinary lint pass.
- Formatting, topology, anti-slop, and TypeScript retain their separately documented owners.

## Sources

- [Oxlint configuration](https://oxc.rs/docs/guide/usage/linter/config.html)
- [Oxlint rules and native plugins](https://oxc.rs/docs/guide/usage/linter/rules.html)
- [Oxfmt import sorting](https://oxc.rs/docs/guide/usage/formatter/sorting.html)
- [Earlier retain experiment](../2026-08-16-oxlint-native-devkit/README.md)
