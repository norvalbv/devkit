# devkit — agent working rules

<project_overview>
devkit is a versioned developer toolkit: agent skills, shared configuration, and a portable gate
engine that a consumer repository installs and runs at commit time.

[`CLAUDE.md`](CLAUDE.md) is the routing document: where the reasoning behind devkit's architecture
lives (`docs/decisions/`), how to query it, and the premises that are hard to infer from any single
file. Read it first. This file carries the working rules for changing devkit itself.
</project_overview>

<pr_scope_rules>
<rule>Keep every PR limited to the requested scope and the smallest coherent implementation. Do not bundle opportunistic refactors, cleanup, or hardening.</rule>
<rule>Do not defer work required by the request's acceptance criteria or required for correctness.</rule>
<rule>When worthwhile out-of-scope work is discovered, create a separate Shortcut story with the `short` CLI before opening the PR.</rule>
<rule>Make each follow-up story self-contained: context, the problem, the desired outcome, acceptance criteria, and likely code and tests. Link it from the PR description.</rule>
<rule>Provide proof where possible. A performance change carries before and after benchmarks; a gate or reviewer change carries the run that shows the new verdict.</rule>
<rule>Aim for PRs under 500 LOC unless the bulk is tests or a greenfield addition. Over 500 LOC is scrutinised; over 1K LOC is usually rejected unless it is wholly new surface.</rule>
</pr_scope_rules>

<aphorism>
The Best Engineers Write Less Code.

Coding is expensive and time-consuming. Every feature carries ongoing costs, so it's a good skill to
know what not to build. Code needs to solve the right problem, otherwise it becomes a liability.
Great engineers are measured by how much value they create relative to the complexity they leave
behind, not by how much code they produce.
</aphorism>

<developer_direction>
"Do it good or don't do it at all."

devkit runs inside other people's repositories and blocks their commits. Judge every change from
that consumer's seat: a gate that false-blocks, a remedy that names the wrong command, or a
reviewer that is noisy costs trust in every repo that installs devkit.

If it's poor UX for the consumer or poor maintenance for devkit's developers, don't do it. Do not
over engineer.
</developer_direction>

<sources>
- Truth: `docs/decisions/` — the append-only decision log and the source of truth for *why*
  architectural choices were made, authoritative over commit messages and code comments. Query it
  before reversing a past call, using the retrieval command in `CLAUDE.md`. A *recorded* decision
  is not a completeness gap, and a proposal that contradicts a Target is a finding.
- Procedures: `skills/` — `skills/using-devkit/SKILL.md` (ship, review, doctor, upgrade),
  `skills/commit-gates/SKILL.md` (diagnosing a gate block), `skills/decisions/SKILL.md` (recording
  the why), `skills/structure-governance/SKILL.md` (placing a file).
- Shortcut: tickets, guidance, and work material.
- Research: arxiv papers (or alternatives) for greenfield areas.
</sources>

<search_tool_selection>
| Query shape | Tool |
|-------------|------|
| Exact identifier you can spell (`collectGoverningClaudeMd`, `packageDir`) | `grep` / `rg` |
| Error string from logs or console | `grep` / `rg` |
| File by name or path pattern | `find` / `Glob` |
| "where is X handled" / "what does Y do" | `mcp__codebase__searchCode` (semantic, paraphrase-tolerant) |

A pattern of three or more English words, or one that asks where, how, what or which, is a
semantic query: start with `searchCode`, then grep the exact identifier it surfaces.
</search_tool_selection>

<agent_model_selection>
When dispatching a subagent, rate the task's complexity 1-5 and map it to a model. Agents with a
pinned `model:` in their definition (`agents/`) keep their own pin.

| Complexity | Model | Examples |
|---|---|---|
| 1-2 — mechanical, read-only, single right answer | haiku | file or code lookup, `Explore`, status checks |
| 3 — some judgment, low cost if wrong | sonnet | routine review, summarizing a diff |
| 4-5 — ambiguous, high cost if wrong | opus | architecture critique, correctness or security review |
</agent_model_selection>

<rule_philosophy>
- Reduce fallbacks when appropriate
- Remove legacy code
- Keep code clean
- Test, always.
- Less code is better than code bloat; aim for fewer lines when performing a solution
</rule_philosophy>

<core_rules description="Critical rules that override all other guidance.">

<rule name="minimal_code" severity="EXTREME">
A true senior prioritizes minimal and clean code, not code bloat. Fewer lines are easier to
maintain and debug. When editing code, ask:
- Can this be done in less code?
- Can this bug be fixed by removing code instead of adding it? (fix the root cause, not a workaround)
- Does similar code already exist that can be reused?
</rule>

