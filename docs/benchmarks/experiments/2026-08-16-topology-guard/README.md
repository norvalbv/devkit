# Standalone topology guard prototype — 2026-08-16

**Story:** Shortcut sc-1678

**Status:** one-off migration experiment, not a recurring performance metric

**Verdict:** **retain ESLint; do not ship `guard-topology` from this prototype**

The direct filesystem walker is materially faster and lighter than the current
`guard-structure -> ESLint -> eslint-plugin-project-structure` process. It does not meet the
pre-registered adoption boundary, however: it misses the incumbent import-wall responsibility,
cannot report an illegal empty directory, and has no config input for Electron's six hand-written
folder trees. Speed does not override these coverage gaps.

This experiment makes no claim that the prototype is Oxc-native. Both the current command and the
candidate are Devkit-orchestrated JavaScript processes; the candidate directly walks the filesystem.

## Decision

Keep the current ownership split:

- config-driven placement, naming, and required-sibling rules remain on `guard-structure`, which
  runs Devkit's packaged ESLint and `eslint-plugin-project-structure`;
- Electron's six hand-written folder trees and its import walls remain in the consumer-side ESLint
  preset;
- generated structure baselines and permanent exemptions keep their current semantics; and
- no install, doctor, hook, package dependency, or command registration changes in this story.

A later direct runner can be reconsidered when it has a real import parser/resolver with the current
wall's import forms and alias behavior, emits directory-level violations, and repeats this paired
benchmark at coverage parity. The faster placement-only prototype is not being shipped as a hybrid:
that would retain ESLint for walls while adding a second gate and diagnostic surface.

The pre-implementation critique and rejected alternatives are recorded in
[`feature-critique.md`](feature-critique.md). This outcome is an implementation note under the
existing [`oxc-toolchain-migration`](../../../decisions/oxc-toolchain-migration.md) Target, not a new
architectural axis.

## Headline benchmark

The fixture has 481 governed files across 80 component directories: TypeScript, TSX, CSS, HTML,
SVG, and an arbitrary extension. The current lane uses a packed `@norvalbv/devkit@0.51.1` installed
inside the disposable fixture, so the plugin observes the same `node_modules` layout as a real
consumer. Dependencies and packaging are completed before timing.

Three warm-ups were discarded. Each table cell is median / nearest-rank p95 over 20 measured runs;
the order alternated current-first and candidate-first. CPU is aggregate user + system from
`/usr/bin/time -lp`. Process-tree RSS is sampled every 10 ms by summing the wrapper and all
descendants, with the direct child's wait4 peak as a floor.

### Clean full-tree lane

| Runner | Wall | CPU | Process-tree peak RSS |
| --- | ---: | ---: | ---: |
| Current packaged ESLint chain | 253.2 / 282.6 ms | 490 / 520 ms | 116.1 / 116.6 MiB |
| Direct walker prototype | 90.5 / 106.2 ms | 120 / 130 ms | 79.2 / 79.6 MiB |
| Median reduction | **64.3%** | **75.5%** | **31.8%** |

### One placement violation lane

Both runners find exactly one `src/loose.ts` placement violation before timing this lane.

| Runner | Wall | CPU | Process-tree peak RSS |
| --- | ---: | ---: | ---: |
| Current packaged ESLint chain | 264.3 / 277.3 ms | 500 / 530 ms | 116.1 / 116.7 MiB |
| Direct walker prototype | 87.6 / 97.8 ms | 120 / 130 ms | 79.3 / 79.5 MiB |
| Median reduction | **66.9%** | **76.0%** | **31.7%** |

The latency and CPU win is large enough to justify a future implementation, but it is not adoption
evidence without responsibility parity. The candidate also reports a generic path violation where
the plugin currently explains allowed names or the missing sibling, so diagnostic-message parity
would still need deliberate UX work.

## Coverage and exact diagnostic differences

Each row uses a fresh Node process and a two-component fixture. “Current command” means the packaged
generic `guard-structure` folder rule. Import walls are tested separately through the broader
incumbent ESLint `independent-modules` owner because the generic command does not compile
`structure.walls` today.

