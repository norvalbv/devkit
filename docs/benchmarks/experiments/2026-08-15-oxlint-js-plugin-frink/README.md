# Frink lint-toolchain research: Oxlint, Oxfmt, Biome, ESLint, and anti-slop — 2026-08-15

**Status:** complete research consolidation with two one-off local measurements: a Devkit command
control and an exploratory Frink plugin-compatibility experiment. Neither is an ongoing benchmark
or a decision-grade Oxc migration result.

**Decision:** [migrate quality tooling to Oxc one proven responsibility at a time](../../../decisions/oxc-toolchain-migration.md).

This report brings together all work completed during the investigation:

- the current Devkit and Frink lint/format/type-check architecture;
- the reason ESLint and Biome are currently split;
- a one-off timing and memory control for Devkit's current quality-gate commands;
- Oxlint native-rule and JavaScript-plugin compatibility;
- the measured `eslint-plugin-project-structure` experiment on Frink;
- Biome's actual custom-plugin capability and limitations;
- anti-slop portability and proposed Devkit installation model;
- Oxfmt's relevance to replacing Biome formatting;
- Oxlint's experimental replacement path for `tsc --noEmit`;
- Frink's existing structure-debt/baseline model;
- official upstream benchmark context; and
- the remaining decision-grade Frink benchmark protocol.

## Bottom line

The evidence supports an incremental migration toward Oxc, but not a blind tool swap:

| Question | Current answer |
| --- | --- |
| Can Oxlint run Frink's existing structure plugin? | Yes for JS/TS. Both real rule families produced matching targeted diagnostics. |
| Is the JS bridge automatically faster? | No. This filesystem-heavy plugin was 1.98x slower by wall time in one run, although measured maximum RSS was 47.3% lower. |
| Can Oxlint fully replace the current structure guard? | No. It cannot run `projectStructureParser`, so CSS, HTML, arbitrary-file, and empty-directory coverage needs a separate filesystem validator. The proposed `guard-topology` command does not exist yet. |
| Can Oxlint replace Frink's core ESLint rules? | Probably. `max-lines`, `max-lines-per-function`, and `no-restricted-imports` all have native Oxlint equivalents with the options Frink uses. They still need local diagnostic parity tests. |
| Can anti-slop join the same ruleset? | Yes. It is already an Oxlint JS plugin intended to be vendored and registered beside native rules. |
| Why not use Biome plugins for everything? | Biome plugins are GritQL structural patterns, not an ESLint-compatible JavaScript runtime, and multi-file patterns remain unsupported. They cannot faithfully host the current topology/import plugin or much of anti-slop. |
| Must Biome remain the formatter? | No. Oxfmt is now a credible candidate and supports migration from Biome, but it must be tested as a repository-wide formatting change. Formatter migration is not byte-lossless. |
| Can Oxlint replace `tsc --noEmit`? | It now exposes experimental `--type-check`, but Frink is on TypeScript 6.0.3 while the documented type-aware path requires TypeScript 7 compatibility. Treat this as a separate migration with diagnostic parity. |
| What currently dominates Devkit's measured command cost? | In the one-off control, `tsc --noEmit` had the highest median wall time (2.185 s) and RSS (443.1 MiB). No Oxc type-check candidate was measured, so this is a migration baseline rather than evidence of a speed-up. |
| How should roughly 13k anti-slop findings be adopted? | Use a Devkit-owned external, shrink-only baseline with per-rule `off`/`warn`/`error`; do not add thousands of inline suppressions. |

The likely end state is:

1. **Oxfmt** for formatting, if Frink output/idempotence checks pass.
2. **Oxlint native rules** for ordinary lint, size limits, and compatible import restrictions.
3. **Vendored anti-slop** in the same Oxlint config.
4. **A proposed standalone `guard-topology` command shipped by Devkit** for filesystem and
   cross-file rules that do not belong in a source-file parser.
5. **Oxlint/tsgolint type checking** only after TypeScript-version and diagnostic parity are proven.
6. Removal of ESLint and then Biome only when their last owned behavior has an equivalent.

## Evidence labels

Claims in this report have different strengths:

| Label | Meaning |
| --- | --- |
| **Measured locally** | Executed on disposable Devkit or Frink inputs described below; raw output was retained in `/tmp` for the session |
| **Inspected locally** | Derived from Devkit/Frink source, configuration, dependency, hook, or baseline files |
| **Upstream documented** | Reported by official Oxc, Biome, or anti-slop documentation; useful context but not Frink evidence |
| **Proposed** | A migration design or future benchmark requirement, not an implemented or measured result |

The current Devkit commands and the project-structure bridge have local timing/RSS measurements.
Biome versus Oxfmt, the complete native-lint ruleset, anti-slop, and `tsc` versus `--type-check`
remain intentionally listed as unmeasured rather than being filled with incomparable upstream
numbers.

## Measured local result: project-structure bridge

| Runner | Targeted project-structure findings | Wall time | User CPU | System CPU | Maximum RSS |
| --- | ---: | ---: | ---: | ---: | ---: |
| ESLint 10.5.0 | 3 | 17.55 s | 25.86 s | 2.71 s | 561,348,608 B / 535.3 MiB |
| Oxlint 1.78.0 JS plugin | 3 | 34.83 s | 23.97 s | 4.88 s | 296,026,112 B / 282.3 MiB |

Derived from this one sample:

- Oxlint emitted all three targeted findings with matching file, rule, and message.
- Oxlint maximum RSS was 47.3% lower for the measured process.
- Oxlint wall time was 1.98x ESLint's wall time.
- Oxlint user CPU was 7.3% lower, while system CPU was 80.1% higher.
- Oxlint retired 36.6% fewer instructions and used 15.7% fewer CPU cycles.

The time result must not be read as “Oxlint is slower than ESLint” generally. This lane exercises
an existing JavaScript plugin whose own filesystem traversal, glob matching, and cache behavior
remain JavaScript work. It does not measure Oxlint's native Rust rules. The limitations section
also explains why this is not yet an apples-to-apples timing comparison.

## One-off Devkit command control

This control records the cost of the tools Devkit already runs. It was collected to anchor the
migration study, not to create a permanent performance suite, dashboard subject, or release gate.
Future Oxc comparisons should be disposable migration experiments that repeat the relevant control
and candidate on the same pinned input.

