---
slug: benchmarks-grow-from-telemetry
created: 2026-08-01
---

# benchmarks-grow-from-telemetry

## Target · 2026-08-01 — Benchmarks grow from verdict-labeled telemetry

**Context:** Reviewer corpora hold 13-66 rows per suite while the gates adjudicate real findings daily and discard the evidence; every hand-authored row costs human time, and ~570 banked CodeRabbit findings plus ~12 correctness FAILs/day already carry labels (fix committed vs rebutted/waived). The 2026-08-01 frink methodology addendum (amended at commit) is the charter.
**Ruling:** Corpus rows are minted from verdict-labeled telemetry: diff-bytes archive on reviewer FAIL (enabler, ships in the first PR of the effort), guard-review waive with rationale (decoy mint), collector attempt-correlation (gold mint), and CodeRabbit thread mining via the GitHub API with the collector scope-confirmation join (pr_comments lacks path/threading/resolution). Humans do disagreement-triage only, never authoring.
**Consequences:**
- Positive: Labeled-row throughput replaces authoring as the growth mechanism; clean-pass and recall move onto defensible sample sizes (the correctness precision question needs ~120 decoys); benchmark and gate cannot drift because bench.mts keeps driving the real runCascade.
- Negative: Mined gold measures localized-fixture precision and RELATIVE recall only — absolute recall requires known-answer imports (c-CRAB/CR-Bench); mined labels carry noise (bot-compliant LLM authors), so kappa relabel + noise floor are preconditions for any delta-based decision; fixture trimming places rows far below production input size, quantified via a calibration slice.
**Vision-fit:** n/a — internal tooling
**Revisit-when:** The capture points produce fewer than ~10 usable rows/month, or the calibration slice shows localized-fixture recall diverges from full-context recall by more than 15pp
**Scope:** gate-engine/review/eval/**,gate-engine/review/run-review.mts
**Category:** benchmarking
**Source:** manual
