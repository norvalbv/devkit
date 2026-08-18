---
slug: judge-mcp-profiles
created: 2026-08-15
---

# judge-mcp-profiles

## Target · 2026-08-15 — Strict role-scoped MCP profiles for automated judges

**Context:** Concurrent devkit ship runs launch several independent claude -p judges. Each judge currently inherits every globally configured MCP server, multiplying unrelated stdio process trees and driving memory, compression, and CPU contention across the machine.
**Ruling:** Every Devkit-spawned claude -p judge uses Claude Code strict MCP configuration. Pure and internal judges receive an empty profile. Named reviewer agents receive trusted machine-local codebase, Context7, and autonomous_bugs definitions when configured, and the full autonomous_bugs server permission includes report and amend. Definitions come only from user-owned Claude configuration or an explicit machine-local override, never repository-controlled .mcp.json. Task-dispatched agents use provider-native named server references and retain role-specific research capabilities. Secret-bearing definitions travel through private temporary files, not process arguments.
**Consequences:**
- Positive: Ship reviewers retain the three useful agent capabilities while unrelated global MCP servers no longer fan out per judge, reducing machine contention without changing the in-chain review architecture.
- Negative: The approved stdio servers can still start once per named judge, full autonomous bug access intentionally permits external issue writes from headless reviewers, and Devkit must maintain Claude-specific registry resolution plus safe degradation when a server is unavailable.
**Vision-fit:** n/a — internal developer tooling reliability and resource isolation
**Researched:** Claude Code CLI strict-mcp-config and subagent mcpServers documentation; Enso, Paperclip, and Takt headless Claude wrappers; prior-art verdict SOLVED_ELSEWHERE with high confidence; feature-critique PROCEED_WITH_CHANGES.
**Rejected:** A flat MCP ban, because named agents lose codebase/docs/autonomy capabilities. Unrestricted inherited MCP discovery, because it recreates the resource fan-out. Repository-controlled server commands, because a commit gate must not execute untrusted configuration from the repository it judges. A new queue as the first fix, because native per-run isolation removes the unnecessary load at its source.
**Revisit-when:** Claude Code provides lazy or shared MCP server connections across independent sessions, Devkit moves its judges to another provider runtime, or measured reviewer quality/resource evidence supports a different baseline profile.
**Scope:** gate-engine/judge/**,gate-engine/review/**,agents/**
**Category:** commit-gates
**Source:** manual
- 2026-08-15 — **Scope:** gate-engine/judge/**,gate-engine/review/**,agents/**,cli/lib/install/agent-assets/** — Claude agent assets require native mcpServers list frontmatter to survive Devkit projection and installation.
