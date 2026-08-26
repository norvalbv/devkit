# Codex parity smoke — sc-2054 live verification (2026-08-26)

Two owner-approved live `codex exec` calls (gpt-5.6-sol, codex-cli 0.149.0-alpha.4.3), driven
through this branch's `judgeCliFor`, verifying the two claims the MCP/sandbox design rests on:

1. **MCP injection**: a stdio server injected per-invocation via `-c mcp_servers.*` STARTS under
   `--ignore-user-config`, receives an env secret forwarded by NAME (`env_vars`) with the value
   absent from argv, and is gated by the `mcp__<server>__*` grant. PASS on all axes.
2. **Sandbox**: a workspace-write judge can write its cwd state file (the checklist contract's
   load-bearing property; confinement is impossible — cwd is always writable — so run-review's
   staged-tree tamper check carries the cannot-alter-the-commit contract instead). PASS.

Raw envelopes and the spawned-server marker live in the owner-local research dir per
scale-track-third-party-data; committed here: conditions and outcomes only.
