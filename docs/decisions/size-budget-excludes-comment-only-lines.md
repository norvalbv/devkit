---
slug: size-budget-excludes-comment-only-lines
created: 2026-08-31
---

# size-budget-excludes-comment-only-lines

## Target · 2026-08-31 — Measure code budget without charging comment-only lines

**Context:** Story #2272 showed independently reviewed load-bearing documentation pushing both a Frink file and function over their line caps, which forced unrelated helper deletion and JSDoc compression while duplicate ESLint and guard-size counters disagreed on ownership.
**Ruling:** Size governance measures non-comment physical lines for lexer-supported source extensions: comment-only lines do not consume file or function budgets, while blank lines and lines containing code or structural text still count; unsupported extensions retain physical-line counting, and legacy raw baselines convert lazily against immutable parent counts without admitting growth.
**Consequences:**
- Positive: Agents can keep semantically approved invariants and API documentation without trading them against executable-code budget, while unchanged numeric caps, independent comment review, staged-index authority, and shrink-only debt remain enforced.
- Negative: guard-size pays lexer work and a per-file baseline-unit transition; comment-heavy files may exceed the numeric cap in physical height, and unsupported languages keep the stricter raw metric until an adapter exists.
**Vision-fit:** n/a — internal tooling
**Researched:** Story #2272 autonomous evidence; local ESLint 10.5.0 probes; official ESLint max-lines and max-lines-per-function documentation; Airbnb and Raycast configurations; devkit feature critique
**Rejected:** Raw physical lines — rejected because approved documentation caused unrelated code deletion; ESLint-only skipComments — rejected because guard-size would still block the same file; rationale-specific allowances — rejected because they couple a deterministic size gate to judge/store state and gate ordering.
**Anchored-bet:** [BET]
**Revisit-when:** Comment-heavy governed files create material navigation cost despite stable executable size, or a newly supported source language cannot expose trustworthy comment ranges.
**Scope:** gate-engine/ratchets/**,gate-engine/comment-firewall/detect.mts,templates/electron/eslint.config.mjs,cli/lib/overlay.mts
**Category:** commit-gates
**Source:** shortcut · https://app.shortcut.com/benordlabs/story/2272
- 2026-08-31 — **Scope:** gate-engine/ratchets/**,gate-engine/comment-firewall/detect.mts,templates/electron/eslint.config.mjs,cli/lib/overlay.mts,cli/lib/ship/**,skills/structure-governance/** — The same metric is described by ship preflight comments and the structure-governance runbook, so those reader-facing contracts must stay aligned with the counters.
- 2026-08-31 — **Scope:** gate-engine/ratchets/**,gate-engine/comment-firewall/detect.mts,templates/electron/eslint.config.mjs,cli/lib/overlay.mts,cli/lib/ship/**,skills/structure-governance/**,guard.config.example.json,docs/design/structure/06-universal-collapse.md — The checked-in consumer configuration example and current structure-collapse design summary also describe the size metric and must not keep promising raw-line semantics.
- 2026-08-31 — **Scope:** gate-engine/ratchets/**,gate-engine/comment-firewall/detect.mts,templates/electron/eslint.config.mjs,cli/lib/overlay.mts,cli/lib/ship/**,skills/structure-governance/**,guard.config.example.json,docs/design/structure/06-universal-collapse.md,docs/structure-governance.md,docs/glossary.md — Canonical structure documentation and the glossary define the size wall for consumers and must state the comment-excluded file metric and dual ESLint/ratchet enforcement.
- 2026-08-31 — Legacy metric conversion persists and stages version 3 on the first successful commit gate even without a debt shrink, so adopted consumers pay provenance traversal once; all MERGE_HEAD commits are pinned before conversion so octopus merges cannot omit a stricter parent.
