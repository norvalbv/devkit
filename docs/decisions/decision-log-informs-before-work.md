---
slug: decision-log-informs-before-work
created: 2026-07-27
---

# decision-log-informs-before-work

## Target · 2026-07-27 — The log informs before work, matched on Scope globs not text similarity

**Context:** Every decision surface enforced AFTER the fact: check-alignment flags a contradiction at commit, decision-stop-check nudges to record at turn end, decision-edit-guard denies a hand-write to a record. Nothing told an agent an area was already settled while it could still act on that, so an agent could re-solve a decided problem from the code alone and only learn at commit — and only if the ruling carried a Scope glob matching the staged files. scoped-targets.mts existed for exactly this and was consumed by one review-time agent.
**Ruling:** Two informing surfaces, both matched on the ruling's own Scope globs. (1) A PreToolUse hook (agents-hooks/decision-scope-brief.mjs) briefs the governing rulings before an Edit/Write, at most once per session per file. It emits additionalContext and deliberately NO permissionDecision, so it can neither block a write nor auto-approve one, and degrades to a silent no-op if the platform ignores additionalContext on PreToolUse. (2) The brainstorming skill runs guard-decisions query at the FORK, before options are posed, which its own decisions-skill documentation already claimed but never implemented (it ran list, in the record step).
**Consequences:**
- Positive: An agent sees the settled ruling while it can still act on it. Scope-glob matching needs no threshold, no model and no network (~121ms), and 33 of 34 axes declare a glob. Effectiveness is observable through check-alignment's existing scoped-contradiction flag rate, so no new benchmark is required.
- Negative: Only files a ruling explicitly scopes are briefed: an axis with no Scope glob informs nobody, and a settled problem in an unscoped area is still invisible. The PreToolUse additionalContext contract is documented inconsistently upstream, so the hook may be a silent no-op on some versions — the skill-level fix is the surface that does not depend on it.
**Vision-fit:** n/a — internal developer tooling; the decision log's own consumption path.
**Rejected:** Injecting retrieved rulings on UserPromptSubmit, keyed on a confidence threshold over the lexical top-1 score — REFUTED on measurement. That score tracks query LENGTH (r=0.908 on this corpus), not confidence: all six short-but-governed probes scored below all four long-but-ungoverned ones, so at the oracle threshold four ungoverned prompts inject and 6/6 governed ones are missed. Raising the threshold buys 'only long prompts', not precision. The event is also wrong mechanically: 5.29s cold, ~78s projected at 500 axes (past the 60s hook timeout), and ~4.9k tokens added to every prompt.
**Scope:** agents-hooks/decision-scope-brief.mjs,skills/brainstorming/**,gate-engine/decisions/scoped-targets.mts
**Category:** decision-log
**Source:** manual
