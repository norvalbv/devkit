# Unique commit telemetry attempt identity

## Problem

Ordinary commit telemetry currently uses `commit-<git write-tree>` as its run identifier. The tree
hash identifies staged content, not an execution. Retrying or amending a commit without changing the
index therefore reuses the same identifier. Downstream collectors that key runs by `ship_id` retain
one terminal result and attach later gate evidence to that earlier run, corrupting attempt counts and
duration averages.

## Design

The generated pre-commit hook will create one unique identifier when an ordinary commit attempt
starts and export it as `DEVKIT_COMMIT_ID`. Every gate process spawned by that hook inherits the same
identifier, and the hook's `commit_result` terminal emits it unchanged. When commit-message judges
are selected, pre-commit also writes the identifier and staged tree to a worktree-local Git metadata
handoff. The separately launched commit-msg hook validates the tree, reuses the identifier, and
removes the handoff on exit. Ship and explicit review runs continue to use their existing
authoritative identifiers.

The staged tree hash remains telemetry metadata (`commit_tree`) because it is useful for correlating
retries of the same content. It is no longer the primary key for new hook-driven commit attempts.
Gate processes invoked outside a generated hook retain the legacy tree-derived fallback so telemetry
remains fail-safe and backwards compatible during rollout.

The attempt identifier uses `uuidgen` when available and a process/time fallback otherwise. Failure
to resolve Git state still leaves the commit path unaffected; telemetry remains best-effort.

## Verification

Regression coverage will prove that:

- two hook executions against identical staged content produce distinct run identifiers;
- a gate subprocess and its terminal event share one identifier;
- `commit_tree` preserves the staged-content correlation;
- ship, review, opt-out, pass, and blocked paths retain their existing behavior;
- legacy direct gate invocation without `DEVKIT_COMMIT_ID` still falls back to the tree-derived ID.
