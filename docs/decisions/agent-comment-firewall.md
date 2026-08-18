---
slug: agent-comment-firewall
created: 2026-08-15
---

# agent-comment-firewall

## Target · 2026-08-15 — Challenge changed comments before they can justify workarounds

**Context:** Agent-authored implementations sometimes preserve a bug or shortcut and then add a paragraph explaining why the workaround is acceptable. Untouched repository comments are existing debt, while every added or modified source comment is evidence introduced by the current change. A purely syntactic hard gate would also reject legitimate invariants, safety explanations, licenses, and API documentation.
**Ruling:** Add a dedicated hybrid comment firewall after the deterministic guard prefix. It reads staged index blobs, reconstructs every added or modified supported-language comment token, and blocks deterministically when no explicit per-finding rationale exists. A cheap independent judge may only downgrade that existing block after reviewing the exact comment, bounded relevant code and diff, rationale, and optional canonical debt ticket. PASS receipts are content-addressed to all judged evidence and policy identity; relevant changes invalidate them. Untouched comments and deletions are grandfathered. The correctness reviewer and its benchmark are not changed.
**Consequences:**
- Positive: Agents must either remove the comment and fix the underlying implementation, explain why the comment is load-bearing, or link a tracked cleanup ticket for legitimate temporary debt. Fresh installs receive the firewall in the recommended guard set; existing recorded selections are offered the new bundled guard without silent re-enablement. Supported lexer adapters and outage states are reported explicitly.
- Negative: Every changed comment incurs one deliberate challenge and some legitimate documentation incurs a one-time rationale and model cost. Ordinary judge outages remain visible but fail open under the established AI-gate contract; strict ship fails closed. Initial language support is deliberately limited rather than using a misleading universal regex.
**Vision-fit:** Turns a recurring agent failure mode into a changed-only ratchet while preserving consumer-owned configuration, transparent bypass evidence, and independent semantic review.
**Researched:** Bun Comment Cop, Bun adversarial reviewer guidance, Bun self-obsoleting workarounds, source-lint ratchets, and devkit review-gate/verdict-store precedents.
**Rejected:** Rejected a literal two-line Comment Cop hard gate because it is noisy and format-gameable; rejected changing the correctness prompt because it is a distinct classifier with an existing benchmark; rejected rationale-alone authorization because it can launder the same workaround without independent review.
**Anchored-bet:** A changed-comment challenge plus independent judged rationale will expose workaround-shaped implementation bugs earlier without training agents to delete legitimate load-bearing documentation.
**Revisit-when:** The focused corpus misses the hard-gate precision threshold, disable or rejection rates show unacceptable friction, or production evidence supports narrower TODO/suppression/stub detectors instead.
**Scope:** gate-engine/comment-firewall/**,cli/lib/components.mts,cli/lib/husky/**,cli/lib/doctor/**,package.json,guard.config.json
**Category:** commit-gates
**Source:** Bun Comment Cop and self-obsoleting workaround prior art · https://github.com/oven-sh/bun/blob/cc53961f55e261d5167e440517eb8eb19a900a37/.github/workflows/comment-cop.yml