### Protocol

| Item | Value |
| --- | --- |
| Source | Clean archive of Devkit commit `2a488a19412cb69a855c6eb926aa9485d638d5ec` |
| Host | Darwin 25.5.0, arm64, 10 logical CPUs |
| Runtime | Node 24.19.0; repository runtime floor Node 23.6.0 |
| Tools | Biome 2.5.6, ESLint 10.5.0, TypeScript 6.0.3 |
| Samples | 3 discarded warm-ups, then 10 measured runs per command/scope |
| Statistics | Median and nearest-rank p95; with 10 samples, p95 is the maximum |

Changed/staged lanes used a deterministic one-file patch. Full lanes used a fresh committed
fixture and fresh tool caches for each sample. Installed dependencies were shared but excluded from
timing. Biome and ESLint received explicit file manifests; TypeScript remained config-owned through
`tsc -p tsconfig.json`, so its 514-file manifest is context rather than its literal argv.

### Results

CPU is user plus system time for the timed command. RSS is `/usr/bin/time`'s maximum resident-set
measurement for that command, not a guaranteed aggregate of all simultaneously resident
descendants.

| Command and scope | Scope manifest | Diagnostics | Wall median / p95 | CPU median / p95 | RSS median / p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Biome lint · changed/staged | 1 | 0 | 0.168 s / 0.299 s | 0.060 s / 0.070 s | 46.4 / 46.6 MiB |
| Biome lint · full clean | 514 | 0 | 1.039 s / 8.283 s | 2.215 s / 3.130 s | 143.3 / 148.6 MiB |
| Biome format · changed/staged | 1 | 0 | 0.140 s / 0.191 s | 0.060 s / 0.070 s | 46.4 / 46.6 MiB |
| Biome format · full clean | 652 | 0 | 0.479 s / 0.732 s | 0.970 s / 0.990 s | 104.6 / 105.9 MiB |
| ESLint structure · changed/staged | 1 | 0 | 0.335 s / 0.556 s | 0.285 s / 0.350 s | 87.7 / 90.1 MiB |
| ESLint structure · full clean | 514 | 0 | 0.654 s / 0.816 s | 0.780 s / 0.880 s | 193.4 / 201.0 MiB |
| TypeScript no-emit · full clean | 514 | 0 | 2.185 s / 2.477 s | 4.470 s / 4.630 s | 443.1 / 461.7 MiB |

The control shows where the current Devkit process spends time and memory, but not what Oxc will
save. Host load was uncontrolled, the full Biome lint p95 contains a visible wall-time outlier, and
the lanes are not necessarily one serial pre-commit path. The useful conclusions are therefore
directional: type checking is the largest measured standalone target, and changed-file structure
lint costs more than the equivalent changed-file Biome lane. Candidate measurements must preserve
diagnostic and scope parity before comparing speed.

## Current toolchain audit

### Devkit

Devkit currently has four separate concerns:

| Concern | Current owner | Local evidence |
| --- | --- | --- |
| Ordinary lint | Biome | [`package.json`](../../../../package.json) runs `biome check .` |
| Formatting | Biome | The `format` script runs `biome check --write .` |
| Folder topology | ESLint plus `eslint-plugin-project-structure` | [`eslint.config.mjs`](../../../../eslint.config.mjs) delegates to the structure compiler |
| Type checking/build | TypeScript | `typecheck` and `build` invoke `tsc` |

Devkit's universal structure design is already mostly runner-independent at the policy layer:

- [`guard.config.json`](../../../../guard.config.json) declares scan roots, tree grammar, line caps,
  and future walls.
- [`buildStructureConfigs`](../../../../gate-engine/structure/eslint-config.mts) is the one seam that
  turns that policy into ESLint entries.
- [`runStructureGate`](../../../../gate-engine/structure/run.mts) invokes ESLint from Devkit's own
  dependency installation so consumers do not need to install ESLint themselves.
- raw file-size and fan-out checks already live in Devkit ratchet gates; per-function size is the
  remaining parser-dependent size rule.

This matters because removing ESLint does not require redesigning the policy format. It requires
replacing the final compiler/runner seam and preserving its baseline semantics.

#### Existing versus proposed structure commands

The current command is not a standalone topology engine:

```text
guard-structure
  -> Devkit orchestration
  -> ESLint
  -> eslint-plugin-project-structure
```

This report proposes—but has not implemented or benchmarked—a separate command:

```text
guard-topology
  -> Node/Bun filesystem walk
  -> guard.config.json structure policy
  -> direct folder/file/sibling diagnostics
  -> no ESLint, Biome, or source parser
```

“Standalone” means runner-independent code shipped by the Devkit package, similar in shape to its
existing direct size and fan-out scripts. It does not mean Rust-native, Oxlint-native, or an
existing third-party tool. Any CPU advantage remains a hypothesis until measured.

### Frink

Frink's package scripts currently say:

```text
lint          = biome check . && bun run lint:structure
lint:structure = eslint src socket-server vercel-serverless
lint:fix      = biome check --write .
format        = biome format --write .
ts:check      = tsc --noEmit
```

Installed versions at the time of inspection included:

| Package | Version/range |
| --- | --- |
| Biome | installed 2.5.1 |
| ESLint | 10.5.0 |
| `eslint-plugin-project-structure` | 3.14.3 |
| `@typescript-eslint/parser` | 8.62.0 range |
| TypeScript | installed 6.0.3 |
| Devkit | pinned to 0.51.0 in the inspected checkout |

Frink's 779-line `eslint.config.mjs` still contains the older Electron preset rather than the
fully collapsed universal Devkit structure config. It owns:

- six folder-placement trees;
- renderer/shared import walls through `independent-modules`;
- the renderer Node-builtin ban through core `no-restricted-imports`;
- `max-lines` and `max-lines-per-function`; and
- stub rule registrations that keep legacy inline disables valid.

Biome owns ordinary code/style lint and formatting. That split is stated directly in Frink's
config comments and was deliberate.

### Duplicate pre-commit work in Frink

The current hook makes measured command timings alone understate the user-facing opportunity:

1. `guard-deterministic` invokes a full `src` ESLint structure command.
2. Later in the same hook, staged `src`, `socket-server`, and `vercel-serverless` files are passed
   through ESLint again.
