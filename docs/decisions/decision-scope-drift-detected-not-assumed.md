---
slug: decision-scope-drift-detected-not-assumed
created: 2026-07-26
---

# decision-scope-drift-detected-not-assumed

## Target · 2026-07-26 — Scope drift is detected mechanically; a ruling whose gate stopped firing is the failure

**Context:** check-alignment only judges a Target whose Scope glob matches a staged file; a Target matching nothing is free-skipped and the gate exits 0 (check-alignment.mts:29). Nothing verified that a Scope still resolves, so ordinary refactoring silently disarmed rulings. Measured on this repo with the gate's own matchScope: 5 of 28 scoped records point at no path on disk, from two mechanical causes — the .mjs to .mts migration, and file moves. One broke during this very story when markdown.mts moved into recall/. The records are all still correct and readable; they are simply no longer enforced, and a green gate is indistinguishable from a gate that looked and found nothing.
**Ruling:** guard-decisions drift walks the tree and reports every scoped axis whose globs match no file, exiting 1. It reuses the gate's own matchScope so the question asked is EXACTLY the question the gate asks at commit time — a second glob implementation could disagree and call an axis enforced when it is not, which is the failure being detected. It is deliberately mechanical: it answers 'does this glob still match anything', never 'does this code still honour this ruling'. It is NOT yet wired into the blocking commit chain, because it currently fails on 5 pre-existing records and a gate that blocks every commit on day one gets switched off permanently.
**Consequences:**
- Positive: A ruling cannot silently stop being enforced. Refactors that move or rename files surface the records they orphaned, instead of leaving a green gate that checks nothing.
- Negative: Walks the tree per invocation rather than consulting git, so it works in fixtures and unstaged worktrees at the cost of a filesystem scan. Detects only glob resolvability — a scope that still matches but now covers the wrong code reads as healthy.
**Vision-fit:** n/a — internal tooling
**Researched:** Traceability-link-recovery results show prose-to-code conformance checking is brittle even with an intermediate model layer, so the semantic half is deliberately not attempted. The deterministic half found 5 real cases on first run at zero cost.
**Rejected:** Wiring it into the blocking chain immediately (would block all commits until 5 unrelated records are fixed). A separate glob matcher (could disagree with the gate it is supposed to audit). Shelling out to git ls-files (breaks in fixtures and unstaged worktrees).
**Revisit-when:** Scope globs become derivable from code markers rather than hand-written, at which point resolvability is guaranteed by construction and this check is dead weight.
**Scope:** gate-engine/decisions/drift.mts
**Source:** manual
