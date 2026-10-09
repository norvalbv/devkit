---
slug: judge-context-explicit-only
created: 2026-10-09
---

# judge-context-explicit-only

## Target · 2026-10-09 — Gate judges see only the context devkit feeds them

**Context:** Claude-family judges ran in the consumer's cwd and Claude Code auto-loaded its CLAUDE.md as project memory, expanding @AGENTS.md imports plus the user's private ~/.claude/CLAUDE.md; codex judges loaded AGENTS.md as a project doc (copied into their scratch cwd on purpose). On a devkit ship conventions-reviewer blocked citing AGENTS.md:159, a working rule the agent-orientation-at-repo-root Target keeps out of the governing surface; it cost a full ship attempt and made verdicts depend on judge family and on whose machine ran the gate.
**Ruling:** Every gate judge, in both families, runs with ambient instruction loading off: claude judges get CLAUDE_CODE_DISABLE_CLAUDE_MDS=1 at the single judgeCliFor chokepoint, codex judges get -c project_doc_max_bytes=0 and no copied project docs. Rules reach a judge only through what the gate renders into its prompt, such as the GOVERNING CLAUDE.md block.
**Consequences:**
- Positive: The same diff gets the same rules under codex and claude and on every developer machine, so a block always traces to an input the gate chose; the documented AGENTS.md boundary holds; judge prompts stop paying tokens for unrelated memory.
- Negative: Correctness, completeness and other judges lose repo conventions they previously absorbed by accident from CLAUDE.md/AGENTS.md; any judge that needs repo rules must now receive them explicitly. A future Claude Code or codex release that renames these knobs silently reopens the leak until a probe catches it.
**Vision-fit:** n/a — internal tooling (gate trust in consumer repositories)
**Researched:** Probes on claude 2.1.294 and codex-cli 0.161 in the devkit repo (file_size rule present by default, absent with the knob); code.claude.com/docs/en/env-vars (CLAUDE_CODE_DISABLE_CLAUDE_MDS); openai/codex codex-rs/core/src/agents_md.rs (max_total == 0 returns None); ponytail benchmarks/agentic judge harness uses the same env var for the same reason; PR #846 grounds the rule half of conventions findings.
**Rejected:** (a) --setting-sources '' — loses user settings.json env and apiKeyHelper, breaking Bedrock/Vertex/helper auth. (b) --setting-sources user — still loads ~/.claude/CLAUDE.md, so verdicts stay machine-dependent. (c) --bare — never reads OAuth or keychain, breaking subscription auth. (d) Make AGENTS.md governing — contradicts agent-orientation-at-repo-root, which keeps directive working rules away from the blocking reviewer.
**Anchored-bet:** [BET]
**Revisit-when:** A judge is shown to need repo conventions it no longer receives (a reviewer recall drop traced to missing CLAUDE.md content), or Claude Code/codex rename or drop CLAUDE_CODE_DISABLE_CLAUDE_MDS / project_doc_max_bytes.
**Scope:** gate-engine/judge/codex/result.mts,gate-engine/judge/codex/workspace.mts
**Source:** web · sc-4857
