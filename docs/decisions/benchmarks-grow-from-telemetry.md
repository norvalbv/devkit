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
- 2026-08-01 — **Scope:** gate-engine/review/eval/**,gate-engine/review/run-review.mts,gate-engine/review/evidence/diff-archive.mts — CodeRabbit PR #295: the ruling covers the FAIL diff-byte archive enabler, but evidence/diff-archive.mts wasn't in the path-glob scope so alignment checks never matched it
- 2026-08-02 — capture loop closed end-to-end (#295 diff archive, #302 waive valve, #303 mine-telemetry, #309 propose/propose-telemetry adapt stage): first 8 corpus rows minted with no bot and no PR involved — corpus 120→128 (69 gold / 59 decoy); 42 in-charter telemetry candidates queued behind the first batch. #306 waived propose's hunk drops for rebutted candidates (decoy source; re-derived: 25/34 already survived, +3 in-charter)
- 2026-08-02 — label-trust precondition met (#304): Codex (GPT-family, item 12) blind-relabeled 48 rows — κ 0.662 raw / 0.735 excluding 2 repaired fixture errors (both PASS decoys: an empty BUNDLED_RULES gutting its gate; an unvalidated shell-interpolated branch); first empirical noise floor 2/48 ≈ 4.2% (Wilson [1.2%, 13.9%]) — deltas under ~4pp + paired CI are unresolved. cleanlab confident-learning floor still pending: needs per-row pred_probs from a bench run, not another labeler
- 2026-08-02 — the Target's known-answer path (c-CRAB/CR-Bench 'filtered to TS/JS') was falsified by scoping (#307): both are Python-derived (SWE-CARE / SWE-Bench), c-CRAB's artifact is unlicensed, CR-Bench has no publicly released artifact — no TS/JS slice exists to filter. Proposed replacements awaiting ratification: GHSA/npm advisory mining with fix commits (security suites), or CR-Bench's transformation recipe over SWE-Bench Multimodal's JS/TS repos (correctness). Absolute recall stays blocked until one is built
