---
slug: ci-merge-gate-one-aggregate-check
created: 2026-10-10
---

# ci-merge-gate-one-aggregate-check

## Target · 2026-10-10 — main's merge gate is one aggregate CI job that needs every other job

**Context:** main had no required status check: ruleset 19675205 carried only deletion, non_fast_forward, pull_request and required_linear_history, and PRs merged before CI finished. gate.yml failed on every push to main from 2026-10-02 and nothing stopped a merge; the six main runs from 2026-10-06 to 2026-10-10 each failed the same 4 test files on deterministic assertions (one run added a fifth that the next commit fixed), none through a vitest timeout. main had been red the same way through August (ci-emits-per-file-test-results). Unattended merging needs one CI answer per commit that means something. Requiring the existing job gate by name would leave any job added later silently unrequired, and GitHub reports a job skipped by a failed dependency or a false condition as Success to a required check.
**Ruling:** main's merge gate is one aggregate job, required, in gate.yml. It needs every other job in the workflow, runs if: always(), and passes only when its needs are non-empty and every one concluded success. It is the only required status check in main's ruleset, switched on by hand once main has 3 consecutive green push runs and the first of them shows required: success. A job added to gate.yml joins its needs list; a contract test fails otherwise.
**Consequences:**
- Positive: A red, cancelled or skipped CI job blocks a merge, and adding a job never needs a ruleset change because the ruleset names one stable context. Later auto-merge work reads one check on the head SHA as CI's answer.
- Negative: Once switched on, every merge waits for the whole Tests step (25-35 min), and a deterministic red on main blocks every PR until a fix PR is green; a habitual bypass would make the check meaningless. A superseded PR run cancelled by concurrency still runs required and posts a red check on the stale SHA, one short runner each. A job meant to be skipped on some events fails required until an explicit allowance is added. A needs-gated check run registers only once gate finishes, so gh pr checks --required sees no required check for most of a run.
**Vision-fit:** n/a — internal tooling; devkit's own CI is the deterministic merge gate that evidence-backed auto-merge rests on.
**Researched:** GitHub docs, Troubleshooting required status checks: a job skipped by a conditional reports Success, and a dependent job skipped after a failed need may not block, fixed by always() with needs. pingdotgg/t3code ci.yml: one required aggregate Check job with a jq predicate over toJSON(needs). benord-labs/frink test-suite.yml: an if: always() + needs compare job. PRQL/prql#5809: an if: always() omnibus is not registered as a check run until its needs complete. oven-sh/bun: 12 of its last 40 merged PRs were red through a bypassed required check. test-report-summary artifacts and failed-step logs of main runs 37482683330, 37640531917, 37750541906, 37755327730, 37755348797 and 38042970754.
**Rejected:** (a) Requiring gate directly — LOSES: a job added later is unrequired until someone edits the ruleset, and nothing tells them to. (b) re-actors/alls-green — LOSES: a third-party action in the required check's trust path for a one-line jq predicate. (c) if: !cancelled() on the aggregate — LOSES: a cancelled run leaves it skipped, which GitHub reports to a required check as Success.
**Anchored-bet:** [BET]
**Revisit-when:** GitHub rulesets gain a native 'every job of this workflow' requirement, a job is added that is meant to be skipped on some events, or merges move to a merge queue (merge_group runs and strict up-to-date checks then apply).
**Scope:** .github/workflows/gate.yml
**Category:** self-host-release
**Source:** web · https://app.shortcut.com/benordlabs/story/5174
