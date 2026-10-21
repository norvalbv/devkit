---
slug: follow-up-records-devkit-owned
created: 2026-10-21
---

# follow-up-records-devkit-owned

## Target · 2026-10-21 — devkit owns follow-up records and the only auto-start path

**Context:** Follow-up handling lived only as prompt text in one machine's Frink Flow (frink-work's Track Follow-ups step). An agent classified each deferred item and wrote description lines on a Shortcut story, but nothing validated those lines, nothing bounded follow-up chains, and the depth-1 and wait-in-the-queue rules were policy only. The prompt does not travel to the owner's other machines, so the same discipline could not be used there. About 0.8 follow-ups are filed per PR, about 13% get done, and 25 of the last 40 frink-work trigger stories were themselves follow-ups.
**Ruling:** Classification stays agent judgment. devkit's cli/lib/follow-up/ owns the record schema, parsing and the start decision. The record is the description lines on the child story (**Follow-up of:** sc-N · <PR url>, **Follow-up type:**, **Stack on:**), kept byte-compatible with their existing readers. devkit reaches Shortcut only through the machine's short CLI and holds no token. 'devkit follow-up start --parent <story>' is the only auto-start path: it starts nothing when the parent is itself a follow-up (title starts with [auto-start] or it carries **Follow-up of:**); a child qualifies only as an open builds-on follow-up of that parent that, when the parent had a PR, carries **Stack on:** with that PR's URL; at most one child per parent ever starts, the lowest qualifying id; it renames the child '[auto-start] <title>' and then assigns it, and a rerun either stops (an assigned [auto-start] child exists) or assigns an unassigned [auto-start] child without renaming. blocks-done and discovery follow-ups always wait for a human. Assignment is the start signal; the run then waits in the consumer's own queue.
**Consequences:**
- Positive: One follow-up record any agent on any machine with short can read; depth and breadth enforced in code rather than by a prompt; compute stays bounded by the queue the follow-up waits in; the discipline travels with a devkit install.
- Negative: Narrows the deliberate human gate on follow-ups (filed unowned so nothing starts) for one class only: depth-1 builds-on children, at most one per parent. Adds a dependency on the short CLI and a title prefix humans will see. A human edit to the description lines can make a child ineligible.
**Vision-fit:** n/a — internal tooling
**Researched:** Prior-art review (2026-10-21, verdict: genuine new work, narrowed) of tracker-driven coding-agent orchestrators and agent harnesses: follow-up relations live in the tracker and are enforced in orchestrator code; the agent decides while scripts perform the writes; spawn depth is a counter checked in code. A six-seat red-team review (6/6, verified) checked the design against devkit origin/main and the live frink-work Flow: 1540 recorded trigger payloads carry the story title and none carry labels, priority or custom fields.
**Rejected:** A devkit ledger under ~/.devkit (not readable from another machine); a PR-body block as the record (two follow-up paths have no PR); git trailers (unreadable from the triggering story); a Shortcut label, Priority or custom field as the marker (never present in update payloads); a workflow state as the marker (needs per-workspace setup); agent-started child runs (no depth bound); continuing the follow-up inside the parent run (bypasses the queue that bounds compute).
**Anchored-bet:** [BET]
**Revisit-when:** A Shortcut update webhook is shown to carry priority or a custom field; the owner's work tracker is not Shortcut; or auto-started follow-ups complete below the 13% baseline over 10 parents.
**Scope:** cli/lib/follow-up/**,cli/commands/follow-up/**
**Source:** collab · sc-7472
