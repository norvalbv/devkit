# Devkit Oxc dogfood: assembled quality-stack benchmark

- Date: 2026-08-16
- Shortcut: SC-1681
- Host: Apple M4, 10 logical CPUs, 24 GiB RAM, macOS 26.5
- Runtime: Node 24.19.0, Bun 1.3.1

## Decision

Ship the mixed stack, not an all-Oxc replacement:

- Oxfmt owns Devkit formatting and the self-host staged formatter.
- Biome still owns JavaScript/TypeScript/JSON/CSS lint and assist diagnostics.
- Oxlint owns the 15 vendored anti-slop rules through the explicit shrink-only baseline.
- ESLint still owns filesystem/cross-file topology and import walls.
- `tsc` still owns TypeScript 6 compiler diagnostics and JavaScript build emission.

The assembled local agent lane is effectively CPU-neutral while adding the 15 anti-slop rules:
median CPU is **-3.0%**, p95 CPU is **+3.8%**, median process-tree RSS is **-2.7%**, and median
wall time is **+1.7%**. Paired per-sample CPU deltas have a -3.5% median, but the decision table
uses the more conservative independently summarized medians. This is not the large end-to-end CPU
win the epic ultimately targets; it is the costed Devkit compatibility boundary.

The full CI lane is intentionally heavier: median CPU is **+39.4%**, median wall is **+67.1%**, and
median process-tree RSS is **+6.5%**. The lane adds a second full-repository policy family (15
anti-slop rules), checks formatting separately with Oxfmt, and typechecks the newly vendored
anti-slop source. It does not justify removing Biome, ESLint, or `tsc`; their parity studies already
found unmatched responsibilities. Frink must run its own assembled benchmark before enabling the
same gates.

## Results

Three warmups were discarded. Ten measured samples alternated control-first and candidate-first.
CPU is aggregate user + system time from `/usr/bin/time -lp`; RSS is the maximum 10 ms sampled sum
of the wrapper and all descendants. Raw samples and machine-readable protocol are in
[`results.json`](results.json).

### Local deterministic quality segment

This is the hot agent loop. Both sides run the real staged formatter fragment extracted from their
generated hook, full lint, retained topology, and the unchanged staged benchmark-evidence gate. The
candidate additionally runs the real exact-index anti-slop command. The staged fixture is one extra
blank line in `skills/_devkit/checklist-store.mjs`, an extension selected by both the old Biome hook
and new Oxfmt hook.

| Metric | Control median | Candidate median | Delta | Control p95 | Candidate p95 | Delta |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| CPU | 10.500 s | 10.190 s | -3.0% | 11.460 s | 11.890 s | +3.8% |
| Wall | 5.344 s | 5.436 s | +1.7% | 6.143 s | 6.598 s | +7.4% |
| Process-tree RSS | 218.4 MiB | 212.5 MiB | -2.7% | 218.8 MiB | 212.9 MiB | -2.7% |

Control command:

```sh
sh "$DEVKIT_FORMAT_FRAGMENT" \
  && bun run lint \
  && bun run lint:structure \
  && bun run benchmarks:check -- --mode staged
```

Candidate command:

```sh
sh "$DEVKIT_FORMAT_FRAGMENT" \
  && bun run lint \
  && node cli/index.mts anti-slop check --staged \
  && bun run lint:structure \
  && bun run benchmarks:check -- --mode staged
```

### Full repository static-quality segment

| Metric | Control median | Candidate median | Delta | Control p95 | Candidate p95 | Delta |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| CPU | 8.335 s | 11.620 s | +39.4% | 9.750 s | 13.390 s | +37.3% |
| Wall | 2.236 s | 3.737 s | +67.1% | 2.860 s | 4.336 s | +51.6% |
| Process-tree RSS | 469.4 MiB | 500.1 MiB | +6.5% | 482.0 MiB | 510.6 MiB | +5.9% |

Control command:

```sh
bun run lint && bun run lint:structure && bun run typecheck
```

Candidate command:

```sh
bun run format:check \
  && bun run lint \
  && bun run lint:anti-slop \
  && bun run lint:structure \
  && bun run typecheck
```

## Reproduction and controls

- Control: clean `origin/main` archive at `4d624d059c8974aa58e0f3a27277cd6fd90383a4`.
- Candidate: exact staged index tree `44b64383172500584abd31392c0d43a43ef52186`.
- The candidate hash is captured before the harness writes its output. The only subsequent changes
  are this evidence file and its human-readable summary; neither is in the measured command scope.
