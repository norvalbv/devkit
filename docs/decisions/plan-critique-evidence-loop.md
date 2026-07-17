---
slug: plan-critique-evidence-loop
created: 2026-07-16
---

# plan-critique-evidence-loop

## Target · 2026-07-16 — Shadow-first plan critique evidence loop

**Context:** Feature critique historically emitted inconsistent summaries and runtime .cursor artifacts, lost edge cases between stages, and had no measured path from critique adoption to plan quality.
**Ruling:** Critique only a decision-complete pre-implementation plan: one independent pass, then at most one fresh recheck after a blocker. The one-recheck ceiling is a preregistered rollout bound to benchmark, not a literature-proven optimum or a hard runtime gate; third-or-later passes remain benchmark evidence but can never issue an eligible receipt. Return one closed JSON contract; capture immutable evidence in the user-scoped private devkit spool and worktree Git bindings; import sanitized projections through repo-graph's existing memory layer. Codex is opt-in. Commit gates record only a would-inject projection until paired benchmarks justify injection or enforcement. Runtime provider-directory writes and flow identifiers are forbidden.
**Consequences:**
- Positive: Plan findings and edge cases become provider-neutral, retrievable benchmark evidence without changing current commit reviewer outcomes; ambiguous or stale receipts fail open with explicit reasons.
- Negative: Local hooks and evidence schemas add lifecycle and retention complexity, capture is initially incomplete and fail-open, and a costly K=3 baseline plus paired uplift study is required before hard enforcement. Package-mode and self-host installs can resolve the capture runtime; package-less standalone/overlay capture remains unavailable until the runtime is installed beside the provider hook.
**Vision-fit:** Compound engineering: each plan critique becomes reusable, cross-repository learning while quality gates remain evidence-led.
**Researched:** Self-Refine (arXiv:2303.17651) establishes that iterative feedback/refinement can improve outputs, but does not establish a universal pass count. CRITIC (arXiv:2305.11738) and ProCo (arXiv:2405.14092) support grounding correction in external feedback or explicit condition verification. Huang et al. (arXiv:2310.01798) shows unsupported intrinsic self-correction can degrade reasoning, while CriticBench (arXiv:2402.14809) shows critique quality varies by task and model. Those results justify measuring a bounded one-pass/two-pass policy; they do not validate one retry as optimal. Provider capture design additionally follows the official Claude, Codex, and Cursor hook contracts.
**Rejected:** Periodic review of unstable drafts because it confounds the benchmark and encourages unsupported self-correction; runtime .cursor/.codex artifacts because provider directories are configuration surfaces; a fourth repo-graph layer because critique evidence belongs in the existing memory layer; immediate commit-prompt injection or hard Stop enforcement because uplift and capture reliability are not yet demonstrated.
**Revisit-when:** Paired K=3 plan-uplift and provider capture benchmarks show at least 95 percent contract/capture reliability, fewer residual flaws, no increase in introduced defects, and under 10 percent false revisions on sound plans.
**Scope:** agents/feature-critique.md,skills/feature-critique/**,skills/brainstorming/**,agents-hooks/**,gate-engine/critique/**,cli/lib/install/**,cli/lib/components.mts,cli/commands/init.mts,cli/commands/doctor.mts,cli/commands/clean.mts,cli/lib/husky/**
**Source:** manual
