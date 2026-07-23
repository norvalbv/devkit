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