- Dependencies: the same installed `node_modules` tree is symlinked into both disposable mirrors and
  excluded from timing.
- Each mirror is initialized and committed independently. The local fixture is reset and staged
  before every sample.
- Reviewer, completeness, test, ratchet, and release lanes are excluded from both sides because this
  experiment isolates the changed static-quality segment. They remain in the real hook/CI.
- The harness fails on any nonzero command and deletes its disposable mirrors in `finally`.

Run from a clean/staged candidate tree:

```sh
node docs/benchmarks/experiments/2026-08-16-oxc-devkit-dogfood/benchmark.mjs \
  --output docs/benchmarks/experiments/2026-08-16-oxc-devkit-dogfood/results.json
```

## Diagnostic ownership and duplicate-work audit

| Responsibility | Owner | Local path | CI path | Why it remains |
| --- | --- | --- | --- | --- |
| Formatting | Oxfmt 0.63.0 | Exact proven staged scope, direct pinned binary | `format:check` over the same authored scope | A5 proved byte parity and substantially lower formatter-only CPU. |
| JS/TS/JSON/CSS lint + assists | Biome 2.5.6 | `bun run lint` | `bun run lint` | A3 found unmatched lint/assist scope; Oxfmt is formatting only. |
| Anti-slop syntax/scope rules | Oxlint 1.78.0 + vendored plugin | Exact Git-index snapshot with shrink-only baseline | Full tree plus base-vs-candidate baseline monotonicity | New responsibility; no incumbent duplicate exists. |
| Filesystem topology + import walls | ESLint 10.5.0 + project-structure plugin | `lint:structure` | `lint:structure` | A4 found missing empty-directory, Electron topology, and import-wall parity. |
| Type diagnostics | TypeScript 6.0.3 | Deliberately not in pre-commit | `typecheck` | A6 found semantic/diagnostic mismatch in Oxc's TypeScript-7-oriented path. |
| Ratchets, benchmark evidence, reviewers | Devkit gate-engine | Generated hook | Dedicated CI steps where applicable | Governance, not lint/format/type work. |

No responsibility is run by both Biome and Oxlint: the managed Oxlint base enables only anti-slop,
while Biome's formatter is disabled and Oxfmt owns formatting. ESLint is invoked only for topology.

## Baseline, Git-index, doctor, and editor evidence

- Devkit explicitly adopted 1,677 findings / 1,543 stable fingerprints in
  `.anti-slop-baseline.json`; the file has no timestamp and is deterministic.
- `check --staged` exports `git write-tree` into a temporary mirror and reads source, root config,
  managed config/plugin bytes, and baseline from that exact tree. Partial staging is covered in both
  directions. Config/baseline changes force a full scan; unrelated staged files no-op.
- A candidate baseline may only shrink relative to the base commit. The only bootstrap exception is
  a base with no baseline. A debt-bearing Git rename must persist the regenerated baseline in the
  same commit; the gate verifies the new-path count did not grow and remains valid after merge.
- Self-host init always selects Oxc + anti-slop after applying recorded options. Managed trees and
  their manifests are committed; init/upgrade can reproduce them. Doctor checks runtime pins,
  managed bytes, root composition, all 15 rules, baseline validity, hook parity, and never rewrites
  the baseline—even under `--fix`.
- `.vscode/extensions.json` recommends the official `oxc.oxc-vscode` extension. Oxc's official
  editor documentation says it launches the repository-local `oxlint --lsp`, and its JS-plugin
  documentation includes language-server diagnostics/suggestions in the supported API. CLI/CI
  remain authoritative because the editor extension is optional and the JS-plugin API is alpha.

## Revisit conditions

- Do not migrate Biome lint, ESLint topology, or `tsc` merely to reduce process count. Reopen only
  when their own parity gaps are closed and an assembled benchmark—not a tool-only microbenchmark—
  lowers agent-loop CPU.
- Before Frink adoption, repeat this exact control/candidate protocol on Frink's staged and full
  scopes. Its current ~13k anti-slop debt makes deterministic bootstrap and monotonicity evidence
  mandatory.
- Reconsider the full-CI composition if Oxc can own Biome's remaining diagnostics or TypeScript 6
  compiler semantics; that is where the current extra full-tree passes can actually be removed.
