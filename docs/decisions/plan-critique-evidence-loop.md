---
slug: plan-critique-evidence-loop
created: 2026-07-19
---

# plan-critique-evidence-loop

## Target · 2026-07-19 — Plan-stage critique evidence compounds without repository artifacts

**Context:** Feature critiques currently overwrite provider-specific runtime files, cannot be safely linked to later outcomes, and prior recovery attempts rewrote measured guidance without valid benchmark evidence or changed commit behavior.
**Ruling:** Keep feature-critique plan-only and preserve its substantive reasoning guidance. Return one strict normalized JSON response; allow one fresh recheck only after a blocking result. Capture opted-in Claude, Codex, and Cursor callbacks fail-open into immutable private evidence outside the repository, with Codex a fresh-install default alongside Claude and Cursor while legacy ownership remains provider-scoped. Repo-graph imports sanitized projections through its existing memory layer. Commit gates observe a deterministic would-inject projection only and never change reviewer inputs or outcomes until paired benchmarks justify injection.
**Consequences:**
- Positive: Critiques and atomic edge cases become durable, attributable learning evidence that can improve benchmarks and later reviews without polluting consumer repositories, deleting user provider data, or silently changing commit decisions.
- Negative: The first release deliberately skips ambiguous work bindings, stores sensitive evidence only with explicit hook opt-in, keeps optional opaque transcripts off by default and bounded when enabled, pays for one treatment K=3 run after the prompt transport changes, and defers implementation review, hard plan-exit enforcement, and commit-prompt injection.
**Vision-fit:** n/a - internal developer tooling that compounds review learning while preserving consumer control
**Researched:** Self-Refine arXiv:2303.17651; CRITIC arXiv:2305.11738; Huang et al. arXiv:2310.01798; CriticBench arXiv:2402.14809; official Claude, Codex, and Cursor hook contracts; existing benchmark-evidence-append-only and bench-gates-on-flips-not-deltas Targets.
**Rejected:** Runtime .cursor or .codex evidence files; flowId or EDGE_CASES_ID; periodic critique of unstable drafts; repeated self-review loops; a fourth repo-graph layer; raw transcripts in SQLite; last-writer-wins evidence selection; default-on broad agent hooks; commit reviewer injection without paired controls.
**Revisit-when:** A preregistered plan-uplift study supports a different retry policy, provider APIs expose stronger stable work identity, or paired commit-reviewer experiments show context injection improves quality without harmful flips.
**Scope:** agents/feature-critique.md,skills/feature-critique/**,gate-engine/critique/**,agents-hooks/**,cli/lib/components.mts,cli/lib/install/**,cli/lib/sync-manifest.mts,cli/commands/init.mts,cli/commands/doctor.mts,cli/commands/clean.mts,cli/lib/overlay.mts
**Source:** manual

## Evidence boundary

[Self-Refine](https://arxiv.org/abs/2303.17651) and [CRITIC](https://arxiv.org/abs/2305.11738) show that feedback can improve generation, especially when critique is grounded. [Huang et al.](https://arxiv.org/abs/2310.01798) show that unsupported intrinsic self-correction can instead degrade answers, while [CriticBench](https://arxiv.org/abs/2402.14809) treats critique quality as a capability to measure. Together they justify a bounded, benchmarked policy; they do not establish that one retry is universally optimal.
