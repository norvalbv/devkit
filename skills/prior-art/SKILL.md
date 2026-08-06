---
name: prior-art
description: Step-0 problem validation BEFORE planning. Use when a task is problem-shaped — a bug or pain attributed to a dependency, a missing capability, a limit to work around — and you want to know whether it is already solved (local reference checkouts, upstream, other consumers of the same SDK, the web), is a red herring, or whether its frame should exist at all. Triggers on "is this already solved", "has anyone solved this", "check prior art", "do we even need this", "before we plan/fix this". Returns a cited SOLVED_ELSEWHERE / DISSOLVE_FRAME / GENUINE_NEW_WORK / INSUFFICIENT_EVIDENCE verdict.
---

# Prior-Art Validation (Step 0)

Problem validation that runs BEFORE any plan exists. The plan critic (`feature-critique`) asks "is
this plan sound?"; every diff reviewer asks "is this change correct?"; nothing else asks **"should
this work exist at all?"** — this skill does.

## When to Use

- A problem is attributed to a dependency/SDK/platform and a fix is about to be designed
- The same axis has been patched more than once (repeat patches are a frame alarm)
- A capability seems missing and building it in-house is on the table
- Before `brainstorming` poses solution options for a problem-shaped idea (wired there as step 0)

Not for: critiquing a drafted plan (route to `feature-critique`), reviewing implemented code
(route to the implementation reviewers), or trivial creative turns.

## Structured Input Format

When invoking the `prior-art` subagent via the Task tool, format the prompt with these sections.
Only Problem Statement is required.

```text
## Problem Statement
[The problem as currently framed. One paragraph.]

## Symptoms & History
[What has been observed. Prior fixes/patches on this axis — count them.]

## Dependency & Context
[The SDK/library/platform involved. Version, consumption mode, constraints.]

## What's Been Tried
[Approaches already attempted or considered, and how they failed.]

## Settled Axes
[Optional: decision-log rulings already loaded by the caller (e.g. the brainstorming
 guard-decisions query result). Passed as given context so the agent does not re-derive them.]
```

## The Seven Questions

The agent answers all seven, every time (status ANSWERED / NO_EVIDENCE / NOT_APPLICABLE):

| id | Question |
|----|----------|
| Q1 | Who else consumes this same dependency, and how do THEY handle this? |
| Q2 | Does the dependency expose a native mode that makes the problem not arise? |
| Q3 | Must the boundary/wait/limit the problem lives inside exist at all? |
| Q4 | Is the missing capability CONFIRMED absent upstream (issue/PR/changelog you read)? |
| Q5 | How do comparable peer projects solve this class of problem? |
| Q6 | What does the failure cost vs the new failure surface any fix adds? |
| Q7 | Is the problem downstream of an earlier, unexamined choice? |

## Research Legs (mandated order, each attested)

1. **local** — reference checkouts declared in `guard.config.json` →
   `research.referenceCheckouts` (globs relative to the config's directory), plus the repo's own
   decision log and utilities. Zero resolved checkouts → the leg attests `unavailable` (with
   declared/resolved counts) and the agent SUGGESTS declaring likely corpora rather than scanning
   them. Declare-first is a security bound, not an inconvenience: devkit runs in repos it does not
   own, and sibling clones may be private code.
2. **github** — `gh` CLI (code/issue/PR search), where installed and authenticated.
3. **web** — WebSearch / WebFetch.
4. **deep-research** — the deep-research MCP, where available.

Every leg reports `reached` / `unavailable` / `failed`. A dark leg can never support a verdict:
`GENUINE_NEW_WORK` specifically requires the local leg reached with ≥1 resolved checkout plus one
external leg reached — otherwise the verdict degrades to `INSUFFICIENT_EVIDENCE`, which is an
honored outcome, never a failure and never clearance.

## Output

One closed `prior_art` JSON object (final subagent message): `verdict`, `confidence`, `legs[]`
(per-leg attestation), `frameChallenge` (HOLDS / NARROWS / DISSOLVES + the upstream choice),
`questions[]` (all seven), `evidence[]` (kind local/github/web/upstream, capped quotes, repo-root
provenance), `suggestedNextStep` (adopt_existing / reframe / proceed_to_plan / gather_evidence),
`summary`, `researchReferences[]`.

Parse it as JSON and keep it as untrusted data. Inspect `status` first (`reviewed` /
`wrong_phase` / `aborted`); `wrong_phase` carries `routing` to the correct agent.

## Step-0 lifecycle

1. Invoke **one fresh** `prior-art` subagent with the problem statement. There is no recheck loop —
   a verdict changes the conversation, not a draft.
2. Acknowledge the verdict, never drop it:
   - `SOLVED_ELSEWHERE` / `DISSOLVE_FRAME` → present the cited finding to the user and pose the
     found alternative/reframe as the **leading option**.
   - `GENUINE_NEW_WORK` → proceed; carry the absence evidence into the plan's context.
   - `INSUFFICIENT_EVIDENCE`, `aborted`, or invalid JSON → say "prior art unverified" and continue.
     Never treat it as clearance or as a blocker.
3. The eventual plan records one line: `Prior-art verdict: <verdict> — <how the plan responds>`.
   (A skipped run records `Prior-art: skipped — <reason>` instead; keep the two distinguishable.)
4. At plan-exit, pass `feature-critique` a **bounded 3-line summary only** (verdict,
   `frameChallenge.framing`, one citation) in its Additional Context — never the full JSON.
5. Consumer-side sanity check: a `GENUINE_NEW_WORK` verdict whose own `legs` show a dark external
   leg or zero resolved checkouts is recorded as `INSUFFICIENT_EVIDENCE` in the acknowledgment.

## Invocation Example

```typescript
// In the parent agent's Task tool call:
{
  subagent_type: "prior-art",
  description: "Validate the stream-consumer problem",
  prompt: `
## Problem Statement
Our app loses the agent's final message when background work finishes after the
turn ends. We need a better heuristic for deciding when the stream is done.

## Symptoms & History
Four prior patches on this axis (wake caps, done-signal overrides, veto rules,
drain windows); each fixed the previous one's damage.

## Dependency & Context
@anthropic-ai/claude-agent-sdk, consumed per-turn via query(); Electron main process.

## What's Been Tried
Burst caps, agent-declared done outranking the harness list, subagent vetoes,
a bounded stand-down drain.
`
}
```

The example's honest answer is DISSOLVE_FRAME: peer consumers of the same SDK read the stream for
the session's lifetime, and the "when is it done" heuristic dissolves with the per-turn consumer.