<rule name="documentation">
Keep documentation current. Remove outdated or conflicting content. Architectural *why* belongs in
the decision log (`docs/decisions/`), written through the `guard-decisions` CLI and
`skills/decisions/SKILL.md` — direct edits to records are declined by a pre-edit hook.
</rule>

<rule name="published_versions_are_contracts" severity="CRITICAL">
Unlike an unlaunched app, devkit has consumers pinned to published tags. A breaking change to a
command, config key, or synced asset needs a migration path (`devkit migrate`) rather than a silent
break, and a published tag is never re-pointed
(`docs/decisions/published-version-tags-immutable.md`). Internal code with no consumer surface has
no legacy to support: refactor it with a full migration.
</rule>

<rule name="is_this_needed">
Always question whether something is *truly* needed.
- Needed *now*? Do it.
- Needed in the future? Create a ticket.
- Not needed? Bin it. Don't add features just because they're interesting.
</rule>

<rule name="dont_reinvent_wheel" severity="EXTREME">
For any well-solved domain (parsing, validation, process spawning, glob matching, git plumbing),
prefer established libraries over custom implementations. Before building custom logic, search for
and evaluate existing options. Before extending existing custom code, check whether replacing it
with an established solution is the better path; prefer a ticket to "investigate and adopt X" over
adding more custom code.
</rule>

<rule name="research_is_key" severity="EXTREME">
Never make assumptions. When brainstorming, stuck, or starting a new feature or bug, research:
the decision log, arxiv papers, the source of the tools devkit wraps, or the web.
</rule>

<rule name="critique_before_plan">
In plan mode, get a critique of the plan from the feature-critique agent (`agents/feature-critique.md`)
and apply the changes that hold up. If the agent isn't available, stop and tell the user.
</rule>

<rule name="decisions_source_of_truth" severity="HIGH">
A decision is an **epic, not a patch-note** — record the durable cross-cutting target, not "X broke
so I did Y".
- **Before** a road-not-taken architectural choice (a viable alternative that will still be
  load-bearing in six months): query the log and surface any prior Target in the options you pose.
  Never silently flip a past call.
- **After** it settles: record a Target if a product and engineering team would make it an epic; a
  local implementation step is a `--note`. Append, never mutate or delete.
- `guard-decisions detect --gate` blocks an unrecorded decision; `guard-decisions check-alignment
  --gate` blocks code that contradicts a scoped Target.
</rule>

<rule name="avoidance_of_nested_utilities">
Code is chunked per function for semantic search. Nested functions get lost inside their parent, so
move utilities to module scope where possible.
</rule>

<rule name="future_protection">
Write code, tests and comments that people and agents can understand years from now. A comment that
cites "the EC1 edge case we talked about", a Shortcut ticket, or a gitignored local doc means
nothing to a later reader. Write for an open-source contributor with no access to local context.
</rule>

<rule name="file_size">
`guard.config.json` caps source files at 500 lines and test files at 2000; oversized files are
grandfathered shrink-only. When shrinking a file below its ratchet, move whole functions, and move a
function's tests alongside it. `guard-size preflight` previews the real ceiling before a ship.
</rule>

</core_rules>

<workflows>

<workflow name="pre_commit_review" severity="CRITICAL">
Commits are gated automatically by the self-hosted pre-commit hook — devkit dogfoods its own gates.
Do not invoke reviewers, run approval scripts, or touch marker files by hand. Write the code and
commit (via `devkit ship` on a protected branch); react only when a gate blocks: read the finding,
fix it, re-commit. Every bypass needs the user's explicit OK.

Gate diagnosis and one-run controls: `skills/commit-gates/SKILL.md`. Shipping mechanics:
`skills/using-devkit/SKILL.md`.
</workflow>

<workflow name="autonomous_bug_reporting">
The `autonomous_bugs` MCP is a low-interruption escalation path for friction that blocks autonomous
work — not a general bug tracker. The general policy lives in the user-scope Claude instructions;
what is devkit-specific:
- **Search first** with `project: "devkit"`. An existing report or story means reference its ID,
  not a second report.
- **All three attestations must be honestly true**: `issue_remains_unresolved`,
  `outside_assigned_task`, `not_caused_by_agent`.
- **In scope:** gates that fail silently, worktree or ship breakage, MCP or indexer outages,
  capabilities you had to work around. Never your own bugs, expected gate failures, or anything
  already fixed this task. Never include credentials or tokens.
</workflow>

<workflow name="diff_coverage">
To measure a diff against a coverage bar, run `bun run devkit coverage-run --changed`. It runs the
CLI from source and prints a per-file table for the files changed since the remote default branch.
Fetch first; `--changed=<ref>` picks another base. `skills/testing/SKILL.md` covers reading a low
number.
</workflow>

</workflows>
