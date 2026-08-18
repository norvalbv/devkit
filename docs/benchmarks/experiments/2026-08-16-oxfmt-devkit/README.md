# Devkit Oxfmt shadow migration — 2026-08-16

**Verdict:** adopt Oxfmt 0.63.0 for Devkit's own formatting and retain Biome 2.5.6 for
lint/assist plus all consumer configuration and hooks. The hot self-host staged path invokes the
exact pinned Oxfmt package binary directly; `devkit oxc fmt` remains the portable entry point, but
its Node startup is not suitable for this latency-sensitive lane.

This is a one-time migration experiment for Shortcut sc-1679, not a permanent benchmark or release
gate. It follows the staged boundary in
[`oxc-toolchain-migration`](../../../decisions/oxc-toolchain-migration.md).

## What was compared

| Item                 | Value                                                                |
| -------------------- | -------------------------------------------------------------------- |
| Source               | clean Devkit commit `4d624d0` (the merged sc-1675 package runtime)   |
| Host                 | macOS 26.5.1, arm64, 10 logical CPUs; host load uncontrolled         |
| Runtime              | Node 24.19.0; Bun 1.3.1                                              |
| Control              | Biome 2.5.6 `format` over a Biome-formatted mirror                   |
| Candidate            | Oxfmt 0.63.0 `--check` over an Oxfmt-formatted mirror                |
| One-file proxy       | check mode over byte-identical `cli/index.mts`; the hook uses write  |
| Full scope           | the same 558 authored files reported by Biome's configured allowlist |
| Sampling             | 3 discarded warm-ups, then 10 measured samples; A/B order alternated |
| Statistics           | median and nearest-rank p95; with 10 samples p95 is the maximum      |

Timing/CPU and RSS were collected in separate paired runs so the RSS sampler did not inflate wall
time. Wall time used a monotonic nanosecond clock. CPU used `wait4` user+system resource usage.
Process-tree RSS repeatedly sampled `ps` and summed the root plus every descendant at each snapshot;
the reported value is the largest observed sum. Changed runs received 2–8 snapshots and full runs
5–15. Installed dependencies were shared between mirrors and excluded from timing.

## Configuration migration and parity

`oxfmt --migrate biome` succeeded, found the root `biome.jsonc`, and emitted one warning:

```text
"overrides" cannot be migrated automatically yet
```

That warning does not block formatter parity because Devkit's two root overrides only change
Biome linter severities. The generated formatter configuration was nevertheless unsafe to accept:
the migrator did not resolve `extends: ["./biome/base.jsonc"]`, so it produced tabs, 80 columns, and
double quotes instead of Devkit's spaces, 100 columns, and single quotes.

The reviewed configuration corrects those inherited values and also:

- disables Oxfmt's default `package.json` sorting, preserving the existing key order;
- overrides JSON and JSONC to use no trailing commas, matching Biome's JSON formatter;
- keeps `dist`, `templates`, `bun.lock`, and `node_modules` out of scope; and
- uses explicit authored-code globs rather than `oxfmt .`, which would additionally format Markdown,
  YAML, vendored agent assets, generated evidence, and other languages that Biome did not own here.

Biome reported 558 processed files. The shadow Oxfmt invocation processed the same 558 files. The
adopted command processes 559 because it additionally owns `.oxfmtrc.json` itself. Native coverage
is retained for the existing JavaScript/TypeScript, JSON/JSONC, and CSS patterns; generated `dist`
output and vendored prose remain deliberately excluded. Biome continues to own lint and assist via
`biome check --formatter-enabled=false`, so Oxfmt and Biome cannot produce competing formatting
verdicts.

The old self-host staged-file filter used `tsx?`, which covers `.ts` and `.tsx` but not Devkit's
authored `.mts` files. The self-host-only rewrite adds `.mts` and has an execution test that formats
and re-stages a real staged `.mts` fixture. Generic consumer hooks keep their existing Biome filter;
this ticket does not silently broaden another repository's gate.

## Complete one-time output review

The corrected candidate changed 7 of 558 files. JSON, JSONC, configuration, lock, generated, and
vendored files were byte-identical.

