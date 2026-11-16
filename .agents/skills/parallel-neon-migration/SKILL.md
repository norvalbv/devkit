---
name: parallel-neon-migration
description: Parallel per-function neon.ts migration workflow. Use when accelerating Electron-to-cloud migration by running N migrator subagents in parallel with mandatory nested work-loss review and deferred pre-commit validation.
---

Run fast migration waves safely.

Workflow:
1. Read `scripts/neon-migration-checklist.md` and select next N unchecked functions (default N=4).
2. Launch N `neon-function-migrator` workers in parallel, one function per worker.
3. Require each worker to invoke `migration-work-loss-reviewer` before completion.
4. Disallow worker lint/typecheck/build; reserve global checks for `/pre-commit-reviews`.
5. Collect compact worker outputs and classify each function: `done`, `blocked`, `needs-reconcile`.
6. If blocked due to reviewer not run, retry that function immediately.
7. Update checklist only for functions with reviewer success and no critical findings.
8. Reconcile overlapping file edits, then run `/pre-commit-reviews` once per batch.
9. Commit batch checkpoint, then repeat.

Guardrails:
- One function per worker.
- No checklist checkmark without route parity + caller rewiring + reviewer success.
- Keep outputs concise to prevent context bloat.
- Do not delete `src/main/lib/neon.ts` until final cutover phase.
- Error-path resilience: old `neon.ts` returned null on not-found; cloud-client throws `ApiRequestError` on 5xx. Workers must ensure callers have try/catch when the old code only checked for null.
