# Devkit native Oxlint migration experiment — 2026-08-16

**Shortcut:** sc-1677
**Decision:** retain Biome as Devkit's ordinary JavaScript, TypeScript, JSON, and CSS linter. Native
Oxlint is materially faster on the common JavaScript/TypeScript manifest, but the candidate does
not preserve the active Biome preset's diagnostics or language scope. No production lint ownership
changes in this PR.

This is a one-off migration experiment, not an ongoing benchmark or CI performance gate.

## Question and decision rule

Can Devkit replace the ordinary-lint part of `biome check` with native Oxlint rules while leaving
formatting and filesystem topology with their separately evaluated owners?

Adoption required all of the following:

1. every current lint responsibility had an explicit destination;
2. clean-repository and focused-fixture diagnostics matched in scope and meaning;
3. JavaScript, TypeScript, and currently linted JSON/CSS inputs remained covered;
4. no filesystem, cross-file, formatter, or TypeScript responsibility moved accidentally; and
5. the same-file paired candidate reduced CPU or latency against the A0 control direction.

A faster candidate that dropped a rule or file class was pre-registered as a retain decision.

## Pre-implementation critique

**Proposal:** replace Biome lint with Oxlint's native default/correctness rules, then leave Biome
installed only for formatting while A5 evaluates Oxfmt.

**Verdict:** do not implement this substitution. The runtime opportunity is strong, but the
configuration contracts are not equivalent. Biome's `recommended` preset is a broad, evolving set
across JavaScript, TypeScript, JSON, and CSS. Oxlint's default set is a different 96-rule selection; on
clean Devkit it reports new Unicorn and unused-code diagnostics while still lacking an equivalent
for an explicitly required Biome rule and selecting no JSON or CSS. Treating zero shared clean
errors as parity would therefore make the gate faster by checking different things.

The durable next step is a future explicit, rule-by-rule preset: freeze the exact responsibilities
Devkit wants, provide retained owners for JSON, CSS, and `useTopLevelRegex`, and then repeat these
paired fixtures. That work must not be hidden inside the Frink port.

## Responsibility inventory

This inventory covers every configured lint responsibility Devkit owns or distributes. The large
implicit recommended set is kept as one atomic responsibility because neither tool publishes a
cross-tool equivalence contract; silently translating rule names would not establish semantic
parity.

| Current responsibility | Current owner | Oxlint candidate | Result and rationale |
| --- | --- | --- | --- |
| Biome recommended JavaScript/TypeScript rules | `biome/base.jsonc` | Oxlint native default/categories | **Retain Biome.** Different preset membership and severities; clean Devkit is 0 versus 18 findings. |
| Recommended JSON/config diagnostics | Biome | None in Oxlint | **Retain Biome.** Oxlint selected 0 files for the duplicate-key fixture. |
| Recommended CSS diagnostics | Biome | None in Oxlint | **Retain Biome.** Oxlint selected 0 files for the unknown-property fixture. |
| Unused imports | Biome `noUnusedImports` error | `eslint/no-unused-vars` | Candidate matched the focused unused-import finding, but is combined with variables and cannot migrate independently while the enclosing preset remains. |
| Unused variables | Biome `noUnusedVariables` error | `eslint/no-unused-vars` | Candidate matched the focused ordinary and underscore-prefixed cases; retain with the enclosing preset. |
| Hook call placement | Biome `useHookAtTopLevel` error | `react/rules-of-hooks` | **Retain Biome.** Devkit self-host has no React program on which to prove parity; consumer/Frink coverage belongs to A7. |
| Regex allocation | Biome `useTopLevelRegex` error | No native equivalent in Oxlint 1.78.0 | **Retain Biome.** The fixture's third diagnostic was absent from Oxlint. |
| Console use | Biome `noConsole` warning in the shared base | `eslint/no-console` | Candidate exists. Devkit self-host explicitly disables this for CLI UX; consumer migration is deferred with the preset. |
| React component exports/types/barrels | `biome/react.jsonc` overrides | Native React/TypeScript/import rules where available | **Retain Biome.** No Devkit React fixture, and `noRestrictedTypes` message/options need consumer parity. |
| Import organization | Biome assist | Oxfmt sorting / separate fixer | Not lint ownership; A5 decides the formatter/fixer path. |
| Folder/file topology and domain placement | ESLint + `eslint-plugin-project-structure` | Standalone filesystem guard | Not ordinary source lint; A4 owns the prototype and benchmark. |
| File lines and folder fan-out | Devkit shrink-only ratchet gates | Existing direct gates | Already runner-independent; do not move to Oxlint and lose baseline semantics. |
| Function lines | No active Devkit self-host rule | Oxlint `max-lines-per-function` | No responsibility to migrate here; evaluate where a consumer actually enables it. |
| Import walls / restricted imports | No active Devkit self-host wall | Oxlint `no-restricted-imports` | No responsibility to migrate here; Frink parity belongs to A7. |
| Compiler diagnostics and build emission | TypeScript | Oxc type-aware/type-check | Not ordinary lint; A6 owns the shadow decision. |

