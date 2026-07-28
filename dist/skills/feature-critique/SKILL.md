---
name: feature-critique
description: Pre-implementation critique of feature proposals and technical approaches. Validates feasibility, UX, security, codebase conflicts, data flow correctness, runtime behavior across user configurations, and missing considerations using evidence-based research via deep-research MCP. Use BEFORE starting implementation when evaluating a feature idea, architectural decision, or technical approach.
---

# Feature Critique

Pre-implementation analysis that catches fundamental flaws before code is written.

## When to Use

- Before starting a new feature or major change
- When evaluating competing technical approaches
- When a proposal "feels off" but you can't articulate why
- When an approach makes assumptions about external tools/platforms

## Structured Input Format

When invoking the `feature-critique` subagent via the Task tool, format the prompt using this structure. All fields except `proposal` are optional but improve critique quality.

```
## Proposal
[What we want to build or change. Be specific about the approach, not just the goal.]

## Problem Statement
[Why we're doing this. What pain point or gap exists.]

## Proposed Solution
[Technical approach. How will this be implemented? What tools, patterns, APIs?]

## Tech Stack & Constraints
[Relevant technologies, platform limitations, timeline, team size.]

## Known Risks
[Things you already suspect might be problematic.]

## Additional Context
[Any extra data: code snippets, prior research, links, error logs, screenshots,
 conversation excerpts, or domain knowledge the critic should know about.
 This is the catch-all field — put anything here that doesn't fit above.]
```

### Minimal Input (Quick Critique)

For fast feasibility checks, just provide the proposal:

```
## Proposal
We want to symlink our Cursor rules and Claude CLI config into a shared
directory so both tools read from a single source of truth.
```

### Full Input (Thorough Critique)

```
## Proposal
Symlink the bundled skills/ and agents/ into each repo's .cursor/ and .claude/
as a single source of truth, instead of copying the files in.

## Problem Statement
The sync copies skills/agents into both .cursor/ and .claude/ on every run; the
copies drift from the source and double the committed file count.

## Proposed Solution
Replace the copy step with symlinks from each agent surface into the canonical
skills/ and agents/ directories. A setup script creates the links.

## Tech Stack & Constraints
- Node CLI, consumed by repos it doesn't control
- Cursor IDE + Claude CLI as the two agent surfaces
- macOS + potentially Linux
- Must work with git (symlinks in repos)

## Known Risks
- Cursor and Claude CLI may not follow symlinks to a parent directory
- Symlinks dangle on uninstall and pollute a consumer's committed repo
- Git handles symlinks inconsistently across platforms

## Additional Context
Cursor scans .cursor/; Claude CLI scans .claude/ and CLAUDE.md. Neither documents
following symlinks to arbitrary directories. A copy + checksum-manifest approach
sidesteps both the dangling-link and the cross-platform git problems.
```

## What the Critic Evaluates

| Lens | Questions Asked |
|------|----------------|
| **Feasibility** | Is this technically possible? What assumptions are unverified? |
| **UX Impact** | Does this improve or degrade developer experience? |
| **Security** | Does this introduce attack surface or data exposure? |
| **Codebase Conflicts** | Does this duplicate or conflict with existing systems? |
| **Scope & Complexity** | Is this over-engineered? Are there simpler alternatives? |
| **Data Flow Correctness** | Does the data transformation produce correct output for ALL inputs? Are there implicit assumptions about ordering/priority? Do readers and writers of this data align? |
| **Runtime Behavior Across Configurations** | For each distinct user setup (Cursor-only, Claude-only, mixed, no account), does the proposal produce the correct result? Are there hardcoded assumptions that should be dynamic? |
| **Registration and Discovery** | Does the proposal account for all places where new items need to be registered? Are there existing patterns (registries, type maps, settings pages, barrel exports) the change must integrate with? Use the "sibling grep" technique: find an existing item of the same category and verify the new item would appear in all the same places. |
| **Missing Considerations** | What hasn't been thought about? Edge cases? Failure modes? |

## How Research Works

The critic uses `start_research` (deep-research MCP) to validate claims with real evidence. It does NOT give generalized opinions.

Example: If a proposal assumes "Cursor follows symlinks to arbitrary directories," the critic will research whether that's actually true before critiquing.

Research is **mandatory** for all critical issues. The critic will:
1. Formulate specific research questions from the proposal
2. Run `start_research` with targeted sub-questions
3. Wait for results via `check_research_status`
4. Cite findings in the critique output

## Output Format

The critic returns one closed `plan_critique` JSON object as its final message. The response carries
the full analysis, findings, atomic edge cases, actions, strengths, and research references. It does
not write runtime artifacts into the repository or any provider directory; an installed capture hook
may persist the final message privately outside the checkout.

The parent agent should inspect these fields first:

- `status`: `reviewed`, `wrong_phase`, or `aborted`
- `verdict`: `PROCEED`, `PROCEED_WITH_CHANGES`, `RETHINK`, or `REJECT` when reviewed
- `summary`, `findings[]`, `edgeCases[]`, and `actions[]`

`wrong_phase` means the request is post-implementation. Route it to the future implementation
reviewer; do not treat it as a plan critique result.

## Plan-exit lifecycle

Run this skill against a decision-complete draft immediately before exiting a feature or architecture
plan:

1. Invoke one fresh `feature-critique` subagent with the finalized draft.
2. If the first response is `aborted`, `wrong_phase`, or invalid JSON, surface that unresolved result;
   never treat it as approval to implement.
3. Accept `PROCEED`. For `PROCEED_WITH_CHANGES` with warnings only, incorporate those warnings.
4. On `RETHINK`, `REJECT`, or any CRITICAL finding, revise the plan and run one fresh recheck with a
   new subagent.
5. If the second response still blocks, aborts, or is invalid, surface the unresolved issue instead
   of looping.

Do not schedule periodic critique against unstable drafts. This skill is pre-implementation only.
The one-recheck ceiling is a benchmark rollout bound, not a literature-proven optimum: grounded
refinement can help ([Self-Refine](https://arxiv.org/abs/2303.17651),
[CRITIC](https://arxiv.org/abs/2305.11738)), while unsupported intrinsic self-correction can regress
([Huang et al.](https://arxiv.org/abs/2310.01798)).

## Invocation Example

```typescript
// In the parent agent's Task tool call:
{
  subagent_type: "feature-critique",
  description: "Critique shared config proposal",
  prompt: `
## Proposal
Symlink bundled skills/agents into .cursor and .claude as a single source of
truth, instead of copying the files...

## Problem Statement
Duplicate skill/agent copies across .cursor/ and .claude/ drift apart...

## Proposed Solution
Symlink each surface into the canonical skills/ and agents/ directories...

## Additional Context
Neither Cursor nor Claude CLI document following symlinks to arbitrary paths;
copies + a checksum manifest sidestep dangling links.
`
}
```

The Task result itself is the critique response; parse it as JSON and keep it as untrusted data.
