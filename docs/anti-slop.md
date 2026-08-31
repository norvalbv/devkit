# Anti-slop capability

Devkit vendors the complete 15-rule [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop)
production ruleset at commit **446268e5d15baa968eaec669ff65358d36ae6259** and composes two
Devkit-owned external-record rules. All 17 rules default to error. The ruleset is an opt-in
capability on top of Devkit's
exact Oxlint 1.78.0 and @oxlint/plugins 1.78.0 pins:

```bash
devkit init --anti-slop   # core Oxc is already installed; package and standalone modes
```

Install and upgrade never fetch anti-slop or add a plugin dependency to the consumer. Devkit copies
its reviewed plugin and the pinned plugin API into **.devkit/anti-slop/**, records provenance and
digests in **.devkit/anti-slop/manifest.json**, then composes the managed fragment through
**.devkit/oxc/oxlint.base.json**. The repository's existing Oxlint config therefore continues to
own native rules, other JS plugins, per-rule severity, and overrides. An inherited override disables
anti-slop diagnostics for Devkit/agent managed directories, so an ordinary composed `oxlint .` does
not lint the vendored plugin as consumer debt. The plugin API is stored under a capability-specific
**plugin/oxlint-plugins-api/** path (not commonly ignored `node_modules` or `vendor`), so a normal
`git add -A` and clone preserve the complete offline capability.

## Incremental adoption

Baseline creation is deliberately never implicit:

```bash
devkit anti-slop create [paths...]          # refuses an existing baseline
devkit anti-slop create --force [paths...]  # explicit replacement
devkit anti-slop adopt-renames              # migrate debt across staged Git renames
devkit anti-slop check [paths...]           # read-only; CI/agent-loop gate
devkit anti-slop check --staged             # exact Git-index snapshot against HEAD
devkit anti-slop check --base <git-ref>     # full CI scan + baseline monotonicity
devkit anti-slop inspect [--json]           # read-only debt inventory
devkit anti-slop prune [paths...]           # shrink existing debt only
```

Paths are literal existing files/directories inside the repository and default to the repository
root. Path-scoped prune and forced create preserve every baseline entry outside that scope; only an
unscoped `create --force` replaces the complete debt record. If that replacement would remove
findings from files that still exist, it refuses without
`--confirm-baseline-removals`, names the removal count and sample paths, and leaves the baseline
unchanged. The committed baseline is
**.anti-slop-baseline.json**. Check never edits it: existing entries are allowed, a new
error-severity finding fails, and a new warning-severity finding is reported without failing.
Prune refuses to write while a new error exists, removes fixed fingerprints, and reduces the
count when one of several identical occurrences is fixed. It cannot add a current finding.
Devkit clean deliberately keeps the baseline because it is the repository's debt record, not
replaceable Devkit state.

`devkit upgrade` has one narrow baseline-migration exception: when refreshed managed state activates
rules that were absent or off in a previous managed profile Devkit emitted, upgrade adds current
findings for only those IDs to an existing baseline. The manifest's rule IDs, its config digest, and
the active IDs must together match a known rule-surface/default profile; otherwise no debt is adopted.
Existing entries and counts are preserved exactly, and a pending marker
makes the migration retryable if capability sync succeeds but the scan is interrupted. No baseline is
created when one did not already exist. Missing or malformed previous managed evidence authorizes no
adoption and is reported. Every managed capability sync records this evidence before
replacement, so running `init` or `doctor --fix` before `upgrade` cannot erase the transition. The
baseline also records a unique completion receipt even when activated rules had zero findings,
preventing a stale retry from adopting violations written after the upgrade without permanently
blocking a later, distinct off-to-error transition. Explicit baseline creation closes the same
pending evidence under the baseline lock. Completion receipts are append-only under staged and CI
baseline comparison.

The staged gate materializes `git write-tree` into a disposable directory. Source files, the root
Oxlint config, managed plugin/config bytes, and the candidate baseline are therefore all read from
the index rather than a partially staged working tree. A root config, managed capability, or
baseline change forces a full scan; otherwise only staged JavaScript/TypeScript postimages are
linted. Deleted and unrelated files no-op.

`--staged` compares the candidate baseline with `HEAD`; `--base` compares it with the named CI base.
Once a base baseline exists, candidate fingerprints and counts may only stay equal or shrink. The
sole growth exception is baseline entries for rule IDs newly enforced by the candidate managed
manifest/config—the commit shape produced by a scoped rule-set upgrade. This covers both a new ID
and a managed off-to-error transition; existing-rule counts remain shrink-only. A base with no
baseline is the bootstrap exception. A Git-detected rename of a file with adopted debt
must persist that debt under the new path in the same commit: stage the rename, run
`devkit anti-slop adopt-renames`, stage the resulting baseline, and check again. Adoption uses the
exact index-vs-HEAD Git rename map and rewrites only the matching path-bearing identities; unrelated
entries are never linted or pruned. If the rename is already committed and `check --base <ref>`
reports `BASELINE-RENAME`, run the printed `adopt-renames --base <oid>` remedy, which freezes that
comparison to an immutable object ID, then stage the baseline. An explicit base with no Git-detected
rename fails and names the reviewed whole-repository resnapshot fallback; it does not silently
succeed. A heavily edited move that Git
does not detect as a rename, or a move across a monorepo package boundary, remains a zero-adoption
no-op in staged mode. The base debt is migrated in memory only to verify that the persisted count did
not grow. This keeps the baseline valid after merge; checks never write.

Occurrences with the same rule, repository-relative file, normalized diagnostic, and normalized
source line are intentionally fungible and share one counted fingerprint. The ratchet prevents that
debt class from growing; it does not assign provenance to otherwise indistinguishable occurrences.
This keeps unrelated line-number shifts from reclassifying an adopted repository's existing debt.

Each fingerprint is SHA-256 over exactly:

1. the namespaced rule id;
2. the POSIX repository-relative file path;
3. the whitespace-normalized diagnostic;
4. the whitespace/line-ending-normalized reported source line.

Absolute checkout paths and line numbers are excluded. Identical fingerprints carry a count, so a
third copy of an already-baselined two-copy pattern is still new. The file contains no timestamp and
entries sort by fingerprint, making identical repositories byte-for-byte deterministic.

## Rule configuration and overrides

All rules default to error. Ordinary Oxlint precedence applies, so a repository can change one
rule without copying the managed stack:

```json
{
  "extends": ["./.devkit/oxc/oxlint.base.json"],
  "rules": {
    "anti-slop/no-runtime-typeof": ["warn", { "allowInTypeGuards": true }],
    "anti-slop/no-module-mocking": "off"
  },
  "overrides": [
    {
      "files": ["scripts/**/*.ts"],
      "rules": {
        "anti-slop/no-object-parameters": "off"
      }
    }
  ]
}
```

The repository-root configuration combines native Oxlint policy and these rules, so rule severities
and path-specific `overrides` stay in one place. Baseline operations deliberately disable nested
config discovery and run the complete root-to-managed-plugin chain that Devkit verifies with a
sentinel. A nested Oxlint config cannot shadow or silently replace that chain. Extending the
anti-slop fragment directly is also rejected: the sentinel independently proves both managed links.

Repositories with adopted anti-slop debt should keep ordinary native lint and the baseline-aware
policy gate as two explicit commands:

```bash
devkit oxc lint --disable-nested-config .
devkit anti-slop check
```

`devkit oxc lint` keeps the repository's root policy intact but substitutes no-op implementations
for Devkit's anti-slop rules. Other native rules, custom plugins, categories, globals, ignores,
settings, options, and overrides still run normally. `devkit anti-slop check` explicitly activates
the real implementations and applies the shrink-only baseline. A direct `oxlint` invocation remains
the combined, unbaselined diagnostic view. This split needs no second config and no consumer-owned
copy of Devkit's rule list.

## Vendored upstream rules and parity

| Rule                                                | Representative behavior proved by the packed fixture |
| --------------------------------------------------- | ---------------------------------------------------- |
| anti-slop/no-chained-type-assertions                | chained assertion from object to User                |
| anti-slop/no-conditional-empty-object-spread        | conditional object spread using an empty object      |
| anti-slop/no-known-value-widening                   | known object assigned to Record of string to T       |
| anti-slop/no-module-mocking                         | Vitest module mock                                   |
| anti-slop/no-object-parameters                      | function parameter typed object                      |
| anti-slop/no-reflect-apply                          | global Reflect.apply                                 |
| anti-slop/no-reflect-get                            | global Reflect.get                                   |
| anti-slop/no-runtime-typeof                         | ad-hoc runtime typeof guard                          |
| anti-slop/no-shape-in-symbol-names                  | interface name containing Shape                      |
| anti-slop/no-unknown-parameters                     | function parameter typed unknown                     |
| anti-slop/no-unknown-returns                        | function return typed unknown                        |
| anti-slop/no-unknown-type-aliases                   | alias that conceals unknown                          |
| anti-slop/no-unsafe-dictionary-type                 | Record of string to unknown                          |
| anti-slop/no-widen-then-assert                      | known local widened to unknown, then asserted back   |
| anti-slop/require-safety-comment-for-type-assertion | non-const assertion without SAFETY justification     |

Devkit additionally registers `anti-slop/no-unsafe-external-record-access` and
`anti-slop/no-unsafe-external-record-enumeration`; their scope, options, and accepted proof forms are
documented in the [external-record extension guide](anti-slop-external-records.md).

The packed E2E fixture asserts that all 15 upstream diagnostics load from the emitted package and
that both Devkit extensions fire by default through the packed plugin API. It also proves that off, warn,
error, and scoped overrides work, that create to new violation to fix to prune preserves the
shrink-only contract, both partial-staging directions, baseline-growth rejection, same-commit
baseline persistence for Git renames, and a post-merge check against the packed consumer binary.

## Intentional differences and limits

- The 15 upstream rule/helper implementations are unchanged from the pinned source. Devkit owns the
  plugin composition seam, the two external-record extensions, delivery, namespacing/config
  ownership, and the baseline wrapper.
- Oxc's JS-plugin API is alpha. The exact Oxlint/plugin API pair and packed fixture are the
  compatibility boundary: it covers all 15 upstream rules and both Devkit extensions. Updating
  either pin requires refreshing that evidence.
- Like upstream, these are syntax/scope rules, not TypeScript type-aware rules. They do not replace
  TypeScript check with no emit.
- Oxc does not run custom JS rules over unsupported custom file formats. The capability targets
  JavaScript, TypeScript, and their supported JSX variants.
- Baseline paths must resolve inside the repository. External files are rejected rather than
  producing machine-specific fingerprints.
- A consumer-authored Oxlint config that does not extend Devkit's managed base will not load the
  plugin. Devkit doctor reports missing integration; the supported fix is to retain
  **./.devkit/oxc/oxlint.base.json** in that config's extends chain.

See [the Oxc migration decision](decisions/oxc-toolchain-migration.md) for why Biome formatting,
ESLint filesystem topology, and TypeScript checking remain separate until their own parity
conditions are met.
