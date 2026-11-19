---
slug: sentry-judge-admission-by-content
created: 2026-11-19
---

# sentry-judge-admission-by-content

## Target · 2026-11-19 — The sentry judge admits commits by staged-diff content, not by the subject's commit type

**Context:** Since v0.9.0 the sentry commit-msg judge ran only when the subject matched fix|feat|perf|refactor:, a token-economy filter no record ratified. frink-oss, the only consumer with the gate enabled, writes plain-English subjects: 0 of its last 200 main subjects matched, so the gate judged nothing there, including a 230-line classifier full of catch-and-return-false paths, and the skip line read as a deliberate 'trivial commit type' with no telemetry. Severity: an enabled hard gate was silently dark for its whole consumer.
**Ruling:** Admission is decided from the staged diff. A commit skips when its message is empty, when MERGE_HEAD is present (inherited hunks were judged on their own branch), when nothing staged is a non-test non-docs file, or when no added/removed source line carries an error or capture token AND the subject has no fix/feat/perf/refactor type. The type only WIDENS admission to a source change with no error token. A staged diff git could not read is judged (fail toward judging); an empty one keeps the subject rule. Every skip prints its cause under the sentry-judge: prefix and emits a judge_skipped event with judge sentry-advisory and a closed reason.
**Consequences:**
- Positive: The gate judges error-handling changes in any repo whatever its subject convention, so swallowed failures stop reaching main unreviewed, while docs-only, test-only and merge commits still cost zero tokens. A skip is now attributable in telemetry rather than indistinguishable from a gate that never ran.
- Negative: Roughly half of a plain-English consumer's commits now pay a 3-sample haiku vote inside commit-msg where they paid none. A silent early return with no error token in an untyped repo is not judged. ERROR_HUNK_RE and the test-path matcher know only JavaScript-family vocabulary, so a plain-English Python or Go consumer would rarely be admitted on content.
**Vision-fit:** n/a — internal tooling (devkit commit gates).
**Researched:** Prior-art pass (DISSOLVE_FRAME): no solution on main, open PRs or reference checkouts; in-house precedent is decisions-detect's diff-smell free-skip; semantic-release documents silently ignoring non-conforming commits and CodeRabbit skips by path or title, never commit type. Feature critique (PROCEED_WITH_CHANGES) added the merge skip, the unreadable-diff rule and the dedicated event type. Corpus probe: type-or-content judges the same 119/131 eval rows as the old filter with 0 MONITOR missed.
**Rejected:** (a) A per-repo sentry.judgeTypes / alwaysJudge config key — LOSES: a knob for a root-cause bug, and a consumer has to discover it. (b) Pure content with no type path — LOSES: misses the eval's crash-to-silent-early-return MONITOR case, which carries no error token. (c) Judge every commit — LOSES: three cold-start judge calls on every README edit. (d) Context-only admission (an untouched catch next to the change) — LOSES: draws MONITORs on swallows the commit never touched.
**Anchored-bet:** [BET]
**Revisit-when:** A commit the admission skipped is later found MONITOR-worthy, or a non-JavaScript consumer enables the gate and is almost never admitted.
**Scope:** gate-engine/sentry/**
**Source:** shortcut · sc-8647