| File                                                  | Complete change classification                              |
| ----------------------------------------------------- | ----------------------------------------------------------- |
| `gate-engine/critique/capture-normalizer.mts`         | wraps an interface's generic `extends Pick<...>` header     |
| `gate-engine/decisions/__tests__/eval-bench.test.mts` | expands one long `it(...)` call and adds a trailing comma   |
| `gate-engine/decisions/decision-format.mts`           | aligns a multi-line Boolean expression                      |
| `gate-engine/eval/render.mts`                         | aligns a multi-line Boolean expression                      |
| `gate-engine/review/baseline-gate.mts`                | removes one space before a `for` loop's closing parenthesis |
| `gate-engine/review/run-review.mts`                   | compacts two typed `.catch(...)` callbacks                  |
| `gate-engine/structure/walk.mts`                      | aligns a nested Boolean expression                          |

Six files changed only in whitespace/layout; the expanded `eval-bench` call also gained Oxfmt's
permitted trailing comma. Identifiers, strings, operators, imports, comments, and control flow were
unchanged. After the first Oxfmt pass, a second 558-file write produced the same complete-tree
SHA-256 (`f65a73c1797731932485a7aa6aacce06932e872eaa0efd2ec65bb805b9db0879`).

## Performance results

CPU is the epic's primary metric. Wall time and complete-process-tree RSS are shown alongside it.

| Scope / runner                           | Wall median / p95 |  CPU median / p95 | Tree RSS median / p95 |
| ---------------------------------------- | ----------------: | ----------------: | --------------------: |
| One-file check · Biome direct            | 0.0358 / 0.0561 s | 0.0357 / 0.0475 s |       39.7 / 45.8 MiB |
| One-file check · Oxfmt, 1 thread         | 0.0827 / 0.1043 s | 0.0328 / 0.0531 s |       55.8 / 55.9 MiB |
| One-file check · wrapper, 1 thread       | 0.1470 / 0.1896 s | 0.1113 / 0.1442 s |     137.0 / 137.1 MiB |
| Full · Biome direct                      | 0.1997 / 0.4054 s | 0.8709 / 1.0734 s |     143.7 / 144.2 MiB |
| Full · Oxfmt direct, default threads     | 0.1242 / 0.1492 s | 0.2382 / 0.2700 s |     109.1 / 114.6 MiB |
| Full · Oxfmt direct, 1 thread            | 0.2173 / 0.2712 s | 0.1667 / 0.2193 s |       68.4 / 68.6 MiB |
| Full · `devkit oxc fmt`, default threads | 0.1679 / 0.2259 s | 0.3027 / 0.3481 s |     192.0 / 195.8 MiB |

Derived from medians:

- the adopted direct full lane reduces CPU **72.6%**, wall time **37.8%**, and RSS **24.1%**;
- one-thread full mode reduces CPU **80.9%** and RSS **52.4%**, but increases wall time **8.8%**;
- the one-thread one-file check proxy reduces CPU **8.1%**, while wall grows 131.0% and RSS 40.7%;
  this characterizes startup but is not presented as an exact write-mode hook speedup; and
- the same proxy shows the portable Node wrapper costs 211.8% more CPU and 245.3% more RSS than
  Biome, so the self-host hook avoids that additional wrapper startup and uses the direct pinned
  binary.

The earlier A0 control measured changed Biome formatting at 0.140 s median wall, 0.060 s CPU, and
46.4 MiB RSS, and full formatting at 0.479 s wall, 0.970 s CPU, and 104.6 MiB RSS. Those values are
context rather than a paired comparison: this experiment changed the macOS build and re-ran both
engines on current pinned mirrors. The paired table above is the decision-grade comparison.

## Adoption boundary

This ticket changes only Devkit's own formatter:

- `format` / `format:check` use the exact `oxfmt@0.63.0` dependency from sc-1675;
- CI runs `format:check` before the formatter-disabled Biome lint/assist gate, preserving the
  server-side formatting verdict that `biome check` previously owned;
- the self-host staged hook uses direct Oxfmt with one thread, applies the same authored-path
  allowlist as the full formatter, covers Devkit's `.mts` sources, and preserves partially staged
  files; formatting errors fail the hook closed, and an execution fixture proves staged benchmark
  evidence remains byte-identical. This guarantee applies to the index/worktree state observed at
  hook start; concurrent writers to the same worktree are unsupported and agents must use isolated
  worktrees;
- Biome remains the lint/assist owner with its formatter explicitly disabled in the hard gate; and
- generic package and standalone consumer hooks remain on Biome. Frink migration remains B3 and
  must repeat this output/scope review on Frink rather than inheriting Devkit's result blindly.

The seven reviewed layout changes are committed as the one-time formatter migration. Normal
typecheck, build, lint, structure, tests, self-host parity/doctor, and second-pass formatting are the
post-migration validation set.
