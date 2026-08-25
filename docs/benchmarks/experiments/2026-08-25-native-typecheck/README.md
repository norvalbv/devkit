# Stable native TypeScript checking

**Status:** one-off evidence for Shortcut SC-1686. This is not a recurring benchmark, dashboard, or release gate.

## Bottom line

Stable TypeScript 7's native checker is worth adopting for no-emit checks. On the same Frink checkout it used **52.3% less CPU** than TypeScript 6 while preserving the root project's diagnostics and file-selection contract.

| Frink root check | TypeScript 6 | Native TypeScript 7 | Change |
| --- | ---: | ---: | ---: |
| Median CPU | 34.92 s | 16.64 s | 52.3% less |
| Median wall time | 27.33 s | 7.24 s | 73.5% less |
| Median peak process-tree RAM | 2.61 GiB | 3.13 GiB | 20.0% more |

In plain English: each Frink type-check uses about half as much processor work and finishes much sooner. It needs roughly half a GiB more memory while it runs. CPU is the shipping criterion; that memory trade-off is accepted because reducing agent-loop CPU is the goal of this migration.

A smaller Devkit comparison points in the same direction: median CPU fell from 10.45 seconds to 1.35 seconds (87.1% less). That sample used five direct command runs rather than the full B0 harness, so it is supporting evidence rather than the Frink shipping number.

## What changes

- Devkit bumps its own package-local type-check and build commands to exact native TypeScript 7.0.2.
- The compiler is a development dependency. It is not installed when another repository installs Devkit.
- Devkit exposes no `devkit typecheck` command and no consumer-facing TypeScript configuration; each package owns its compiler, `tsconfig.json`, and scripts.
- TypeScript 6 remains a Devkit-only compatibility dependency for tooling that still requires the JavaScript compiler API, including `@typescript-eslint/parser`. It no longer owns Devkit compilation.
- Frink's later cutover will install TypeScript 7 in Frink itself. This experiment proves that local change is worthwhile and compatible; it does not make Devkit the compiler boundary for Frink.

This is deliberately native TypeScript rather than Oxc type checking. Oxlint's `--type-check` path still delegates to tsgolint and remains experimental. More importantly, the Frink probe selected `*.sync.test.ts` files that the root `tsconfig.json` excludes, so it is not a drop-in replacement even though its seeded diagnostics matched.

## Diagnostic and configuration parity

The parity fixture covered syntax errors, assignments, cross-file references, path aliases, missing aliases, generic inference, JSX props, missing globals, `skipLibCheck`, and an excluded `*.sync.test.ts` file.

- TypeScript 6 and native TypeScript 7 reported the same seeded TS1110, TS2307, TS2322, and TS2304 diagnostics at the same file, line, and column with the same message.
- Both suppressed the seeded declaration-file error through `skipLibCheck`.
- Both excluded the seeded `*.sync.test.ts` error.
- Normalized root `--showConfig` output, including the 2,772-file fixture manifest, had the same SHA-256: `93152368e6cb0babd50f59432646e456d4e2303e9024308ef5ec8aa11d8c58ca`.
- Frink's sibling socket-server and marketing configs normalized identically. The vercel-serverless output differed only in TypeScript 6 printing the `node10` alias and explicit false defaults that TypeScript 7 omits; it is outside the root `ts:check` scope.
- Diagnostic exit codes differ (`2` in TypeScript 6, `1` in TypeScript 7), but every Frink gate treats any non-zero result as failure.

Frink currently has no TypeScript project references. Its eventual package-local TypeScript 7 command can keep using the authoritative root configuration without inventing a project-reference migration for this ticket.

## Method

- Apple M4, macOS 26.5.1, Node 24.19.0, Bun 1.3.1.
- Frink candidate commit: `127884bf0d15d942506ff601a734e63e3ce3cfeb`.
- Both lanes ran on Frink commit `127884bf0d15d942506ff601a734e63e3ce3cfeb` over the same root `src/**/*` program.
- TypeScript 6 ran its package-local compiler directly; the candidate ran TypeScript 7 through a prototype Devkit wrapper. The wrapper added only Node startup and `--noEmit`, so it is valid performance evidence but is not the architecture selected for shipping.
- The lanes alternated to reduce machine-load bias. Three warm-ups per lane were discarded and ten samples per lane were measured.
- CPU and elapsed time came from macOS `/usr/bin/time`; process-tree RAM was sampled every 20 ms.
- The repository was not mutated. Separate seeded-fixture runs establish diagnostic parity rather than inferring it from clean benchmark runs.

The machine was under heavy unrelated load during the paired capture. Alternating the two lanes on one checkout makes the CPU comparison useful, but wall time should still be treated as contextual rather than a promise for every machine. The complete samples and parity facts are in [`results.json`](results.json).

## Sources

- [TypeScript 7.0 stable announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)
- [TypeScript native port repository](https://github.com/microsoft/typescript-go)
- [Oxlint type-aware linting](https://oxc.rs/docs/guide/usage/linter/type-aware.html)
- [Oxlint CLI, including experimental `--type-check`](https://oxc.rs/docs/guide/usage/linter/cli)
