---
slug: reviewer-blocks-require-validated-evidence
created: 2026-08-23
---

# reviewer-blocks-require-validated-evidence

## Target · 2026-08-23 — checklist-free reviewers block only on mechanically validated findings

**Context:** Story #1422 added prompt-level recovery after the conventions reviewer false-blocked a capped large diff, but Story #1836 reproduced the same failure: the reviewer said the visible code had no violations, cited only omitted/truncated evidence, and still blocked the commit with a prose `FAIL`. A prompt alone cannot grant reliable blocking authority when the reviewer has no deterministic checklist artifact; recurring evidence-free failures make developers distrust or bypass the whole review gate.
**Ruling:** A checklist-free reviewer's prose verdict never blocks by itself. Blocking authority requires the gate to mechanically parse at least one complete finding that satisfies the reviewer's declared evidence contract. A `FAIL` without such a finding is inconclusive, preserving strict ship's fail-closed boundary without misreporting a repository-rule violation.
**Consequences:**

- Positive: Capped or malformed reviewer output cannot masquerade as a proven code violation, while complete cited findings retain blocking power and stable waiver identities.
- Negative: A novel but legitimate citation format can be classified as inconclusive until the parser and its fixtures learn it; strict ships still stop on that uncertainty, and maintaining the parser becomes part of the reviewer's accuracy surface.
  **Vision-fit:** n/a — internal tooling (devkit review infrastructure).
  **Researched:** Prior-art review of established mechanically validated finding patterns; feature critique of Story #1836; regression evidence from Story #1422 / PR #392 and autonomous report c74e8329-7f08-4e9e-9e63-67bfb674a328.
  **Rejected:** (a) trust any prose `VERDICT: FAIL` — LOSES: repeats the capped-evidence false block that forced Stories #1422 and #1836; (b) always fail open when evidence is malformed — LOSES: a strict ship could silently skip a real violation; (c) rely only on stronger prompt wording — LOSES: PR #392 shipped that approach and the same failure recurred.
  **Anchored-bet:** [BET]
  **Revisit-when:** The live conventions benchmark's production-parser blocking-authority recall falls below its 0.70 floor, or checklist-free reviewers gain a deterministic artifact that supersedes transcript parsing.
  **Scope:** gate-engine/review/**,gate-engine/judge/run-judge.mts
  **Source:** collab · SC-1836
- 2026-08-23 — The conventions implementation shares one evidence-pair scanner across blocking authority, waiver fingerprints, and evaluation; preserves the 60KB evidence cap; accepts all four citation shapes in the recorded live baseline (including rule locations without a line and with parenthetical annotations) plus wrapped protocol-label content; and permits at most one same-model retry before an unsubstantiated `FAIL` remains inconclusive/exit 3. Non-strict mode stays single-pass and fail-open/exit 2. The live benchmark separately floors production-parser blocking-authority recall so tolerant slot scoring cannot hide a fail-open parser regression.
