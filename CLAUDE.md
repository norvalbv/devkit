# devkit — agent routing

This page routes; it does not rule. It holds no conventions of its own. The reasoning behind
devkit's architecture lives in decision records, and this page points at them so an agent orienting
here does not have to guess where the project is heading.

## Where the "why" lives

`docs/decisions/` is the store — one append-only file per axis, each a stack of `## Target ·` blocks
(the ruling and the reasoning behind it) plus cheap dated notes recording implementation convergence
under the current Target.

`docs/decisions/INDEX.md` is a derived spine over that directory: the current Target per axis,
regenerable, holding no history. It reads well as an entry point, and it is a view rather than the
source. `docs/decisions/decision-retrieval-candidate-set.md` records why, including the measurement
that 23 of 86 axes had no INDEX row and were unreachable by query at any k. Searching the directory
itself finds axes the spine omits.

Retrieval in this repository runs from source, because devkit self-hosts:

```
node gate-engine/decisions/cli.mts query "<topic>"
node gate-engine/decisions/cli.mts show <slug>
```

A consumer reaches the same surface as `guard-decisions`. The source rewrite is described in
`cli/lib/husky/self-host.mts`.

## What a record contains

Context (the forcing problem) → Ruling (the mechanism) → Consequences (value protected, cost paid),
plus devkit's own extensions: Tradeoff, Vision-fit, and a Scope glob that arms the alignment gate.
Optional fields carry Researched, Rejected, Anchored-bet, Revisit-when and Category.

Records are written through the `guard-decisions` CLI and the `skills/decisions/SKILL.md` playbook.
Committed history is append-only, and a pre-edit hook declines direct agent writes.
`docs/decisions/decision-records-cli-owned-writes.md` is the ruling behind that shape.

## Four premises that are hard to infer from any single file

- **W-3 portability, which has two halves.** devkit ships inside a consumer's `node_modules` and
  executes in a repository it does not own. Consumer data — roots, config, the staged set — resolves
  from the consumer's cwd, and synced assets read layout from the consumer's `guard.config.json`
  rather than assuming a stack's directory tree. devkit's own packaged assets are the other half:
  `templates/` and `skills/` resolve from `packageDir()` in `cli/lib/fs-helpers.mts`, which is keyed
  to `import.meta.url`. Collapsing the two halves into one rule is the classic first-patch error
  here. See the `review.trustBoundaries` note in `guard.config.json` and
  `docs/decisions/synced-assets-layout-agnostic.md`.
- **Gates judge the consumer repository, not the harness.** devkit's gates govern that repository's
  diffs, structure, staged set, decision records and commits — not how an agent drives its own
  tooling. `docs/decisions/devkit-gates-repo-not-harness.md` also records the two narrow carve-outs
  that let a hook order devkit's own workflow stages.
- **devkit dogfoods through `devkit init` self-host mode.** `.devkit/config.json` carries
  `selfHost: true`; the pre-commit hook comes from the same generator consumers use, with a parity
  test locking the two together. The live ruling is the 2026-07-13 Target in
  `docs/decisions/devkit-self-dogfood.md` — the earlier Target on that axis was superseded, so
  reading only the first block there gives a stale answer.
- **A published version tag is immutable.** bun records the object a tag resolved to, so re-pointing
  a tag orphans every SHA already pinned downstream.
  `docs/decisions/published-version-tags-immutable.md`.

## Where to look next

`README.md` carries the Documentation list — glossary, troubleshooting, structure governance,
directory structure, benchmark methodology, decision index. That list is the canonical one, so it is
linked from here rather than copied.

The agent-facing procedure docs live under `skills/`: `skills/using-devkit/SKILL.md`,
`skills/commit-gates/SKILL.md`, `skills/decisions/SKILL.md`,
`skills/structure-governance/SKILL.md`, `skills/dup-detection/SKILL.md`.

## A note on the shape of this file

`gate-engine/review/claude-md.mts` feeds a governing `CLAUDE.md` to conventions-reviewer, which
treats an unhedged directive here as an enforceable rule and can block a commit on it. This page
stays descriptive for that reason, and `cli/__tests__/root-routing-doc.test.mts` holds it there.
