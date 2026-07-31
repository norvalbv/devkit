# Devkit version telemetry

## Problem

The usage dashboard can group agent and ship activity by `devkit_version`, but current devkit JSONL records do not emit that field. The collector therefore has to label every run as pre-attribution/unknown even when the installed package version is known locally.

## Contract

Every newly emitted gate, reviewer, cache, review-terminal, and ship lifecycle record carries the version of the devkit package that produced it as an additive JSON field:

```json
{ "devkit_version": "0.47.1" }
```

The value comes from the installed `@norvalbv/devkit` package's `package.json`; this change does not modify the package version. Older records remain valid and continue to be interpreted downstream as predating version attribution.

## Design

1. Add a memoised Node resolver that walks upward from the executing module until it finds the `@norvalbv/devkit` package manifest. This works both from the source tree and from compiled `dist/` without hard-coding their different depths.
2. Stamp the resolved version in `runEnvelope()`. That covers every gate, reviewer, cache, and review-terminal record emitted through `emitGateEvent()`.
3. Resolve and export the same manifest version in the shared ship telemetry shell helper. Stamp it on `ship_attempt`, `ship_result`, and `ship_pr`.
4. Keep generated pre-commit hook text version-agnostic. Its bytes are drift-checked against the current generator; embedding a generator version would falsely report drift after every upgrade. Plain commit agent activity is attributed through its gate/reviewer/cache records, while the non-agent `commit_result` remains unchanged.
5. Keep telemetry best-effort: inability to read a manifest must never block a commit or ship. The resolver returns a bounded legacy marker only in that exceptional case; normal source and packaged paths are covered by tests.

## Alternatives considered

- Infer versions downstream from timestamps. This is ambiguous across machines, caches, and staggered upgrades.
- Stamp only `ship_attempt` and join other events by `ship_id`. This leaves raw agent events and plain commits unattributed, and makes every reader depend on a join.
- Pass a version only from the CLI dispatcher. Hooks and directly invoked gate binaries do not necessarily run through that dispatcher.

## Verification

- Unit-test source-tree manifest resolution.
- Assert ship, review, and commit envelopes carry the package version.
- Exercise the ship harness and assert `ship_attempt`, `ship_result`, and `ship_pr` all carry the same version.
- Run focused tests, typecheck, and the production build so compiled-path resolution is covered.
