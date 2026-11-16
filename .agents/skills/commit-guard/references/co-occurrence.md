# Co-occurrence detector architecture and operations

Devkit owns and ships the duplication engine. Consumer repositories keep only configuration and
state; they do not vendor detector scripts.

## Ownership boundary

Devkit provides these installed commands:

- `guard-dup` — semantic, symbol-level matching against the configured search-code index.
- `guard-clone` — token-level clone detection through devkit's `jscpd` dependency.
- `guard-dup-allowlist` — CRUD for the shared allowlist used by both detectors.

A consumer repository provides:

- `guard.config.json`, including `scanRoots`, optional `cloneRoots`, thresholds, `indexPath`, and
  `allowlistPath`.
- The search-code index named by `indexPath`, when semantic matching is enabled.
- `.co-occurrence-allowlist.json` (or the configured equivalent), which records intentional
  duplication approvals.

Run every command from the consumer repository root so configuration, staged paths, the index, and
the allowlist resolve against that repository.

## Detector contract

The pre-commit checks are:

```bash
guard-dup scan --new --changed --gate
guard-clone scan --changed --gate
```

`--changed` restricts results to pairs touching a staged file. `--new` suppresses live semantic
allowlist entries. `--gate` uses the same exit-code contract for both detectors:

- `0` — clean.
- `1` — an unapproved duplicate was found; block the commit.
- `2` — the detector could not run. The default gate reports the named opt-out and fails open;
  `GUARD_DETERMINISTIC_STRICT=1` makes that opt-out fatal.

The detectors complement each other. Semantic matching catches renamed or paraphrased symbols;
clone detection catches copied sub-chunks and inline JSX that do not align to symbol boundaries.

## Reviewing a finding

Prefer reuse or extraction when the implementations share one responsibility and should evolve
together. Keep both copies only when they are intentionally independent or when extraction would
create a worse dependency boundary.

When approval is justified, use the pre-filled command printed by the blocking detector. It carries
the stable key and findability metadata; do not reconstruct it by hand. Semantic approvals use an
order-independent symbol/file key. Clone approvals use `fragmentHash`, so unrelated line movement
does not invalidate them.

Useful read-only checks:

```bash
guard-dup-allowlist list
guard-dup-allowlist check <symA> <fileA> <symB> <fileB>
guard-dup-allowlist check-clone <fragmentHash>
```

Approvals decay. Expired entries resurface automatically during gate scans. Remove obsolete entries
with the matching `remove` or `remove-clone` command, and delete all expired entries with:

```bash
guard-dup-allowlist prune
```

## Baseline and burn-down

`guard-dup baseline` freezes the current semantic candidate set with long-lived approvals; use it
only when adopting the gate in a repository with accepted pre-existing duplication. It is not a
normal response to a new finding.

`guard-dup reconcile` compares semantic approvals with current detector output and reports entries
that no longer match. It is remove-only and dry-run by default:

```bash
guard-dup reconcile
guard-dup reconcile --apply
```

Use `reconcile` after refactors or index refreshes to burn down stale semantic approvals. Use
`guard-dup-allowlist prune` for time-based expiry; the operations answer different questions.

## Troubleshooting

- No semantic index configured: `guard-dup` exits `2`. Configure `indexPath` (or
  `GUARD_INDEX_PATH`/`SEARCH_CODE_DB`) and refresh the repository index.
- Missing clone detector: install or repair the devkit package; `jscpd` is an optional dependency
  resolved from devkit, the consumer, or `JSCPD_BIN`.
- Missing projected checklist or reference: run `devkit sync-skills`. The skill, checklist, and this
  reference are all devkit-owned assets copied recursively into each selected agent provider.
- Corrupt allowlist: repair the JSON rather than regenerating it. The engine refuses unsafe writes
  when an existing allowlist cannot be parsed.
