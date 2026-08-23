---
slug: semantic-dup-enforcement-boundary
created: 2026-08-23
---

# semantic-dup-enforcement-boundary

## Target · 2026-08-23 — Semantic duplication blocks at pre-commit, not pre-push

**Context:** A synchronous full-index semantic matcher at pre-push compared about 35.7 million pairs in the reproduced Frink index, emitted no progress, and always allowed the push, so it imposed minutes of developer latency without protecting the remote boundary. Devkit already provides a staged blocking semantic gate at pre-commit.
**Ruling:** Semantic duplicate enforcement belongs at the scoped blocking pre-commit boundary. Devkit must not install or recommend an unscoped full-index semantic pre-push scan; any future push-time semantic check needs its own bounded and enforced justification.
**Consequences:**
- Positive: New staged semantic duplicates remain blocked before commit while pushes avoid an unbounded advisory wait, and Devkit skill projections describe the same enforcement boundary consumers actually receive.
- Negative: Commits made with hook bypass, matcher fail-open, or partially staged files excluded because their working-tree bytes differ from the staged content receive no semantic recovery sweep at push. Clone detection and any future CI or offline semantic audit remain separate controls.
**Vision-fit:** n/a — internal developer tooling
**Researched:** Story SC-1821 autonomous evidence; Frink commit history; current Devkit and Frink matcher implementations; Git pre-push hook semantics; 54 declared peer checkouts; prior-art and feature-critique agents.
**Rejected:** Keep the global advisory pre-push scan with progress: rejected because it still makes every push wait for non-enforcing work. Optimize the all-pairs scan: rejected because it preserves the wrong synchronous boundary. Add a bounded pushed-ref or CI scan now: viable future control, but unnecessary for this fix because scoped pre-commit is already authoritative.
**Anchored-bet:** [VALIDATED]
**Revisit-when:** A semantic push check is bounded to pushed content, has measured p95 latency below one second on representative large indexes, and closes an enforcement gap that pre-commit cannot cover.
**Scope:** skills/commit-guard/**,gate-engine/co-occurrence/**,cli/lib/husky/**
**Source:** shortcut · SC-1821, SC-1903
