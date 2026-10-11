---
slug: shell-text-classified-by-parser
created: 2026-10-08
---

# shell-text-classified-by-parser

## Target · 2026-10-08 — Shell text in hook/script checks is classified by the unbash AST or the check is cut

**Context:** Three times an agent hand-rolled a shell-command classifier (regex, word-splitter, tokenizer) for a doctor/ship check and paid 7-15 correctness-reviewer rounds of shell edge cases (quotes, ;, &&, continuations, wrappers like env/sudo/npx, functions) before replacing it with a real parse or deleting the feature: sc-2522 (7 rounds, ended on unbash), PR #722 (its detector was 660 of 1129 lines after the switch to unbash), PR #822 (12 rounds on an optional fallow-audit advisory, then cut). The sc-2522 lesson lived in a note on an axis scoped to cli/lib/ship/**, which the pre-edit brief never shows for doctor code, so it recurred.
**Ruling:** A doctor check that must decide which shell words in hook or script text are commands (beyond the existing quote/comment walker in cli/lib/doctor/hook-gate-scan.mts, which is not a parser) walks the unbash AST, the way scanShellScript does: unbash is an optional dependency, dynamically imported, and an absent parser or a parse error is reported as unverifiable, never as clean. An optional advisory whose value does not justify that parse is cut, not built on a regex or hand-written tokenizer.
**Consequences:**
- Positive: Doctor checks that classify shell stay correct on real hook shapes without a review spiral, and plan-time critique has a recorded ruling to cite when a cheap matcher is proposed.
- Negative: A check needs the unbash AST or does not ship; checks run in consumers without optional dependencies degrade to unverifiable.
**Vision-fit:** n/a — internal tooling
**Rejected:** A wider hand-written tokenizer in hook-gate-scan.mts: each widening drew new counterexamples in both directions (PR #822's three rewrites).
**Anchored-bet:** [VALIDATED]
**Revisit-when:** unbash is dropped or replaced as devkit's shell parser
**Scope:** cli/lib/doctor/**
**Category:** consumer-distribution
**Source:** shortcut · sc-4722
