---
slug: test-deadlines-are-hang-detectors
created: 2026-08-30
---

# test-deadlines-are-hang-detectors

## Target · 2026-08-30 — Test deadlines are hang detectors, enforced by an AST rule

**Context:** sc-2288: every full bun run test:run ended with one spurious failure in a different random file, blocking every push via the pre-push hook and making a red tree indistinguishable from noise. Six test files asserted that a contended machine executes a step within a short wall-clock budget; under maxWorkers 50% that claim stops holding and the test fails with no assertion being wrong. The same class was already fixed once at the config layer in sc-1263 (abb73aef) and recurred at the test-local layer, including in a file that very commit created.
**Ruling:** A deadline in a test bounds a genuine hang and nothing else. Assert the observable behaviour (exit status, exact error text, the reaped process, the file that appeared), never how long it took. An elapsed LOWER bound is never acceptable, because raising it makes the assertion strictly more flaky. Enforcement belongs in an AST-based oxlint rule under anti-slop/, alongside the 15 rules already vendored there.
**Consequences:**
- Positive: Developers can trust a red suite again: a failure means a defect rather than scheduler noise, so the pre-push gate stops training people toward --no-verify.
- Negative: Until the lint rule lands, nothing prevents recurrence: the rule lives only as prose in skills/testing/SKILL.md, and at least gate-engine/judge/__tests__/judge-exec-telemetry.test.mts and cli/lib/ship/publish-qavis.test.mts still carry the shape. Generous deadlines also cost real serial suite time where the cap must elapse.
**Vision-fit:** n/a - internal tooling; devkit's own suite is the gate every consumer change passes through.
**Rejected:** A regex scanner over test sources - ATTEMPTED AND WITHDRAWN in sc-2288: eight review rounds found eight further valid inputs it mishandled (vi.waitFor options behind a balanced-paren walk, regex literals after return and after if(...), an object literal followed by a slash, template interpolations, a brace inside a string inside an interpolation, function(){} callbacks, a comma inside a string in a concise arrow body, negative and uppercase-exponent literals). Shipping it would have given false confidence the class was closed.
**Revisit-when:** The anti-slop deadline rule ships, or a third recurrence appears before it does
**Scope:** skills/testing/SKILL.md,anti-slop
**Source:** manual
