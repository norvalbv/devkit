---
slug: benchmark-evidence-append-only
created: 2026-07-17
---

# benchmark-evidence-append-only

## Target · 2026-07-17 — Benchmark evidence is append-only

**Context:** Accepted benchmark baselines and README result tables were overwritten in place, so maintainers could not reconstruct prior quality, distinguish coverage growth from quality gains, or audit whether a published claim still matched the current corpus and scorer.
**Ruling:** Accepted benchmark evidence is preserved as immutable, provenance-aware events plus content-addressed sanitized checkpoints; generated README and SVG dashboards are disposable views over that record, with lifecycle, evidence, freshness, change type, and assessment kept as separate axes.
**Consequences:**
- Positive: External readers get one honest dashboard, maintainers retain row-level evidence after suite baselines move, and CI can detect deleted or mutated history before merge.
- Negative: Each accepted run adds committed checkpoint data and a central JSONL event, parallel worktrees require explicit reconciliation, and every suite needs an adapter that owns its metric semantics and acceptance policy.
**Vision-fit:** n/a — internal developer-tooling evidence integrity
**Researched:** Repository history and eval baselines since 2026-07-01; independent feature critique; GitHub README image and picture-element documentation.
**Rejected:** Per-suite README tables only — rejected because baseline replacement and prose drift erase machine-verifiable history; a mutable central latest-results file — rejected because corrections destroy the audit trail; headline metrics without checkpoints — rejected because future readers cannot reconstruct row flips or scoring.
**Anchored-bet:** [VALIDATED]
**Revisit-when:** Git itself supplies an immutable queryable benchmark evidence store with schema validation, content-addressed artifacts, generated views, and safe multi-worktree reconciliation.
**Scope:** README.md,docs/benchmarks/**,gate-engine/eval/**,.github/workflows/gate.yml,cli/lib/husky/self-host.mts
**Source:** brainstorm
- 2026-09-03 — publish --tree STAGED reads the baseline, catalog, ledger and predecessor checkpoints from the Git index, so published bytes are the bytes the commit carries; sourceCommit then names the parent the index was staged over and provenance.source says so. A tree identity was rejected: publish's own outputs are staged after it runs, so no pre-publish tree equals the shipped commit's tree. Declared debt: only 3 of 23 distinct sourceCommit values in the ledger are ancestors of HEAD and 6 are absent from a fresh clone, because squash-merge and ship's re-mint at BASE orphan them; the ledger is immutable, so this is recorded, not repaired.
