# Devkit quality-gate baseline — 2026-08-15

**Outcome: the harness accepted the current Devkit baseline. This is the control for the Oxc-first
migration; it does not compare a replacement engine yet.**

The canonical machine-readable result is
[`../../../../gate-engine/eval/performance/results.baseline.json`](../../../../gate-engine/eval/performance/results.baseline.json).

## Reproduce

From the Devkit repository root with dependencies already installed:

```sh
bun run benchmarks:quality-gates
```

The command archives the pinned source commit, builds disposable committed Git fixtures, applies a
deterministic staged patch for local lanes, and writes the canonical result atomically. It never runs
the structure rules against the live checkout.

## Protocol

- Source: pinned commit `2a488a19412cb69a855c6eb926aa9485d638d5ec`.
- Host: Darwin 25.5.0, arm64, 10 logical CPUs, Node v24.19.0.
- Runtime floor: Node 23.6.0, matching the repository engine requirement.
- Tools: Biome 2.5.6, ESLint 10.5.0, TypeScript 6.0.3.
- Samples: 3 warmups followed by 10 measured runs per contender.
- Local cache state: an isolated contender fixture and cache retained across samples.
- Full cache state: a fresh committed fixture and fresh tool cache directories for every sample;
  the installed dependency tree is shared and excluded from timing.
- Acceptance: stable requested manifests, exit codes, analyzer-reported file sets where available,
  and normalized diagnostic sets.
- Statistics: median and nearest-rank p95. With 10 observations, nearest-rank p95 is the maximum.

## Results

CPU is user plus system time wait-accounted to the timed command. RSS is `/usr/bin/time`'s maximum
resident-set measurement for the timed command; it is not represented as an exact sum of every
simultaneously resident descendant.

| lane | scope manifest | diagnostics | wall median / p95 | CPU median / p95 | RSS median / p95 |
|---|---:|---:|---:|---:|---:|
| Biome lint · changed/staged | 1 | 0 | 0.168s / 0.299s | 0.060s / 0.070s | 46.4 / 46.6 MiB |
| Biome lint · full clean | 514 | 0 | 1.039s / 8.283s | 2.215s / 3.130s | 143.3 / 148.6 MiB |
| Biome format · changed/staged | 1 | 0 | 0.140s / 0.191s | 0.060s / 0.070s | 46.4 / 46.6 MiB |
| Biome format · full clean | 652 | 0 | 0.479s / 0.732s | 0.970s / 0.990s | 104.6 / 105.9 MiB |
| ESLint structure · changed/staged | 1 | 0 | 0.335s / 0.556s | 0.285s / 0.350s | 87.7 / 90.1 MiB |
| ESLint structure · full clean | 514 | 0 | 0.654s / 0.816s | 0.780s / 0.880s | 193.4 / 201.0 MiB |
| TypeScript no-emit · full clean | 514 | 0 | 2.185s / 2.477s | 4.470s / 4.630s | 443.1 / 461.7 MiB |

All samples are deliberately retained. Ten observations are enough for the migration control
requested by this ticket, but not enough to characterize the tail; future A/B tickets should use the
balanced schedule and inspect raw samples before attributing a tail change to an engine.
Host load is not controlled, so absolute wall times are local observations rather than portable tool
constants.

Biome and ESLint receive their scope manifests on argv. TypeScript is config-owned: its 514-file
manifest records the relevant tracked source inventory, while `tsc -p tsconfig.json` determines the
actual compiler program. The artifact records this distinction as `inputsAppliedToCommand: false`.

The run passed the harness protocol but is intentionally catalogued as `evidence-only`. It must not
be labelled accepted tracker evidence until the exact committed implementation and result are
published as an immutable checkpoint.

## What this baseline can and cannot answer

It answers the current cost of Devkit's separate lint, format, structure, and type-check commands on
the pinned repository state. It also establishes the manifests and normalized diagnostic sets that a
replacement must preserve.

It does not yet show that Oxc is faster or compatible, and the individual lanes must not be added as
if they were one serial pre-commit critical path. CPU and memory accounting are intentionally labelled
with their platform semantics rather than claimed as portable exact process-tree totals.