## Pinned tools and scope

| Item | Value |
| --- | --- |
| Devkit source | `4d624d059c8974aa58e0f3a27277cd6fd90383a4` |
| Host | Darwin 25.5.0, arm64, 10 logical CPUs |
| Runtime | Node 24.19.0 |
| Control | `@biomejs/biome@2.5.6` |
| Candidate | Devkit wrapper + `oxlint@1.78.0` + `oxc/oxlint.base.json` |
| Same-language manifest | 535 tracked JavaScript/TypeScript files under Devkit's authored roots |
| Timing | `/usr/bin/time -lp`; CPU = user + system |
| Memory | 5 ms `ps` sampling; summed RSS for command and every live descendant |
| Sampling | 3 paired warm-ups, then 10 interleaved measured runs per command |

The paired manifest contains the JavaScript/TypeScript subset both engines can parse. JSON and CSS
were excluded from the speed table and tested separately because Oxlint does not select them. This
keeps the performance comparison honest while making the missing scope visible rather than
pretending the smaller candidate manifest is a complete replacement.

## Diagnostic parity results

### Clean 535-file manifest

Biome exited clean with 0 diagnostics. Oxlint processed all 535 files with 96 active rules and
reported 18 warnings:

| Oxlint finding | Count |
| --- | ---: |
| `unicorn/no-useless-fallback-in-spread` | 13 |
| `unicorn/no-new-array` | 3 |
| `unicorn/no-useless-spread` | 1 |
| `eslint/no-unused-vars` | 1 |

These may be useful rules, but they are new policy/debt, not parity with the current clean gate.

### Focused JavaScript/TypeScript fixture

A temporary `.mts` fixture contained an unused import, an underscore-prefixed intentionally unused
variable, an ordinary unused variable, and a regular-expression literal inside an exported
function. It was removed before this PR.

Biome reported exactly three errors: `noUnusedImports`, `noUnusedVariables`, and
`useTopLevelRegex`; it correctly ignored the underscore-prefixed variable. Oxlint, run with every
rule disabled except native `eslint/no-unused-vars`, matched the two unused-code cases and also
ignored the underscore-prefixed variable. It emitted no regex-allocation diagnostic because Oxlint
1.78.0 has no native equivalent.

### Focused JSON fixture

A temporary JSON object declared the same key twice. Biome reported one
`noDuplicateObjectKeys` error. Oxlint printed "No files found to lint", reported 0 selected files,
and emitted no diagnostic. The fixture was removed before this PR.

### Focused CSS fixture

A temporary CSS rule used the misspelled property `colr`. Biome reported one
`noUnknownProperty` error. Oxlint again printed "No files found to lint", reported 0 selected files,
and emitted no diagnostic. The fixture was removed before this PR.

