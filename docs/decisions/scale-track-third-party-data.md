---
slug: scale-track-third-party-data
created: 2026-08-23
---

# scale-track-third-party-data

## Target · 2026-08-23 — A scale-track probe/bench may COMMIT to devkit only counts, names, anonymized ids, and hashes

**Context:** The scale-track benchmark reviews REAL third-party diffs (frink) with real judges; committed evidence in this public repo has already leaked a private frink path with a vulnerability description once (gate-engine/edge-cases/eval/cases.jsonl:44, feature-critique BLOCKER 4 on the 2026-08-22 plan), and probe tables naturally want to name files and findings.
**Ruling:** A scale-track probe/bench may COMMIT to devkit only: counts, lens names, anonymized row/label ids, hashes (diff_sha256, base commit sha), repo ALIAS, dollar/latency numbers, and per-tier hit/miss tables. Never the third-party repo's file paths, issue text, source lines, or diff bytes. Raw inputs, labels, checkpoints, and per-issue predictions stay local under ~/.devkit/research/**. Judges reviewing a materialized third-party checkout keep the same Bash/Read reach the production gate already has on that repo — the boundary is what gets COMMITTED, not what gets read. Content enters the public corpus only as anonymized minimal fixtures per docs/benchmarks/corpus-growth.md adapt rules.
**Consequences:**
- Positive: Real-PR benchmarking (the only regime where reviewer yield saturates) becomes possible without publishing a private codebase's internals; results stay reproducible via {alias, diff_sha256, base sha} against the owner's local archive.
- Negative: Committed probe tables are less readable (no file names), and third parties cannot re-run them without the local archive — reproducibility is owner-local by design.
**Vision-fit:** n/a — internal tooling
**Revisit-when:** scale rows need more than {alias, hashes, counts} to be reproducible, or a consumer-visible export of the research dir is built
**Scope:** gate-engine/review/eval/reviewers/scale/**,gate-engine/review/lens/chunk.mts
**Category:** benchmarking
**Source:** manual
- 2026-08-24 — Heading reading clarified (PR #439 review, comment 3844485116): in the 2026-08-23 target, the whitelist (counts, lens names, anonymized ids, hashes) is the OBJECT of 'may COMMIT' and devkit is the destination — i.e. 'may commit only counts, names, anonymized ids, and hashes to devkit'. The generated heading itself is append-only and re-targets only on an evidence-state change, so it is annotated here rather than reworded.
- 2026-09-02 — **Scope:** gate-engine/review/eval/reviewers/scale/**,gate-engine/review/lens/chunk.mts,gate-engine/review/eval/reviewers/external/**,docs/benchmarks/external/** — external/ (Martian + CodeRabbit lens-hole probes) materializes third-party checkouts and reads third-party findings under the same counts-only committed-artifact rule; the alignment gate must arm on that directory and on the committed docs/benchmarks/external/ tables
