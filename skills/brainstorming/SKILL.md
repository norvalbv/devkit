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
- **Find what has already been ruled on, before posing any options:** `guard-decisions query "<the
  topic>"` (skip silently if the decisions guard is not installed). If an axis already governs this
  fork, `guard-decisions show <slug>` and put its current ruling **inside** the options you pose — a
  settled question must be re-opened deliberately, never by accident. `list` is not a substitute: it
  dumps every axis instead of finding the relevant one, so it stops being readable the moment a repo
  has more than a handful.
- **Validate the problem before designing (step 0):** immediately after the decisions query, decide
  whether to invoke one fresh `prior-art` subagent with the problem statement (see the `prior-art`
  skill for the input format; pass the query's rulings as Settled Axes so they are not re-derived).
  The trigger predicate — written, not discretionary:
  - FIRE when the idea is problem-shaped AND proposes new machinery, a new boundary, or a new
    dependency (a bug/pain attributed to a dependency, a missing capability, a limit to work around).
  - FIRE UNCONDITIONALLY when the governing axis shows repeat patches: run
    `guard-decisions show <top-axis-slug>` and count `## Target ·` headings — ≥2 means this fork has
    been patched before, the exact signature of a frame that deserves interrogation.
  - SKIP trivial creative turns (a rename, copy tweak, single-component edit) with a one-line note.
  - SKIP with the note `Prior-art: skipped — no reachable research leg` ONLY when the LOCAL leg is
    dark too: no declared `research.referenceCheckouts` glob resolves, AND `gh auth status` fails,
    AND no web tool, AND no deep-research MCP. A resolved reference checkout is a reachable leg on
    its own — it is the first leg by rule and the one that decides these calls offline — so external
    darkness alone is never a reason to skip. (Under total darkness the consumer's own record is
    still readable, but the `guard-decisions query` above has just surveyed it.)
  The verdict is **advisory but must be acknowledged, never dropped**:
  - `SOLVED_ELSEWHERE` / `DISSOLVE_FRAME` → present the cited finding and pose the found
    alternative/reframe as the LEADING option among the 2-3 you offer.
  - `GENUINE_NEW_WORK` → proceed; carry the absence evidence into the plan's context. (Sanity check:
    if its own `legs` show a dark external leg or zero resolved checkouts, record it as
    `INSUFFICIENT_EVIDENCE` instead.)
  - `INSUFFICIENT_EVIDENCE` / `aborted` / invalid JSON → say "prior art unverified" and continue;
    never treat it as clearance or as a blocker.
  The eventual plan records one line — `Prior-art: <verdict> · followed | overridden: <reason> |
  unverified` (or the skip note) — and at plan-exit `feature-critique` receives a bounded 3-line
  summary only (verdict, framing, one citation), never the full JSON.
  Then RECORD the run. The subagent is dispatched through the Task tool, so no gate spawns it and
  no telemetry captures it otherwise — production prior-art is invisible in the dashboard while its
  bench runs are fully recorded. Pipe its raw JSON verbatim (quoted heredoc, so no JSON content can
  be reinterpreted by the shell), passing the SAME disposition you wrote in the plan line:

  ```
  guard-review record-agent prior-art --model opus \
    --disposition followed --reason "<one line>" <<'PRIOR_ART_JSON'
  {…the subagent's response, unmodified…}
  PRIOR_ART_JSON
  ```

  `--model` mirrors the `model:` frontmatter of `agents/prior-art.md` (read it rather than trusting
  this example); every flag is optional and an omitted one is left off the event, never guessed.
  Skip silently when `guard-review` is not on PATH — same idiom as the decisions query above. The
  command never blocks: it always exits 0 and no-ops without a telemetry sink. An override is a
  DISAGREEMENT label, not a ruling on who was right (the motivating Frink case is a root agent
  overriding the *correct* frame), so record what you disagreed with, never that the agent was wrong.
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

Run this section only when `.devkit/config.json` records `decisions` in `components.guards`. If the
guard is not selected, skip Capture A entirely: Devkit intentionally omits the decisions skill and
does not claim a decision-record authoring workflow for that repo.
When the settled design crosses the **two-clause road-not-taken criterion** — a *viable*
alternative was rejected AND the rationale is load-bearing (you'd want the *why* in 6 months) —
record it now, while the *why* is live in this conversation (it is never recoverable from the diff):
- Surface any prior ruling first: `guard-decisions list` — reuse an existing
  axis slug if this decision already has one (and surface that prior ruling *inside* the A/B you posed).
- Record: `guard-decisions add <slug> --target --context "..." --ruling "..." --consequences "..." --tradeoff "..." --vision-fit "..." --source brainstorm` (add `--new` for a new axis).
- See the `decisions` skill for the criterion, slug discipline, and supersession.

Do NOT author a new `docs/plans/` design doc — that store is deprecating in favour of `docs/decisions/`.

**Implementation (if continuing):**
- Create a decision-complete implementation plan.
- Immediately before presenting/exiting that plan, invoke one fresh `feature-critique` subagent with
  the finalized draft. If the first response is `aborted`, `wrong_phase`, or invalid JSON, surface it
  rather than treating it as approval. Apply warning-only `PROCEED_WITH_CHANGES` feedback. On
  `RETHINK`, `REJECT`, or any CRITICAL finding, you—the parent/root planning agent—revise the plan
  and run one fresh recheck by invoking a new critic; if that pass still blocks, aborts, or is
  invalid, surface the unresolved issue instead of looping.
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
