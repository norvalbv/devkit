---
slug: review-gate-in-chain
created: 2026-07-02
---

# review-gate-in-chain

## Target · 2026-07-02 — Reviewer agents run IN-CHAIN as headless claude -p judges spawned by the consumer's pre-commit hook

**Context:** Consumer repos enforced code review via root-agent-dispatched reviewer subagents that wrote .passed marker files checked by husky. The markers were agent-forgeable (touch .claude/.api-security-passed satisfies the gate without any review), stored staged-diff hashes were never verified (stale approvals passed), the root agent could skip dispatch entirely until the marker check tripped, and each consumer carried checklist.mjs/approve.sh script machinery in two IDE mirrors. Review enforcement rested on the reviewed party's cooperation.
**Ruling:** Reviewer agents run IN-CHAIN as headless claude -p judges spawned by the consumer's pre-commit hook via a new guard-review CLI (gate-engine/review/). Domain selection is deterministic from guard.config.json topology; the judge wraps the SAME synced .claude/agents/*.md brief used interactively (single source, headless preamble + pinned VERDICT line added at spawn); a block requires an opus-confirmed FAIL after a sonnet first pass (check-alignment cascade shape); PASS verdicts cache by staged-diff SHA256 in the consumer's .devkit/review-cache.json (git-common-dir anchored so ship worktrees share it); outages fail open (exit 2). feature-completeness runs at commit-msg (message = intent signal), straight opus, WARN-by-default with GUARD_COMPLETENESS_HARD escalation. The marker/checklist/approve.sh machinery is deleted everywhere, including ship's marker-carry.
**Consequences:**
- Positive: Positive: review becomes un-forgeable and un-skippable (the hook, not the reviewed agent, spawns the judges); consumers shed per-repo marker scripts and dual-IDE mirrors; identical diffs re-review for free via the cache. Negative: commits in reviewer-scoped paths pay judge latency (bounded by the parallel fan-out + cache + SHIP_COMMIT_TIMEOUT 900s); a consumer without the claude binary silently loses review (fail-open) where markers used to hard-require it.
- Negative: In-chain LLM judges CREATE a new hard-block class (previously only deterministic checks blocked; LLM gates only downgraded). Accepted because the block is bounded: opus-confirmed only, fail-open on outage, GUARD_NO_REVIEW bypass, deterministic trigger (domain paths staged).
**Vision-fit:** n/a — devkit internal guardrail architecture (the solo dev's cross-repo review enforcement), not a product surface.
**Scope:** gate-engine/review/**,agents/**,skills/**,cli/lib/ship/**
**Source:** manual
