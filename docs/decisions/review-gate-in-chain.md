---
slug: review-gate-in-chain
created: 2026-07-02
---

# review-gate-in-chain

## Target · 2026-07-02 — Reviewer agents run IN-CHAIN as headless claude -p judges spawned by the consumer's pre-commit hook

**Context:** Consumer repos enforced code review via root-agent-dispatched reviewer subagents whose approve.sh wrote .passed marker files checked by husky. The markers were agent-forgeable (touch .claude/.api-security-passed satisfies the gate with no review), stored diff hashes were never verified, and the root agent could skip dispatch entirely. The one part that WORKED was the checklist.mjs discipline: deterministic enumeration of review items (per staged file for commit-guard, per detected pattern category for domain reviewers) with a finalize that refuses pending items — benchmarked as the mechanism that stops a reviewer hallucinating that it validated units it never looked at.
**Ruling:** Reviewer agents run IN-CHAIN as headless claude -p judges spawned by the consumer's pre-commit hook via guard-review (gate-engine/review/). Domain selection is deterministic from guard.config.json topology; the judge is wrapped from the SAME synced .claude/agents/*.md brief used interactively; a block requires an opus-confirmed FAIL after a sonnet first pass; PASS verdicts cache by staged-diff SHA256 (.devkit/review-cache.json, git-common-dir anchored). The CHECKLIST DISCIPLINE IS RETAINED AND MECHANIZED: checklist.mjs scripts ship in devkit skills (report-only finalize), the gate wrapper mandates the generate/check-item/finalize workflow, the judge's allowlist grants exactly its own checklist script, and guard-review independently verifies the state-file artifact after the judge returns — a missing/incomplete/inconsistent checklist VOIDS a PASS to inconclusive (fail-open exit 2, never a cached pass). Only the forgeable half died: approve.sh, marker files, ship marker-carry. feature-completeness runs at commit-msg (message = intent), straight opus, WARN-by-default.
**Consequences:**
- Positive: Positive: review is un-forgeable (hook spawns judges; artifact is verified, not trusted) and per-item coverage is machine-checked, not claimed; identical diffs re-review free via the cache. Negative: commits in reviewer-scoped paths pay judge latency (parallel fan-out, 300s/420s ceilings under ship's 900s); a consumer without the claude binary loses review to fail-open where markers used to hard-require it.
- Negative: In-chain LLM judges CREATE a new hard-block class (previously only deterministic checks blocked). Accepted because the block is bounded: opus-confirmed only, artifact-verified, fail-open on outage, GUARD_NO_REVIEW bypass, deterministic trigger (domain paths staged).
**Vision-fit:** n/a — devkit internal guardrail architecture, not a product surface.
**Scope:** gate-engine/review/**,agents/**,skills/**,cli/lib/ship/**
**Source:** manual
