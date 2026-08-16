# Devkit Oxc type-check shadow — 2026-08-16

**Shortcut:** sc-1680
**Decision:** retain `tsc -p tsconfig.json` as the authoritative no-emit checker. The Oxc candidate is
materially faster on this repository, but it executes TypeScript 7 semantics while Devkit still builds
and edits against TypeScript 6.0.3. It therefore remains shadow-only until both lanes use the same
compiler semantics and file-selection contract.

This is a one-off migration experiment, not a permanent performance dashboard or CI benchmark.

## Question and pre-registered decision rule

Can Devkit replace its `tsc --noEmit` responsibility with the type-check diagnostics integrated into
Oxlint without changing which programs, files, or TypeScript semantics are authoritative?

Adoption required all of the following:

1. identical diagnostics on the complete Devkit no-emit program and representative injected errors;
2. the same source/project/reference selection as `tsconfig.json`;
3. the same TypeScript semantic version as the editor and declaration/build compiler;
4. a worthwhile CPU reduction, with wall time and process-tree RSS reported alongside it; and
5. declaration/build emission remaining explicitly owned by TypeScript.

A faster candidate that missed any parity condition was pre-registered as shadow-only.

## Pinned tools and host

| Item | Value |
| --- | --- |
| Devkit source | `4d624d059c8974aa58e0f3a27277cd6fd90383a4` |
| Host | Darwin 25.5.0, arm64, 10 logical CPUs |
| Runtime | Node 24.19.0 |
| Authoritative checker | `typescript@6.0.3`, `tsc -p tsconfig.json` |
| Candidate | `oxlint@1.78.0` + `oxlint-tsgolint@7.0.2001` |
| Candidate command | `devkit oxc lint --type-aware --type-check -A all <236-file manifest>` |
| Timing measurement | `/usr/bin/time -lp`; CPU = user + system |
| Memory measurement | 5 ms `ps` sampling; sum RSS for the live command and every descendant |
| Sampling | 3 paired warm-ups, then 10 interleaved measured runs per command |
| Cache/fixture condition | Fresh `git archive` fixture and fresh tool-cache locations per measured command; installed dependencies shared |

The candidate dependency was installed only in the disposable experiment worktree with
`bun add --no-save`. This PR deliberately does not add it to Devkit's shipped dependencies.

## Scope parity

`tsc --listFilesOnly` identified 236 repository `.mts` inputs under `cli/` and `gate-engine/` after
applying `tsconfig.json` and following imports. The same normalized, repository-relative 236-path
manifest was passed to Oxlint.

This detail is load-bearing. Passing the two source directories directly to Oxlint did **not** match
the TypeScript project: it included test and evaluation files excluded by `tsconfig.json`, producing
many diagnostics that `tsc -p tsconfig.json` intentionally never owns. A future adoption needs a
first-class config-owned selection contract; it cannot substitute a broad directory argument.

Devkit has one no-emit `tsconfig.json` and no project references. This experiment therefore says
nothing about reference-graph parity for consumers such as Frink.

## Diagnostic parity

### Clean repository

Both commands exited successfully with zero diagnostics on the same 236-file manifest.

### Injected error fixture

A temporary authored `.mts` file inside `cli/` introduced two stable assignment errors: a string
assigned to a number variable and a string returned from a function declared to return a number.
The file was removed before measurement and is not part of this PR.

Both engines emitted exactly 2/2 findings with matching path, line, column, code `TS2322`, and
message:

```text
Type 'string' is not assignable to type 'number'.
```

This proves the candidate is wired and reports compiler diagnostics; it does not prove equivalence
between every TypeScript 6 and TypeScript 7 semantic edge.

## Performance result

CPU is the primary metric. Median is the midpoint of the fifth and sixth sorted samples; with ten
samples p95 is the nearest-rank maximum. Host load was uncontrolled, so paired CPU evidence is more
decision-useful than the visibly noisy `tsc` wall-time tail. RSS was measured in a separate paired
campaign by polling the live process tree every 5 ms and summing all resident descendants; this
avoids treating only the largest Oxc subprocess as the whole toolchain.

