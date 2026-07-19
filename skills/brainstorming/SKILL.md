---
name: brainstorming
description: "You MUST use this before any creative work - creating features, building components, adding functionality, or modifying behavior. Explores user intent, requirements and design before implementation."
---

# Brainstorming Ideas Into Designs

## Overview

Help turn ideas into fully formed designs and specs through natural collaborative dialogue.

Start by understanding the current project context, then ask questions one at a time to refine the idea. Once you understand what you're building, present the design in small sections (200-300 words), checking after each section whether it looks right so far.

## The Process

**Understanding the idea:**
- Check out the current project state first (files, docs, recent commits)
- Ask questions one at a time to refine the idea
- Prefer multiple choice questions when possible, but open-ended is fine too
- Only one question per message — if a topic needs more exploration, break it into multiple questions
- Focus on understanding: purpose, constraints, success criteria

**Exploring approaches:**
- Propose 2-3 different approaches with trade-offs
- Present options conversationally with your recommendation and reasoning
- Lead with your recommended option and explain why

**Presenting the design:**
- Once you believe you understand what you're building, present the design
- Break it into sections of 200-300 words
- Ask after each section whether it looks right so far
- Cover: architecture, components, data flow, error handling, testing
- Be ready to go back and clarify if something doesn't make sense

## After the Design

**Capture the decision (this is the decision-log's primary capture path — Capture A):**
When the settled design crosses the **two-clause road-not-taken criterion** — a *viable*
alternative was rejected AND the rationale is load-bearing (you'd want the *why* in 6 months) —
record it now, while the *why* is live in this conversation (it is never recoverable from the diff):
- Surface any prior ruling first: `node scripts/decisions/decisions.mjs list` — reuse an existing
  axis slug if this decision already has one (and surface that prior ruling *inside* the A/B you posed).
- Record: `node scripts/decisions/decisions.mjs add <slug> --ruling "..." --why "..." --rejected "..." --source brainstorm` (add `--new` for a new axis).
- See the `decisions` skill for the criterion, slug discipline, and supersession.

Do NOT author a new `docs/plans/` design doc — that store is deprecating in favour of `docs/decisions/`.

**Implementation (if continuing):**
- Create a decision-complete implementation plan.
- Immediately before presenting/exiting that plan, invoke one fresh `feature-critique` subagent with
  the finalized draft. If the first response is `aborted`, `wrong_phase`, or invalid JSON, surface it
  rather than treating it as approval. Apply warning-only `PROCEED_WITH_CHANGES` feedback. On
  `RETHINK`, `REJECT`, or any CRITICAL finding, revise and run one fresh recheck; if that pass still
  blocks, aborts, or is invalid, surface the unresolved issue instead of looping.
- Ask: "Ready to set up for implementation?"
- Create an isolated worktree for the work.

Do not run periodic critique against unstable drafts. Post-implementation review belongs to a
separate implementation reviewer; `feature-critique` returns `wrong_phase` for that request.

## Key Principles

- **One question at a time** — Don't overwhelm with multiple questions
- **Multiple choice preferred** — Easier to answer than open-ended when possible
- **YAGNI ruthlessly** — Remove unnecessary features from all designs
- **Explore alternatives** — Always propose 2-3 approaches before settling
- **Incremental validation** — Present design in sections, validate each
- **Be flexible** — Go back and clarify when something doesn't make sense
