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
Import agents/hooks to a local frink directory as a single source of truth
for Cursor and Claude CLI configuration.

## Problem Statement
We maintain duplicate agent configs and hooks across .cursor/ and .claude/
directories. Changes in one don't propagate to the other.

## Proposed Solution
Create a canonical directory (e.g., frink-config/) and symlink from
.cursor/agents/ and .claude/ into it. Use a setup script to create links.

## Tech Stack & Constraints
- Cursor IDE (electron-based)
- Claude CLI
- macOS + potentially Linux
- Must work with git (symlinks in repos)

## Known Risks
- Cursor and Claude CLI may not follow symlinks
- Cursor may only scan its own .cursor/ directory
- Git handles symlinks inconsistently across platforms

## Additional Context
From Cursor docs: "Subagents are stored in .cursor/agents/ or ~/.cursor/agents/"
Claude CLI uses CLAUDE.md and .claude/ directory structure.
Neither tool documents support for arbitrary config directories.
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

The critic writes a **full report to file** and returns only a **compact summary** (~300 tokens) to the parent agent. This prevents context bloat and autocompaction issues.

### What the parent agent receives (~300 tokens):

```
CRITIQUE: .cursor/.feature-critique.md
VERDICT: RETHINK
FEASIBILITY: Not Feasible
CRITICAL_ISSUES: 2
WARNINGS: 3

SUMMARY: Symlink approach fails because neither Cursor nor Claude CLI follow
symlinks to arbitrary directories. The core problem (config duplication) is
real but needs a different solution.

ACTIONS:
- Research Cursor's --include flag for custom agent paths
- Consider a build-step that copies canonical configs to IDE directories
- Validate Claude CLI's CLAUDE.md include directive as alternative
```

### Where the full report lives:

`.cursor/.feature-critique.md` — a single file overwritten on each invocation. The parent agent reads it after receiving the compact summary. Gitignored.

## Edge-cases artifact path

The critic writes the edge-cases artifact to `.cursor/.edge-cases.json` by default. For parallel flows, put `EDGE_CASES_ID=<id>` at the **top** of the prompt (e.g. above a `---` separator); the critic will then write to `.cursor/.edge-cases-<id>.json` and set `flowId` in the artifact.

## Invocation Example

```typescript
// In the parent agent's Task tool call:
{
  subagent_type: "feature-critique",
  description: "Critique shared config proposal",
  prompt: `
## Proposal
Import agents/hooks to a local frink directory as a single source of truth...

## Problem Statement
Duplicate configs across .cursor/ and .claude/...

## Proposed Solution
Symlink from tool directories into a canonical frink-config/ directory...

## Additional Context
Neither Cursor nor Claude CLI document support for arbitrary config paths.
`
}
```

### Reading the full report after invocation:

```typescript
// The parent agent can read the full critique when needed:
// Read(".cursor/.feature-critique.md")
```
