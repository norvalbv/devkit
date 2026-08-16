# Feature critique: standalone filesystem topology guard

**Story:** Shortcut sc-1678

**Decision boundary:** adopt only if the candidate preserves the entire topology responsibility and
measurably reduces CPU or agent-loop latency. Otherwise retain the ESLint path and record why.

## Proposal

Promote Devkit's existing config-driven filesystem walker from baseline generation into a direct
`guard-topology` command, then replace the current
`guard-structure -> ESLint -> eslint-plugin-project-structure` path.

## Alternatives considered

1. **Direct walker replacement.** Reuse `walkTree`, load the generated baseline and permanent
   exemptions, and emit violations without starting ESLint. This has the smallest process-startup
   and parser cost, but it is acceptable only at full responsibility parity.
2. **Hybrid direct placement plus ESLint import walls.** Move directory placement to the walker but
   retain ESLint for `independent-modules`. This may reduce part of the cost, but it keeps both
   runners and introduces two diagnostic/configuration surfaces during every agent loop.
3. **Retain ESLint for now.** Keep the current owner until a standalone implementation covers every
   required class. This preserves behavior but leaves the measured startup and parser cost in place.

The benchmark may prototype option 1, but the pre-registered acceptance rule prefers option 3 over
either a coverage regression or an unmeasured hybrid.

## Prior art inspected before the prototype

- [`runStructureGate`](../../../../gate-engine/structure/run.mts), the current packaged
  ESLint orchestration and 0/1/2 contract;
- [`walkTree`](../../../../gate-engine/structure/walk.mts), the existing direct baseline walker;
- the shared grammar-to-ESLint compiler and token predicates in
  [`gate-engine/structure`](../../../../gate-engine/structure/);
- the import-wall baseline generator's handling of resolved paths and loud failures in
  [`generate-import-wall-baseline.mts`](../../../../cli/lib/generate/generate-import-wall-baseline.mts);
- the current structure-governance ownership and baseline model in
  [`docs/structure-governance.md`](../../../structure-governance.md);
- the earlier [Frink lint-toolchain research](../2026-08-15-oxlint-js-plugin-frink/README.md) and
  [`oxc-toolchain-migration`](../../../decisions/oxc-toolchain-migration.md) Target; and
- the installed `eslint-plugin-project-structure@3.14.3` implementation and documentation for
  folder structure, `enforceExistence`, cache deduplication, arbitrary extensions, and
  `independent-modules` import resolution.

## Critique by lens

### Feasibility and data-flow correctness

The existing `walkTree` is a strong placement prototype because it already consumes the same
`guard.config.json` grammar and token predicates as the ESLint compiler. It is not yet a gate:

- it returns only file paths intended for a grandfather baseline and deliberately drops directory
  entries, so an empty illegal directory has no observable violation;
- its ignored-directory contract is basename membership, while ESLint consumes generated glob
  patterns; equivalence must be tested rather than assumed;
- it has no import parser or resolver, so it cannot implement `independent-modules` import walls;
- the generated baseline and `exempt.mjs` are asynchronous module inputs to ESLint, whereas the
  walker itself currently does not load or subtract either set;
- ESLint/plugin diagnostics are attached to linted files and can be deduplicated by the plugin's
  cache. Exact message/count equality is therefore a stricter requirement than merely finding the
  same broken subtree.

### Runtime configurations

The candidate must behave correctly for absent roots, multiple roots, source-extension overrides,
CSS, HTML, assets, arbitrary extensions, empty directories, ignored directories, generated debt
baselines, permanent exemptions, and malformed config/baseline inputs. Devkit's generic
`guard-structure` command currently compiles grammar trees only. Electron's six folder trees and its
import walls remain hand-written in the consumer-side ESLint configuration, while the Electron
guard config has no `structure` block. A replacement claim must cover both owners before ESLint can
be removed, rather than benchmarking only the generic command and silently narrowing “topology.”

### UX and failure behavior

A direct command could give agents materially earlier feedback and avoid loading a JS lint engine.
However, different path prefixes, duplicate counts, or missing required-sibling messages would make
existing baselines and remediation guidance misleading. The existing 0 clean / 1 violation / 2
fail-open contract must remain stable. A hybrid would also make it unclear which command owns a
reported structural error.

### Security and trust boundaries

The walker operates inside consumer repositories, so every path must remain consumer-cwd-relative.
Import resolution is security-relevant: a naive regex over source text would miss dynamic imports,
re-exports, mocks, aliases, and resolver behavior that the current plugin handles. A partial parser is
not an acceptable substitute for the current wall.

## Verdict before implementation

**PROCEED WITH THE PROTOTYPE, WITH A RETAIN-BY-DEFAULT VERDICT.** Benchmark the direct walker on a
pinned, reproducible fixture and record its coverage matrix and exact diagnostics. Adopt it only if
all classes above pass and process-tree CPU or wall latency improves. Any import-wall,
empty-directory, baseline, ignore, arbitrary-file, or unrepresented Electron-preset gap is
independently sufficient to retain ESLint, regardless of the speed result. This is an implementation
note under the existing `oxc-toolchain-migration` Target, not a new decision axis.