3. Devkit size/fan-out gates run in the deterministic aggregate, while older local size/fan-out
   ratchets run later for staged source.

A migration should remove this duplicate orchestration even if no lint engine changes. Otherwise
the hook can pay twice for the same parser/plugin work.

## Existing Frink structure debt

Frink already demonstrates the baseline behavior anti-slop needs. A read-only snapshot of the
generated baselines on 2026-08-15 contained:

| Baseline | Existing debt entries |
| --- | ---: |
| Renderer folder structure | 534 |
| Main folder structure | 243 |
| Shared folder structure | 3 |
| Preload folder structure | 0 |
| Socket server folder structure | 31 |
| Vercel folder structure | 25 |
| Renderer import walls | 129 |
| Size-disable ratchet | 183 |
| Raw-line ratchet | 115 |
| Folder fan-out directories | 26 |

The baseline README already defines the right migration semantics: generated debt is shrink-only,
permanent exemptions are distinct and reasoned, and a rule can be introduced without rewriting the
repository immediately. Anti-slop should reuse this model at a diagnostic-fingerprint level.

The “roughly 13,000 anti-slop findings” figure is the user's observed estimate, not a result from
this experiment. It should be captured by a dedicated baseline run rather than repeated as a
measured number.

## Why ESLint was used instead of Biome

The original choice was reasonable and the decisive limitation still exists.

Biome 2.x “custom plugins” are `.grit` files evaluated as GritQL structural patterns. They can:

- match JavaScript/TypeScript, CSS, and JSON syntax;
- register diagnostics;
- provide safe or unsafe rewrites; and
- restrict a pattern to configured file globs.