## Performance result

The native candidate is substantially cheaper on the shared 535-file language scope. That is a
real opportunity and the reason to revisit this migration; it does not override the failed parity
conditions.

| Runner | Wall median / p95 | CPU median / p95 | Process-tree RSS median / p95 |
| --- | ---: | ---: | ---: |
| Biome lint | 0.375 s / 0.520 s | 1.920 s / 2.180 s | 194.9 / 195.4 MiB |
| Devkit native Oxlint candidate | 0.120 s / 0.130 s | 0.210 s / 0.230 s | 126.6 / 149.2 MiB |
| Candidate delta | **-68.0% / -75.0%** | **-89.1% / -89.4%** | **-35.0% / -23.6%** |

CPU is the primary metric requested by the epic. Median is the midpoint of the fifth and sixth
sorted samples; with ten samples p95 is the nearest-rank maximum. RSS was collected in a separate
paired campaign by summing the wrapper and live descendants, so the Oxlint subprocess is not
mistaken for the whole command.

### Raw samples

Each row is `wall seconds / CPU seconds / process-tree RSS MiB`. Timing and RSS came from separate
interleaved ten-run campaigns after the same three warm-ups.

| Run | Biome | Oxlint candidate |
| ---: | ---: | ---: |
| 1 | 0.370 / 1.870 / 194.5 | 0.120 / 0.200 / 128.8 |
| 2 | 0.360 / 1.940 / 194.9 | 0.120 / 0.220 / 119.9 |
| 3 | 0.380 / 1.910 / 194.4 | 0.120 / 0.210 / 141.4 |
| 4 | 0.380 / 1.900 / 195.0 | 0.120 / 0.210 / 149.2 |
| 5 | 0.420 / 1.930 / 195.4 | 0.120 / 0.210 / 117.0 |
| 6 | 0.520 / 2.180 / 195.0 | 0.130 / 0.230 / 124.5 |
| 7 | 0.450 / 2.100 / 195.0 | 0.110 / 0.220 / 109.7 |
| 8 | 0.330 / 1.970 / 195.0 | 0.100 / 0.190 / 118.0 |
| 9 | 0.340 / 1.900 / 194.8 | 0.110 / 0.190 / 134.8 |
| 10 | 0.350 / 1.910 / 194.8 | 0.110 / 0.210 / 133.2 |

## Ownership after this experiment

No hook, script, dependency, preset, or generated config changes in sc-1677.

| Responsibility | Owner |
| --- | --- |
| Ordinary JavaScript/TypeScript/JSON/CSS lint | Biome 2.5.6 |
| Formatting and import organization | Biome pending A5 |
| Filesystem/cross-file topology | ESLint bridge pending A4 |
| Size/fan-out shrink-only policy | Existing Devkit direct ratchet gates |
| Oxc native lint | Measured candidate only; A1 remains opt-in infrastructure |

## Revisit conditions

Re-run this experiment after Devkit defines an explicit, versioned desired-rule manifest instead
of treating either tool's recommended/default preset as policy. Adoption also needs a named owner
for JSON and CSS diagnostics, a native or Devkit-owned equivalent for `useTopLevelRegex`, React
preset fixtures, and exact changed/staged hook wiring. Only then remove Biome lint invocation; do
not claim a CPU win by retaining duplicate parsing in the same hook.

## Sources

- Biome JavaScript rule inventory and recommended preset:
  <https://biomejs.dev/linter/javascript/rules/>
- Biome JSON rule inventory:
  <https://biomejs.dev/linter/json/rules/>
- Biome CSS rule inventory:
  <https://biomejs.dev/linter/css/rules/>
- Oxlint native rule inventory and default markers:
  <https://oxc.rs/docs/guide/usage/linter/rules.html>
- A0 control and migration decision:
  [the consolidated Devkit/Frink report](../2026-08-15-oxlint-js-plugin-frink/README.md)