| Case | Expected | Current command | Direct candidate | Difference |
| --- | --- | ---: | ---: | --- |
| Clean tree | clean | 0 | 0 | exact |
| Folder/file placement | violation | 1 | 1 | same path/count; current message lists allowed names, candidate is generic |
| Required `index.ts` sibling | violation | 1 | 1 | same path/count; current names the missing sibling, candidate is generic |
| Folder naming | violation | 1 | 1 | same path/count; current lists allowed folder pattern, candidate is generic |
| Root CSS file | violation | 0 | 1 | candidate expands coverage; current source-extension manifest never invokes the rule for it |
| Root HTML file | violation | 0 | 1 | candidate expands coverage |
| Root SVG asset | violation | 0 | 1 | candidate expands coverage |
| Arbitrary extension | violation | 0 | 1 | candidate expands coverage |
| Illegal empty directory | violation | 0 | 0 | **shared gap; candidate walker discards directory-only entries** |
| Ignored directory | clean | 0 | 0 | exact |
| Generated debt baseline | clean | 0 | 0 | exact |
| Permanent exemption | clean | 0 | 0 | exact |
| Cross-feature import wall | violation | 1 via incumbent ESLint wall | 0 | **candidate parity failure** |
| Electron's six hand-written folder trees | violations | incumbent consumer ESLint preset | no config input | **candidate responsibility gap; Electron guard config has no `structure` block** |

The CSS/HTML/asset/arbitrary-extension rows are a useful correction to the earlier migration
hypothesis: the baseline walker sees these files, but the generic ESLint gate's generated
`files: src/**/*.{ts,tsx}` manifest does not lint them. The direct walker therefore expands those
classes rather than merely preserving the current command. Existing baselines still suppress the
committed debt in the candidate fixture, but new arbitrary-file enforcement would be a behavior
change requiring its own rollout audit.

The import-wall fixture proves the incumbent rule rejects
`src/feature-a/index.js -> src/feature-b/internal.js` and includes both resolved paths in its
diagnostic. The candidate has no source parser or resolver at all. A regex-only substitute would
also lose `require`, dynamic import, re-export, mock, query-suffix, and alias handling, so it was not
treated as a viable parity implementation.

Static ownership inspection found a second Electron-specific gap beyond import walls. The shipped
Electron preset constructs six `createFolderStructure` policies for renderer, main, shared,
preload, socket, and Vercel trees directly in `templates/electron/eslint.config.mjs`; its
`guard.config.json` has no `structure.trees` representation. The prototype reads only those config
trees, so it cannot even ingest this incumbent folder-topology responsibility. A replacement must
first represent or migrate that preset and then add parity fixtures for all six trees.

## Reproduction

From a clean Devkit checkout on macOS with dependencies installed:

```bash
bun run build
cd docs/benchmarks/experiments/2026-08-16-topology-guard
node benchmark.mjs --output results.json
```

The harness:

1. creates a disposable fixture;
2. packs the checkout and installs Devkit into that fixture without lifecycle scripts;
3. generates the same deterministic 481-file corpus for both runners;
4. runs three discarded warm-ups and 20 alternating samples per lane;
5. runs the coverage cases in fresh processes;
6. records raw samples, diagnostics, host metadata, and the source commit in
   [`results.json`](results.json); and
7. deletes the package and fixture directories after the run.

The committed raw result was captured on Darwin 25.5.0 arm64, 10 logical CPUs, Node 24.19.0, from
source commit `4d624d059c8974aa58e0f3a27277cd6fd90383a4`. Host load was not isolated, so absolute p95 values
should not be generalized to another machine. Alternating paired lanes and the size of the median
deltas make the directional result clear; they do not rescue the coverage failure.

## Revisit conditions

Do not reopen the migration on startup-speed claims alone. Re-run this experiment only after a
candidate can demonstrate all of the following on the fixture and then on Frink:

- directory-level findings, including empty illegal directories;
- a config representation and parity fixtures for all six hand-written Electron folder trees;
- the current import forms, path aliases, query suffixes, and first-match/baseline wall semantics;
- collision-safe generated debt and permanent exemption behavior;
- stable, actionable diagnostics for placement, naming, and required siblings; and
- the same or better process-tree CPU, wall, and RSS result at full coverage parity.