They are **not** JavaScript modules implementing the ESLint rule API. Biome's separate JavaScript
plugin runtime remains an open implementation effort. GritQL support is described as actively
evolving, and the upstream feature tracker still marks multi-file pattern handling unsupported:
[Biome plugin documentation](https://biomejs.dev/linter/plugins/),
[GritQL status](https://biomejs.dev/reference/gritql/#integration-status),
[JavaScript runtime issue](https://github.com/biomejs/biome/issues/2469), and
[Grit bindings status](https://github.com/biomejs/biome/issues/2582).

| Custom-plugin capability | Biome GritQL today |
| --- | --- |
| ESLint-compatible JavaScript API | No |
| CST/syntax matching | Yes |
| Fixes | Yes, through Grit rewrites |
| Per-plugin file globs | Yes, through `includes` |
| Current-file path metadata | Yes in current releases; historical `$filename` bug is closed |
| Cross-file/multi-file patterns | No |
| Semantic JS scope/symbol API | Not exposed to Grit plugins |
| TypeScript checker/type-inference API | Not exposed to Grit plugins |
| ESLint-style rule options | No |
| Consumer-selected plugin severity | No equivalent; severity is registered by the plugin |
| Custom parser/language registration | No; target languages are Biome-owned |
| External migration baseline | No native facility |
| Stable npm JavaScript-plugin distribution | Not yet; the JS runtime remains open work |

Biome's public Grit plugin surface also does not expose the ESLint-style semantic scope manager,
comments API, rule options, or TypeScript checker context used by sophisticated rules. Severity is
authored in `register_diagnostic()` rather than configured per rule in the ESLint/Oxlint style.

This is a capability conclusion, not a claim that Grit plugins are inherently slow. Biome 2.4.5
batched all plugins into one syntax visitor with a kind-to-plugin lookup, reducing per-node plugin
dispatch from O(number of plugins) to O(1). No comparable Frink implementation exists because a
faithful port is blocked before performance becomes the deciding question:
[Biome 2.4.5 changelog](https://biomejs.dev/internals/changelog/version/2-4-5/).

Some wording in Frink's historical comment is now partly stale: modern Grit integration can reason
about the current file and scope a plugin with globs. The historical `$filename` bug is recorded at
[Biome issue 6670](https://github.com/biomejs/biome/issues/6670). That still does not provide a
filesystem tree, required siblings, empty-directory visibility, arbitrary file formats, or
cross-file module policy. Biome therefore remains unable to host Devkit's structure guard
faithfully.

## Tool capability comparison

| Capability | ESLint 10 | Biome 2.5 | Oxc tools as of 2026-08 | Proposed standalone validator |
| --- | --- | --- | --- | --- |
| JS/TS native lint | Mature but JS-based | Yes | Yes, Rust-native | Not its purpose |
| Formatting | Separate tool required | Yes | Oxfmt | Not its purpose |
| Existing ESLint JS plugins | Native/stable | No | Mostly compatible, alpha | Could wrap only by invoking a linter |
| Grit structural plugins | No | Yes | No | No |
| Cross-file module graph | Plugin-built | Grit `multifile` unsupported | Native multi-file analysis exists | Can own explicit project policy |
| Custom parser/file format | Yes | Only Biome-owned target languages | No for JS plugins | Yes through filesystem walking |
| Folder/filename topology | Current plugin | Partial per-file approximation | JS/TS bridge only | Best durable owner |
| Empty/asset-only directories | Current plugin filesystem work | No | Not through source lint | Yes |
| TypeScript compiler diagnostics | Separate `tsc` | No compiler replacement | Experimental `--type-check` via tsgolint | Not its purpose |
| External debt baseline | Devkit layer | Devkit layer | Devkit layer | Natural owner |
| Per-rule `off`/`warn`/`error` | Yes | Native rules yes; Grit severity authored in plugin | Yes | Should expose equivalent policy |

## Oxlint compatibility beyond the measured plugin

The local Frink config and official rule references show three strong native migrations:

| Current Frink rule | Oxlint status | Relevant option parity | Assessment |
| --- | --- | --- | --- |
| `max-lines` | Native | `max`, `skipBlankLines`, `skipComments` | Strong candidate |
| `max-lines-per-function` | Native | `max`, `skipBlankLines`, `skipComments`, `IIFEs` | Strong candidate |
| `no-restricted-imports` | Native | `patterns.group`, custom `message`, path/import-name controls | Strong candidate; Frink uses glob groups rather than incompatible JS regex features |
| `project-structure/independent-modules` | JS bridge | Tested with Frink's real rule options | Compatible short-term, but not a demonstrated speed win |
| `project-structure/folder-structure` | JS bridge | Tested on TS probes | Compatible only for files Oxlint parses |
| `projectStructureParser` | Unsupported | None | Cannot migrate |
| raw-line/fan-out ratchets | Already outside ESLint | Not applicable | Keep in Devkit |

Official rule references:
[max-lines](https://oxc.rs/docs/guide/usage/linter/rules/eslint/max-lines),
[max-lines-per-function](https://oxc.rs/docs/guide/usage/linter/rules/eslint/max-lines-per-function),
and [no-restricted-imports](https://oxc.rs/docs/guide/usage/linter/rules/eslint/no-restricted-imports).

The native-rule conclusion is a compatibility audit, not yet measured Frink diagnostic parity.
Each current ESLint option set still needs a fixture comparison before the rule is removed from
ESLint.

## Anti-slop research

Anti-slop is already designed for the candidate architecture. Its repository explicitly says it is
meant to be vendored, copied into the consumer, adapted to team standards, and registered as an
Oxlint JS plugin: [anti-slop](https://github.com/dmmulroy/anti-slop).

The current preset contains 15 rules:

```text
no-chained-type-assertions
no-conditional-empty-object-spread
no-known-value-widening
no-module-mocking
no-object-parameters
no-reflect-apply
no-reflect-get
no-runtime-typeof
no-shape-in-symbol-names
no-unknown-parameters
no-unknown-returns
no-unknown-type-aliases
no-unsafe-dictionary-type
no-widen-then-assert
require-safety-comment-for-type-assertion
```

### Why Biome is not a faithful anti-slop host

A few rules could be approximated as syntax patterns, including chained assertions, conditional
empty-object spreads, `shape` in symbol names, and some direct `unknown`/`typeof` cases.

The important remainder relies on some combination of lexical scope, shadow/alias detection,
comments, options, or local data flow: known-value widening, module mocks, object parameters,
`Reflect` calls, unknown returns/aliases, unsafe dictionary types, widen-then-assert, and required
safety comments. Grit approximations would create false positives and false negatives.

Oxlint's JavaScript API supplies AST traversal, `SourceCode`, scope analysis, code paths, comments,
fixes, and rule options. Anti-slop does not require the TypeScript checker; its requirements are
file-local ESTree plus semantic scope/comment facilities, which makes the Oxlint bridge the natural
home. Oxlint also offers `eslintCompatPlugin`/`createOnce`, allowing a plugin to remain usable from
both ESLint and Oxlint while using a lower-overhead Oxlint lifecycle:
[writing Oxlint JS plugins](https://oxc.rs/docs/guide/usage/linter/writing-js-plugins.html).

### Installable-like-Fallow model

The recommended Devkit shape is:

1. vendor a reviewed anti-slop snapshot into Devkit;
2. record the upstream revision and local changes;
3. offer `devkit init`/upgrade installation similarly to Fallow;
4. install matching `oxlint` and `@oxlint/plugins` from Devkit's runtime so consumers do not need
   to coordinate versions manually;
5. generate or merge one consumer Oxlint config without overwriting consumer-authored rules;
6. expose presets plus per-rule overrides in `guard.config.json` or a dedicated lint policy block;
7. keep the baseline and baseline CLI in Devkit rather than anti-slop itself; and
8. make upgrades diff the vendored rules so local policy adaptations remain visible.

## Combining native, anti-slop, and compatibility rules

Oxlint can combine native rules and multiple JavaScript plugins in one config. A transitional
configuration can look like:

```ts
import { defineConfig } from 'oxlint';

export default defineConfig({
  jsPlugins: [
    {
      name: 'anti-slop',
      specifier: './tools/oxlint/anti-slop/index.ts',
    },
    {
      name: 'project-structure',
      specifier: './tools/oxlint/project-structure-adapter.mjs',
    },
  ],
  rules: {
    'max-lines': ['error', { max: 500 }],
    'max-lines-per-function': ['error', { max: 200, IIFEs: true }],
    'no-restricted-imports': ['error', { patterns: [] }],

    'anti-slop/no-chained-type-assertions': 'error',
    'anti-slop/no-module-mocking': 'off',
    'anti-slop/no-unknown-returns': 'warn',

    'project-structure/independent-modules': 'error',
  },
  overrides: [
    {
      files: ['**/*.tsx'],
      rules: {
        'max-lines-per-function': ['error', { max: 300, IIFEs: true }],
      },
    },
  ],
});
```

The empty restricted-import options above are illustrative; migration must copy Frink's actual
groups and messages. The folder rule is intentionally absent from this target sketch because it
would move to the proposed standalone topology validator rather than remain as a partial JS-only
rule.

## What “our ESLint plugins” means here

Devkit does not currently implement several independent ESLint plugins for topology. It owns the
configuration and runner, then delegates the actual rules to the external
`eslint-plugin-project-structure` package:

- [`buildStructureConfigs`](../../../../gate-engine/structure/eslint-config.mts) imports
  `createFolderStructure`, `projectStructureParser`, and `projectStructurePlugin`, then compiles
  `guard.config.json` trees into ESLint flat-config entries.
- [`runStructureGate`](../../../../gate-engine/structure/run.mts) invokes the bundled ESLint runtime
  against those generated entries.
- Frink's older Electron ESLint configuration also invokes the plugin's `independent-modules` rule
  for import walls.

The compatibility experiment therefore tested the real third-party rule implementations and
Frink's real rule options, rather than a simplified reimplementation.

## Measured plugin compatibility matrix

| Existing mechanism | Oxlint result | Migration implication |
| --- | --- | --- |
| `project-structure/folder-structure` on JS/TS | Works through the JS-plugin bridge | Viable compatibility path for parseable source files |
| `project-structure/independent-modules` | Works through the JS-plugin bridge | Viable short-term import-wall path |
| `projectStructureParser` | Unsupported | CSS, HTML, arbitrary assets, and empty-directory checks need another runner |
| Plugin package export shape | Needs a small adapter | Package exposes `projectStructurePlugin` as a named export rather than the default plugin object Oxlint expects |
| Symlinked consumer runtime | Needs preserved symlinks | Otherwise the plugin can derive the wrong project root and silently inspect the live checkout |
| `projectStructure.cache.json` | Still written by the plugin | Benchmarks must isolate and clear the disposable cache between runs |

Oxlint documents its ESLint v9-compatible JavaScript-plugin API as alpha. It supports AST traversal,
rule options, `SourceCode`, scopes, code paths, and fixes, but explicitly excludes custom parsers and
custom file formats: [Oxlint JS plugins](https://oxc.rs/docs/guide/usage/linter/js-plugins.html).

## Test environment

| Item | Value |
| --- | --- |
| Date | 2026-08-15, Europe/London |
| Host | Apple M4, 24 GiB RAM |
| OS | macOS / Darwin 25.5.0, arm64 |
| Node.js | 22.20.0 |
| Bun | 1.3.1 |
| ESLint | 10.5.0 |
| Oxlint | 1.78.0 |
| `eslint-plugin-project-structure` | 3.14.3 |
| Frink checkout base commit | `3ed3252d2fba3ceb393e7c0a39854d5951c3b583` |
| Scratch checkout | `/tmp/frink-oxc-plugin.5Kgtmp/repo` |

The scratch copy was made from the Frink **working tree**, not from `git archive`. The commit above
identifies the checkout's base but is not a content hash for the complete benchmark input if the
source worktree contained uncommitted changes. This is one reason the result is exploratory.

## Isolation and safety

The project-structure package writes `projectStructure.cache.json`, and repeated identical
violations can be suppressed by that cache. Running directly in Frink would therefore mutate the
checkout and could make later runs appear clean.

The experiment instead:

1. created a disposable `/tmp` directory;
2. mirrored Frink while excluding `.git`, `node_modules`, and build outputs;
3. symlinked the existing Frink `node_modules` into the mirror;
4. added benchmark-only configs and deliberate invalid probes to the mirror;
5. removed only the disposable project-structure cache between parity runs; and
6. left both Devkit and Frink project files unchanged.

An equivalent setup is:

```bash
FRINK_SOURCE='/path/to/frink'
BENCH_ROOT="$(mktemp -d /tmp/frink-oxc-plugin.XXXXXX)"
BENCH_REPO="$BENCH_ROOT/repo"

mkdir -p "$BENCH_REPO" "$BENCH_ROOT/tools" "$BENCH_ROOT/results"
rsync -a \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='out' \
  --exclude='dist' \
  --exclude='release' \
  --exclude='cloned-projects' \
  "$FRINK_SOURCE/" "$BENCH_REPO/"
ln -s "$FRINK_SOURCE/node_modules" "$BENCH_REPO/node_modules"

npm install --prefix "$BENCH_ROOT/tools" \
  --no-save --ignore-scripts oxlint@1.78.0
```

## Configuration translation

### ESLint control

The control retained only global ignore entries and entries containing a
`project-structure/*` rule from Frink's existing flat config:

```js
import config from './eslint.config.mjs';

export default config.filter(
  (entry) =>
    (entry.ignores && !entry.rules) ||
    Object.keys(entry.rules ?? {}).some((rule) =>
      rule.startsWith('project-structure/'),
    ),
);
```

This preserved the original rule objects and options. It intentionally did not load Frink's core
size and restricted-import rules because this experiment was about JavaScript-plugin compatibility.

### Oxlint adapter

The package exposes the plugin as a named export. Oxlint needs a module that default-exports the
plugin object:

```js
import { projectStructurePlugin } from 'eslint-plugin-project-structure';

export default projectStructurePlugin;
```

The actual scratch adapter also contained unused diagnostic wrappers added while investigating
project-root behavior. Only the original `folder-structure` and `independent-modules` rules were
enabled in the measured run.

### Oxlint config

The Oxlint config imported the same Frink config, retained the same file globs and rule options,
translated ESLint `ignores` to Oxlint `excludeFiles`, and registered the adapter once:

```js
import eslintConfig from './eslint.config.mjs';

const projectStructureOverrides = eslintConfig
  .filter((entry) =>
    Object.keys(entry.rules ?? {}).some((rule) =>
      rule.startsWith('project-structure/'),
    ),
  )
  .map((entry) => ({
    files: entry.files,
    excludeFiles: entry.ignores,
    rules: Object.fromEntries(
      Object.entries(entry.rules).filter(([rule]) =>
        rule.startsWith('project-structure/'),
      ),
    ),
  }));

export default {
  ignorePatterns: ['**/dist/**', '**/out/**', '**/*.tsbuildinfo'],
  jsPlugins: [
    {
      name: 'project-structure',
      specifier: './oxlint-project-structure-adapter.mjs',
    },
  ],
  overrides: projectStructureOverrides,
};
```

Oxlint's config reference documents `jsPlugins`, override `files`, and override `excludeFiles`:
[Oxlint config reference](https://oxc.rs/docs/guide/usage/linter/config-file-reference.html).

## Deliberate probes

Three invalid JS/TS conditions were seeded in the disposable mirror.

### Invalid renderer directory

Path:

```text
src/renderer/definitely-invalid-folder/BadName.ts
```

Contents:

```ts
export const invalidStructureProbe = true;
```

Expected rule: `project-structure/folder-structure`.

### Invalid filename within `renderer/lib`

Path:

```text
src/renderer/lib/oxlint-import-wall-probe.ts
```

The Frink topology permits domain folders at this level rather than a loose implementation file.
Expected rule: `project-structure/folder-structure`.

### Renderer-to-main import wall

The same loose-file probe contained:

```ts
import '../../main/index';

export const oxlintImportWallProbe = true;
```

Expected rule: `project-structure/independent-modules`.

### CSS-only invalid directory

Path:

```text
src/renderer/css-only-invalid/bad.css
```

Contents:

```css
.css-only-invalid-probe {
  display: block;
}
```

This probe isolated the custom-parser compatibility boundary.

## Effective run commands

The recorded runs used the following command shape from the scratch repository. The transient npm
cache location of the Oxlint executable is replaced below with a stable tools-directory path.

```bash
cd "$BENCH_REPO"

rm -f projectStructure.cache.json
/usr/bin/time -lp \
  node --preserve-symlinks node_modules/eslint/bin/eslint.js \
  --config eslint-project-structure.bench.config.mjs \
  --format json \
  . \
  >"$BENCH_ROOT/results/eslint-project-structure.json" \
  2>"$BENCH_ROOT/results/eslint-project-structure.time"

rm -f projectStructure.cache.json
/usr/bin/time -lp \
  node --preserve-symlinks \
  "$BENCH_ROOT/tools/node_modules/oxlint/bin/oxlint" \
  --config oxlint-project-structure.bench.config.mjs \
  --disable-nested-config \
  -A all \
  --format json \
  . \
  >"$BENCH_ROOT/results/oxlint-project-structure.json" \
  2>"$BENCH_ROOT/results/oxlint-project-structure.time"
```

Both tools exit non-zero when the deliberate errors are present. A repeatable harness should
explicitly accept exit status 1 while treating any other status as an infrastructure failure.

`-A all` disabled Oxlint's native default categories so the measurement included only the two
configured JavaScript-plugin rules.

## Diagnostic results

The targeted diagnostic set was identical:

| File | ESLint rule | Oxlint code | First message line |
| --- | --- | --- | --- |
| `src/renderer/definitely-invalid-folder/BadName.ts` | `project-structure/folder-structure` | `project-structure(folder-structure)` | `Folder 'definitely-invalid-folder' is invalid.` |
| `src/renderer/lib/oxlint-import-wall-probe.ts` | `project-structure/folder-structure` | `project-structure(folder-structure)` | `File 'oxlint-import-wall-probe.ts' is invalid.` |
| `src/renderer/lib/oxlint-import-wall-probe.ts` | `project-structure/independent-modules` | `project-structure(independent-modules)` | Frink's full renderer import-wall message |

The full messages, including allowed names and error locations, matched. Oxlint formats the rule
identifier with parentheses while ESLint uses a slash; that is a formatter-level representation
difference, not a rule-result difference.

ESLint enumerated 2,825 files. Its output contained 159 messages in total:

- 3 target `project-structure/*` diagnostics; and
- 156 unrelated messages caused mostly by existing `eslint-disable` comments naming rules that
  were deliberately absent from the reduced benchmark config.

Oxlint emitted only the three configured rule diagnostics. Targeted parity is therefore exact, but
the total output sets are not identical. The extra ESLint directive processing is a benchmark
confounder and must be removed from the next measured protocol.

Useful parity extraction for the ESLint output:

```bash
jq '[
  .[]
  | .filePath as $file
  | .messages[]
  | select(.ruleId != null and (.ruleId | startswith("project-structure/")))
  | { file: $file, ruleId, message, line, column }
]' "$BENCH_ROOT/results/eslint-project-structure.json"
```

## Raw timing data

### ESLint

```text
real 17.55
user 25.86
sys 2.71
561348608 maximum resident set size
45301 page reclaims
119 page faults
5632 voluntary context switches
187117 involuntary context switches
348029566159 instructions retired
106736260077 cycles elapsed
586521344 peak memory footprint
```

### Oxlint JS plugin

```text
real 34.83
user 23.97
sys 4.88
296026112 maximum resident set size
80235 page reclaims
406 page faults
4387 voluntary context switches
196397 involuntary context switches
220668720359 instructions retired
89988728981 cycles elapsed
379099656 peak memory footprint
```

## CSS/custom-parser result

ESLint's synthetic `projectStructureParser` accepted the CSS probe and the folder rule reported the
invalid directory. Oxlint selected no lintable files for the CSS-only path and exited with:

```text
No files found to lint
```

This is expected from Oxlint's documented lack of custom parser and custom file-format support. It
means a direct migration would silently lose some topology coverage. The current Frink placement
configuration reaches five CSS files and two root renderer HTML files through the synthetic parser;
directory-only and asset-only states can present the same problem.

## The preserved-symlink trap

The first Oxlint attempts produced false negatives. The rule API itself was working, but the
project-structure package derived its project root from a module path under `node_modules`.

Because the disposable mirror symlinked Frink's `node_modules`, normal Node resolution dereferenced
the symlink and led the plugin back to the live Frink checkout. The deliberate mirror-only probes
then appeared to be outside the project.

Running the Oxlint JavaScript entry point with Node's `--preserve-symlinks` kept module resolution in
the mirror and restored all expected diagnostics. Devkit's current ESLint structure runner already
preserves symlinks for the same class of consumer-runtime issue.

Any temporary Oxlint bridge must preserve that behavior. A durable replacement should take the
consumer project root explicitly and must not infer it from the plugin package's installation path.

## Interpretation

### What the experiment proves

- Oxlint's JavaScript-plugin bridge implements enough of the ESLint v9 API for both actual
  project-structure rules on JS/TS.
- Frink's real rule options survive the config translation.
- Both `context.filename`/working-directory behavior and import-node traversal are sufficient once
  symlink resolution is correct.
- The bridge can materially reduce the measured main-process RSS for this workload.

### What it does not prove

- It does not prove that a full Oxlint migration is slower. Native Oxlint rules were disabled.
- It does not prove that peak process-tree memory is 47.3% lower. `/usr/bin/time` measured the
  launched process; a future run should also sample the complete process tree because JS-plugin
  workers may be children.
- It does not prove stable performance. There was one measured run per tool, with no alternated
  order, warm-up policy, confidence interval, or noise-floor run.
- It does not establish total diagnostic parity because the reduced ESLint config emitted 156
  unrelated inline-directive messages.
- It does not cover Biome's current native lint rules, Oxfmt, anti-slop, or type checking.
- It does not provide immutable Frink input provenance because the mirror came from a working tree.

The defensible reading is: **the JS compatibility bridge works, uses less measured resident memory,
but offers no demonstrated latency win for this filesystem-heavy plugin.**

## Upstream benchmark context

Upstream measurements explain why Oxlint remains worth benchmarking even though the local bridge
sample was slower. These are vendor-published results on other repositories, not substitutes for
Frink data:

| Source/workload | Published result | Relevance to Frink |
| --- | --- | --- |
| Oxc native linter benchmark | Oxlint 615.3 ms multi-threaded / 1.840 s single-threaded versus ESLint 33.481 s | Demonstrates native-engine potential, not plugin parity |
| Node.js migration: 6,298 files, 104 native rules, 75 plugin rules, 23 custom rules, M4 host | ESLint 1m43s versus Oxlint 21s, a 4.8x speed-up | More representative of a mixed native/JS-plugin migration than a native-only claim |
| Vue core preview with a simple custom JS plugin | ESLint 4,116 ms versus Oxlint with plugin 236 ms | Shows bridge overhead can still beat ESLint when plugin work is modest |
| Oxfmt formatter benchmark | Oxc currently reports roughly 3x Biome and 35x Prettier | Justifies a Frink formatting lane; says nothing about Frink output parity |

Sources: [Oxc benchmark index](https://oxc.rs/docs/guide/benchmarks),
[Oxlint JS-plugin alpha benchmark](https://oxc.rs/blog/2026-03-11-oxlint-js-plugins-alpha),
and [Oxlint JS-plugin preview](https://oxc.rs/blog/2025-10-09-oxlint-js-plugins.html).

The plugin-alpha write-up also states the key caveat observed here: Oxlint can make parsing and API
transfer fast, but it cannot make an inefficient JavaScript algorithm or filesystem-heavy plugin
fast. `eslint-plugin-project-structure` performs its own path traversal, glob work, root discovery,
and cache I/O, so it is exactly the kind of plugin where native Oxlint headline numbers may not
carry through.

## Migration recommendation

Do not make the JavaScript-plugin bridge the final architecture for all structure enforcement.

1. Remove Frink's duplicate pre-commit ESLint and ratchet invocations so the control pipeline is
   measured once.
2. Add Oxlint in shadow/advisory mode and migrate ordinary AST rules with native equivalents,
   including size and restricted-import rules after diagnostic parity tests.
3. Vendor anti-slop into the same Oxlint configuration, with every rule individually configurable
   and the current findings captured by an explicit external baseline.
4. Use `project-structure/independent-modules` through the bridge only as a short-term compatibility
   step, or compile the same import-wall policy to native Oxlint rules where semantics match.
5. If a direct filesystem benchmark supports it, implement the proposed standalone
   `guard-topology` command, driven by `guard.config.json`, to replace `folder-structure`. It must
   cover JS/TS, CSS, HTML, arbitrary assets, required siblings, and empty directories without a
   fake parser.
6. Benchmark Oxfmt independently and move formatting only if config migration, output review,
   idempotence, and post-format validation pass.
7. Treat Oxlint type checking as a later TypeScript-7 migration, keeping `tsc --noEmit` until exact
   compiler-diagnostic parity is established.
8. Remove ESLint when topology/import/size parity is complete; remove Biome when both its lint and
   formatter responsibilities have passed their own parity gates.

This preserves Devkit's long-term direction: `guard.config.json` owns policy, while a specific lint
engine is an implementation detail.

## Baseline and rule-control requirements

The user-reported roughly 13,000 anti-slop findings should be adopted as debt, not converted into
thousands of inline suppressions.

A Devkit integration should provide:

- `off`, `warn`, and `error` per rule in consumer configuration;
- named presets such as `recommended`, plus explicit per-rule overrides;
- a `baseline` command that records existing findings as stable fingerprints;
- default failure only for findings absent from the baseline;
- a shrink-only check so resolved findings cannot silently return;
- `baseline --prune` to remove fingerprints whose violations no longer exist;
- file/rule/message/location normalization that is independent of ESLint versus Oxlint output
  formatting; and
- a visible summary of new, baseline, resolved, and disabled findings by rule.

A suitable fingerprint starts with:

```text
rule ID + repository-relative file + normalized message + stable source span/context hash
```

Line number alone is too fragile because unrelated edits move findings. Inline disable comments
should remain available for genuine exceptions, but not serve as the migration baseline.

A proposed consumer-facing policy shape is:

```jsonc
{
  "lint": {
    "presets": ["anti-slop/recommended"],
    "rules": {
      "anti-slop/no-module-mocking": "off",
      "anti-slop/no-unknown-returns": "warn",
      "anti-slop/no-widen-then-assert": "error"
    },
    "baseline": {
      "mode": "new-only",
      "path": ".devkit/lint-baseline.json"
    }
  }
}
```

Proposed commands should distinguish recording from maintenance:

```text
devkit lint baseline create   # explicitly adopt current debt
devkit lint baseline check    # fail on new findings / report resolved debt
devkit lint baseline prune    # remove fingerprints that no longer occur
devkit lint rules             # list effective preset + overrides
```

Baseline creation should never happen implicitly after a failed gate; otherwise a new violation can
be silently adopted as “existing” debt.

## Oxfmt versus Biome formatting research

There is no architectural reason to keep formatting in Biome if Oxfmt satisfies Frink's file and
configuration requirements. “Biome is only the formatter” is therefore a reason to benchmark its
replacement, not a reason to retain it indefinitely.

Current Oxfmt documentation reports:

- `oxfmt --migrate biome` can translate a Biome formatter configuration;
- JavaScript, JSX, TypeScript, TSX, JSON variants, CSS variants, GraphQL, and TOML are formatted
  natively;
- HTML, Vue, Svelte, Markdown/MDX, YAML, and several other formats are currently handled through a
  bundled Prettier path;
- JavaScript/TypeScript output passes the project's Prettier conformance suite; and
- upstream throughput is materially higher than Biome in Oxc's benchmark corpus.

Sources: [Oxfmt overview](https://oxc.rs/docs/guide/usage/formatter),
[CLI](https://oxc.rs/docs/guide/usage/formatter/cli.html),
[Biome migration support](https://oxc.rs/docs/guide/usage/formatter/cli.html), and
[language support](https://oxc.rs/docs/guide/usage/formatter/language-support).

“Lossless” needs two separate answers:

- **Byte-lossless:** no. Changing formatters can change whitespace, line wrapping, quote choices,
  import ordering, comments, and therefore Git blame across the repository.
- **Program-semantics preserving:** expected, and formatting differences that alter JavaScript or
  TypeScript semantics would be bugs. That expectation still needs repository-specific tests for
  comments, embedded languages, generated files, and ignored paths.

The Frink benchmark should run in a mirror and never begin with `--write` on the live checkout:

1. generate an Oxfmt config with `--migrate biome`;
2. compare `biome format --check` with `oxfmt --check` for wall/CPU/RSS;
3. separately format two identical mirrors;
4. inventory changed files and classify representative diffs by language;
5. run Oxfmt a second time to prove idempotence;
6. run Frink tests/type checks after formatting; and
7. decide whether a one-time formatting commit is acceptable.

Until that is run, the report does not claim Oxfmt is faster on Frink or output-equivalent to
Biome. The official benchmark is motivation, not local evidence.

## Oxlint versus `tsc --noEmit` research

Oxlint 1.78.0 now exposes two related but distinct modes:

- `--type-aware` enables lint rules that need TypeScript type information;
- `--type-check` adds TypeScript compiler diagnostics and is documented as capable of replacing a
  separate `tsc --noEmit` CI step.

The implementation is `oxlint-tsgolint`: Oxlint handles traversal/config/native reporting, while a
Go port of the TypeScript compiler builds programs and returns type-aware diagnostics. The package
must be installed separately. The mode remains explicitly experimental:
[Oxlint type-aware linting](https://oxc.rs/docs/guide/usage/linter/type-aware.html).

There is an immediate compatibility gate for Frink:

| Item | Current state |
| --- | --- |
| Frink installed TypeScript | 6.0.3 |
| Oxlint documented compatibility | TypeScript 7.0+ semantics required |
| Frink root type-check scope | `src/**/*`, through root `tsconfig.json` extending Devkit's base |
| Other TypeScript projects | Separate socket-server and Vercel configs, plus other tooling subprojects |
| Frink path alias | `@/*` to `src/renderer/*` |

The root `ts:check` command currently checks the root `src` project; it does not automatically make
the independently configured backend projects part of the same comparison. A fair first lane must
match exactly what `tsc --noEmit` checks today. A second “complete repo” lane can deliberately add
the server projects.

Replacement criteria should be stricter than lint-rule parity:

1. migrate or prove compatibility with the TypeScript 7/tsgo config semantics;
2. normalize and compare every diagnostic code, file, span, and message;
3. include clean, known-error, project-boundary, path-alias, declaration, and incremental fixtures;
4. compare cold/warm wall time and full process-tree RSS;
5. verify editor versus CI behavior; and
6. retain `tsc` until the candidate catches the same intentionally seeded errors.

So the answer is **yes, Oxc now has a potential `tsc --noEmit` replacement; no, Frink should not
switch to it solely from the current documentation or headline performance.**

## Complete Frink benchmark matrix

The next full Frink benchmark should use independent lanes rather than collapsing tools with
different responsibilities into one number:

| Lane | Control | Candidate | Required correctness check |
| --- | --- | --- | --- |
| Formatting | `biome format --check` | `oxfmt --check` | Classified repository-wide output diff and idempotence |
| Native lint | Current Biome/native ESLint rules | Native Oxlint equivalents | Normalized diagnostic parity |
| Custom lint | ESLint project-structure | Oxlint bridge/native wall compiler | Rule/file/message parity plus non-JS fixtures |
| Anti-slop | No current control | Oxlint JS plugin | Baseline determinism and new-only enforcement |
| Type checking: current scope | `tsc --noEmit` | `oxlint --type-aware --type-check` | Exact root-project TypeScript diagnostic parity |
| Type checking: expanded | Each explicit project config | Candidate per-project discovery | Diagnostic parity across root, socket, and Vercel projects |

Each lane should report cold and warm wall time, user/system CPU, complete process-tree peak RSS,
files processed, diagnostic counts, and tool versions.

## Decision-grade rerun protocol

Before using performance to choose an architecture:

1. create the input from a clean, pinned Frink tree;
2. vendor the adapter and benchmark configs with the experiment;
3. normalize or disable unrelated ESLint directive diagnostics;
4. verify parity before measuring time;
5. clear only the disposable structure cache before every run;
6. run three warm-ups and discard them;
7. alternate tool order to reduce thermal and filesystem-cache bias;
8. collect at least ten measured runs per lane;
9. run Oxlint both with default threading and `--threads 1`;
10. record median, p95, dispersion, and complete process-tree peak RSS; and
11. retain sanitized raw results alongside the report.

Until then, the current numbers are useful feasibility evidence, not a migration threshold.

## Sources

- [Oxc benchmark index](https://oxc.rs/docs/guide/benchmarks)
- [Oxlint JavaScript plugins](https://oxc.rs/docs/guide/usage/linter/js-plugins.html)
- [Writing Oxlint JavaScript plugins](https://oxc.rs/docs/guide/usage/linter/writing-js-plugins.html)
- [Oxlint configuration reference](https://oxc.rs/docs/guide/usage/linter/config-file-reference.html)
- [Oxlint `max-lines`](https://oxc.rs/docs/guide/usage/linter/rules/eslint/max-lines)
- [Oxlint `max-lines-per-function`](https://oxc.rs/docs/guide/usage/linter/rules/eslint/max-lines-per-function)
- [Oxlint `no-restricted-imports`](https://oxc.rs/docs/guide/usage/linter/rules/eslint/no-restricted-imports)
- [Oxlint type-aware linting and type checking](https://oxc.rs/docs/guide/usage/linter/type-aware.html)
- [Oxlint JS-plugin alpha benchmark](https://oxc.rs/blog/2026-03-11-oxlint-js-plugins-alpha)
- [Oxlint JS-plugin preview benchmark](https://oxc.rs/blog/2025-10-09-oxlint-js-plugins.html)
- [Oxfmt overview](https://oxc.rs/docs/guide/usage/formatter)
- [Oxfmt CLI](https://oxc.rs/docs/guide/usage/formatter/cli.html)
- [Oxfmt language support](https://oxc.rs/docs/guide/usage/formatter/language-support)
- [Biome GritQL plugin documentation](https://biomejs.dev/linter/plugins/)
- [Biome GritQL integration status](https://biomejs.dev/reference/gritql/#integration-status)
- [Biome 2.4.5 plugin dispatch optimization](https://biomejs.dev/internals/changelog/version/2-4-5/)
- [Biome `$filename` plugin history](https://github.com/biomejs/biome/issues/6670)
- [Biome JavaScript plugin runtime issue](https://github.com/biomejs/biome/issues/2469)
- [Biome Grit bindings and multi-file status](https://github.com/biomejs/biome/issues/2582)
- [anti-slop repository and rule preset](https://github.com/dmmulroy/anti-slop)
- [`eslint-plugin-project-structure`](https://www.npmjs.com/package/eslint-plugin-project-structure)