| Checker | Wall median / p95 | CPU median / p95 | RSS median / p95 |
| --- | ---: | ---: | ---: |
| TypeScript 6.0.3 `tsc` | 3.315 s / 11.320 s | 5.020 s / 6.160 s | 461.0 / 474.4 MiB |
| Oxlint + tsgolint 7 | 0.500 s / 0.630 s | 0.990 s / 1.150 s | 405.4 / 409.2 MiB |
| Candidate delta | **-84.9% / -94.4%** | **-80.3% / -81.3%** | **-12.1% / -13.8%** |

The speed opportunity is real: the candidate used about one fifth of median CPU and 12.1% less
summed median process-tree RSS. The p95 `tsc` wall sample contains a visible host-load outlier, so CPU
is the primary result. Process-tree RSS remains the memory decision metric rather than
`/usr/bin/time`'s largest single process. Performance does not overrule the semantic mismatch below.

### Raw samples

Each row is `wall seconds / CPU seconds / summed process-tree RSS MiB`. Timing and RSS were collected
in separate interleaved ten-run campaigns. Every measured command ran in its own fresh committed
fixture with shared installed dependencies, matching A0's full-lane cache/fixture condition.

| Run | `tsc` | Oxc type-check |
| ---: | ---: | ---: |
| 1 | 3.750 / 5.080 / 447.6 | 0.630 / 0.980 / 408.1 |
| 2 | 11.320 / 5.620 / 474.4 | 0.470 / 1.000 / 405.8 |
| 3 | 2.590 / 4.600 / 473.9 | 0.540 / 0.930 / 404.7 |
| 4 | 2.580 / 4.610 / 426.8 | 0.580 / 0.970 / 399.8 |
| 5 | 2.890 / 4.890 / 470.3 | 0.440 / 0.970 / 405.5 |
| 6 | 2.700 / 4.960 / 456.8 | 0.420 / 0.980 / 387.6 |
| 7 | 2.710 / 4.960 / 453.7 | 0.480 / 1.010 / 403.4 |
| 8 | 3.740 / 5.890 / 454.6 | 0.590 / 1.120 / 409.2 |
| 9 | 3.900 / 5.980 / 470.1 | 0.500 / 1.150 / 407.5 |
| 10 | 4.000 / 6.160 / 465.2 | 0.500 / 1.100 / 405.2 |

## Why the faster candidate is not adopted yet

Official Oxc documentation says type-aware linting is powered by `typescript-go`, requires
TypeScript 7.0+, and needs the separate `oxlint-tsgolint` package. The current v7 package tracks
TypeScript 7.0.2. Devkit still declares and builds with `typescript@6.0.3`.

Replacing only the no-emit gate would therefore create two semantic authorities:

- TypeScript 7 diagnostics during the Oxc gate; and
- TypeScript 6 diagnostics and emission during editor/build workflows.

Zero clean findings plus two common matching errors cannot establish whole-language semantic parity
across that version boundary. It would also leave project-reference behavior untested and require a
bespoke source manifest to avoid checking files that the authoritative config excludes.

Oxc's type-aware linting is documented as stable, while the `typeCheck` configuration field is still
described as experimental. That distinction reinforces the retain decision: native/type-aware lint
rules may be ready before compiler-diagnostic replacement is safe for this repository.

## Ownership after this experiment

| Responsibility | Owner |
| --- | --- |
| No-emit semantic diagnostics | `typescript@6.0.3` via `tsc -p tsconfig.json` |
| JavaScript build emission and import-extension rewriting (declarations disabled) | `tsc -p tsconfig.build.json` |
| Oxc compiler diagnostics | Shadow evidence only; no hook, script, or shipped dependency |

## Revisit conditions

Repeat this paired experiment when Devkit's editor and build compiler use the same TypeScript 7
semantic version as tsgolint. Before adoption, add representative fixtures for TypeScript 6→7
behavior changes, prove config-owned file selection without a generated argv manifest, and exercise a
project-reference fixture. Only then may the no-emit script change; build emission remains a separate
decision even if type-check parity succeeds.

## Sources

- Oxc type-aware linting and TypeScript compatibility:
  <https://oxc.rs/docs/guide/usage/linter/type-aware.html>
- Oxc type-aware v7 release and versioning:
  <https://oxc.rs/blog/2026-07-22-type-aware-linting-stable.html>
- TypeScript 6 transition and TypeScript 7 preparation:
  <https://www.typescriptlang.org/docs/handbook/release-notes/typescript-6-0.html>
- A0 control and migration decision:
  [the consolidated Devkit/Frink report](../2026-08-15-oxlint-js-plugin-frink/README.md)
