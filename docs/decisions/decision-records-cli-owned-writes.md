---
slug: decision-records-cli-owned-writes
created: 2026-07-22
---

# decision-records-cli-owned-writes

## Target · 2026-07-22 — Decision records are authored through the decisions capability

**Context:** Append-only decision records were protected only at commit time and by agent instructions, so any Claude or Cursor session with native edit tools could silently rewrite or delete the architectural why-store before the commit gates saw it. Repositories could also receive the decisions playbook without selecting its enforcement guard, leaving agents taught to rely on a governance capability the repo had not adopted.
**Ruling:** Decision records are a guard-owned capability: selecting the decisions guard installs a native pre-edit deny hook on every selected agent surface, and selecting skills projects the decisions playbook only while that guard remains enabled. Agents author and correct records through the guard-decisions CLI, whose draft amendment path may replace only the newest uncommitted entry; committed history remains append-only.
**Consequences:**
- Positive: Consumers that adopt decisions receive one coherent workflow: agents cannot accidentally mutate the why-store through native file tools, the instructions they see match the enforcement actually installed, guard removal prunes both policy and playbook, and legitimate draft corrections retain a sanctioned atomic path.
- Negative: Every native agent write/delete tool call pays one small local hook process when its matcher fires; hook and skill manifests become guard-sensitive; shell, MCP, human, and OS-level writes remain outside v1, so this prevents normal agent accidents rather than forming a hostile security boundary.
**Vision-fit:** n/a — internal governance tooling
**Researched:** Devkit hook/manifest lifecycle and current Anthropic Claude Code and Cursor preToolUse denial contracts were inspected during the design.
**Rejected:** Instruction-only protection — INSUFFICIENT: agents can forget or override prose and the mutation occurs before commit review. Heuristic shell-command parsing — UNRELIABLE: scripts, variables, and indirection make complete write detection impossible. OS-level read-only permissions — DISPROPORTIONATE: they also block humans and the approved CLI and require a privileged unlock protocol.
**Anchored-bet:** [BET]
**Revisit-when:** Claude and Cursor both provide declarative path-scoped write denials that cover native, shell, and MCP mutations, or Devkit adopts an authenticated filesystem broker that can distinguish approved CLI writes from arbitrary agent processes.
**Scope:** agents-hooks/**,cli/**,gate-engine/decisions/**,skills/brainstorming/**,skills/decisions/**
**Source:** brainstorm

## Target · 2026-09-14 — Decision records are authored through the decisions capability

**Context:** Append-only decision records were protected only at commit time and by agent instructions, so any Claude or Cursor session with native edit tools could silently rewrite or delete the architectural why-store before the commit gates saw it. Repositories could also receive the decisions playbook without selecting its enforcement guard, leaving agents taught to rely on a governance capability the repo had not adopted.
**Ruling:** Decision records are a guard-owned capability: selecting the decisions guard installs a native pre-edit deny hook on every selected agent surface, and selecting skills projects the decisions playbook only while that guard remains enabled. Agents author and correct records through the guard-decisions CLI, whose draft amendment path may replace the newest uncommitted note, or the newest uncommitted Target with the draft notes under it kept byte-for-byte; committed history remains append-only.
**Consequences:**
- Positive: Consumers that adopt decisions receive one coherent workflow: agents cannot accidentally mutate the why-store through native file tools, the instructions they see match the enforcement actually installed, guard removal prunes both policy and playbook, and legitimate draft corrections retain a sanctioned atomic path that survives the notes an author records under a fresh Target.
- Negative: Every native agent write/delete tool call pays one small local hook process when its matcher fires; hook and skill manifests become guard-sensitive; shell, MCP, human, and OS-level writes remain outside v1, so this prevents normal agent accidents rather than forming a hostile security boundary. Reaching past the tip also costs two new refusals (a stray heading in the Target's span, a dropped optional field warning) to keep the replacement lossless.
**Vision-fit:** n/a — internal governance tooling
**Researched:** Devkit hook/manifest lifecycle and current Anthropic Claude Code and Cursor preToolUse denial contracts were inspected during the design. sc-2711 added git commit --fixup=amend as the model for correcting an unpublished non-tip entry.
**Rejected:** Instruction-only protection — INSUFFICIENT: agents can forget or override prose and the mutation occurs before commit review. Heuristic shell-command parsing — UNRELIABLE: scripts, variables, and indirection make complete write detection impossible. OS-level read-only permissions — DISPROPORTIONATE: they also block humans and the approved CLI and require a privileged unlock protocol. Delete-and-replay of the axis file — UNVERIFIED: nothing checks the rebuilt record against the original.
**Anchored-bet:** [BET]
**Revisit-when:** Claude and Cursor both provide declarative path-scoped write denials that cover native, shell, and MCP mutations, or Devkit adopts an authenticated filesystem broker that can distinguish approved CLI writes from arbitrary agent processes.
**Scope:** agents-hooks/**,cli/**,gate-engine/decisions/**,skills/brainstorming/**,skills/decisions/**
**Source:** brainstorm
**Evidence-change:** sc-2711: the tip-only limit was measured against the workflow it governs and does not serve the invariant it protects. A ship gate invalidates a Ruling only AFTER its convergence notes exist, so tip-only amendment forced three delete-and-replay cycles of one record in a single run. The HEAD-prefix proof alone establishes that an entry is uncommitted, and HEAD's entries are a contiguous prefix, so a draft Target's trailing entries are drafts too.
