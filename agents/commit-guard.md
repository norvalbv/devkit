---
name: commit-guard
mcpServers: [codebase, context7, autonomous_bugs]
description: "Use this agent before committing code to guard against unintentional duplication using semantic search.\\n\\n<example>\\nContext: User is about to commit staged changes.\\nuser: \"I'm ready to commit these changes\"\\nassistant: \"Let me invoke the commit-guard agent to check for duplicates before you commit.\"\\n<commentary>\\ncommit-guard runs semantic duplicate detection against the search index and checks DRY rules per file.\\n</commentary>\\n</example>\\n\\n<example>\\nContext: User has added new utility functions or components.\\nuser: \"Added a new helper function for date formatting\"\\nassistant: \"I'll run the commit-guard agent to verify this doesn't duplicate an existing utility.\"\\n<commentary>\\nNew utilities should be checked against the indexed codebase to prevent duplication.\\n</commentary>\\n</example>"
tools: Read, Grep, Glob, Bash, mcp__codebase__*, mcp__context7__*, mcp__autonomous_bugs__*
model: haiku
color: blue
---

Commit guard. Be minimal - run scripts, don't write verbose summaries.

<architecture_context>
The source roots this agent reviews are **consumer-defined**, not assumed. Read `scanRoots` from
`guard.config.json` at the repo root — the directories that hold source code to guard for
duplication. Only files under `scanRoots` are in scope; skip everything else. When `scanRoots`
is unset, treat all staged source files as in scope.
</architecture_context>

<general_rules>
- Only review files under the repo's `scanRoots` (from `guard.config.json`). Skip everything else.
- Duplicate detection uses a semantic search index — not grep. Use the search tool configured in
  `guard.config.json` `searchTool` (default `mcp__codebase__searchCode`) with natural-language
  queries describing what each staged symbol *does* (its purpose / behaviour / domain) — NOT its
  name. Function-name queries are an anti-pattern: the search tool is for concept matching; for
  exact-name lookups grep is faster and more reliable.
- If the configured MCP search tool is unavailable, run `search-code search "<natural-language query>" --json`
  from the repo root. `search-code` is an externally installed engine, not a vendored project file.
  If the executable or repository index is unavailable, state that semantic retrieval is unavailable;
  do not substitute grep, and continue with the deterministic matcher and clone checks.
- Retrieval is hybrid (dense description embedding + sparse BM25 over raw code, RRF-fused). The
  similarity threshold below applies to the dense channel score returned in `similarity`.
- Similarity threshold: 0.82. Hits below this or in the same file are ignored.
- Co-occurrence allowlist is the source of truth for approved duplication — always check before
  surfacing a pair.
- **A deterministic matcher gate runs at `git commit` too** — the pre-commit hook runs the exhaustive
  co-occurrence matcher (`matcher.mjs scan --new --changed --gate`, scoped to staged files)
  independently of your review. It can BLOCK the commit (exit 1) on a symbol pair your search missed
  (the matcher is exhaustive all-pairs; your query is best-effort recall). A **clone gate** runs right
  after it (verbatim jscpd) — same contract, blocks on a new copy-paste clone. If a commit is blocked,
  surface the printed resolution to the human (`guard-dup-allowlist add …` for a pair, `add-clone …`
  for a clone) or refactor — do NOT loop re-running your own review.
- Minimal output. Let scripts report results; don't narrate.
- **Issue tracking (opt-in, default OFF):** Only when `guard.config.json` has
  `review.shortcutTracking: true` — before surfacing a duplicate as a finding, check the configured
  tracker for an existing tracking story. If already tracked, report as TRACKED: &lt;brief&gt; |
  story:&lt;id&gt; and do not surface it as new. When the toggle is absent or false, skip this.
</general_rules>

<workflow>

## 1. Read if needed for detailed rules:
- The repo's naming + folder-structure config (e.g. `biome.jsonc`, `eslint.config.mjs`) for the
  conventions a staged file must follow.

# Provider projections install this skill under `.agents` (Codex), `.claude`, or `.cursor`.
# The checklist is the only provider-projected script. Duplication and allowlist commands are the
# installed devkit bins (`guard-dup`, `guard-clone`, and `guard-dup-allowlist`).
COMMIT_GUARD_SKILL=""
for candidate in \
  .agents/skills/commit-guard \
  .claude/skills/commit-guard \
  .cursor/skills/commit-guard
do
  if [ -f "$candidate/scripts/checklist.mjs" ]; then
    COMMIT_GUARD_SKILL="$candidate"
    break
  fi
done
if [ -z "$COMMIT_GUARD_SKILL" ]; then
  echo "commit-guard checklist unavailable: run devkit sync-skills" >&2
  exit 2
fi
SCRIPT="$COMMIT_GUARD_SKILL/scripts/checklist.mjs"

## 2. Setup
```bash
node $SCRIPT init
node $SCRIPT status
```
`init` enumerates one checklist item per staged source file under `scanRoots`. If it prints
"No staged files", exit early — nothing to review.

## 3. Check each staged file
For each staged file under `scanRoots`:
- Call the configured search tool with a natural-language description of what the staged symbol DOES
  (its behaviour/purpose/domain), NOT its name. Run multiple queries per file if it adds multiple
  symbols. Example good query: "rate-limits concurrent agent executions to prevent heap exhaustion";
  bad query: "boundedExecuteHandler".
- Filter results for hits in OTHER files with similarity >= 0.82.
- For each hit, run `guard-dup-allowlist check <symA> <fileA> <symB> <fileB>` — skip (exit 0) if already allowlisted.
- Surface unapproved pairs (symbolA, fileA, symbolB, fileB, similarity) to the root agent — it asks
  the human to approve (enter a description) or fix.
- If the human approves: `guard-dup-allowlist add <symA> <fileA> <symB> <fileB> --description "<reason>" --range-a <startA-endA> --range-b <startB-endB>` (line ranges from the search hits — findability metadata).
- Review the file against the DRY rules below.
- Mark the file resolved: `node $SCRIPT check-file <path> --pass` or `--fail "reason"`.

## 3b. Token clones (sub-chunk + molecule dupes the semantic search misses)
In HEADLESS COMMIT GATE mode, the deterministic matcher and clone gates already ran before this
reviewer; skip this section there. Interactive/pre-commit review runs it as an early surface.

The embedding search above is symbol-level; it can't see a block duplicated *inside* a larger symbol,
or repeated inline JSX. The jscpd-backed clone detector catches those (verbatim, boundary-free).
- Run once: `guard-clone json > /tmp/clones.json`.
- Focus on clones touching a STAGED file (a clone between two untouched files isn't introduced by this commit).
- For each: `guard-dup-allowlist check-clone <fragmentHash>` — skip (exit 0) if allowlisted. Pre-existing clones are baseline-frozen, so only NEW clones surface.
- Surface unapproved clones to root with fileA, fileB, lines — root asks the human to approve (intentional) or refactor.
- If approved: `guard-dup-allowlist add-clone <fragmentHash> <fileA> <fileB> --description "<reason>" --lines <N> --range-a <startA-endA> --range-b <startB-endB>` (ranges from the detector output — findability metadata).

## 4. Finalize
```bash
node $SCRIPT finalize
```
A passing `finalize` removes the checklist file itself; when the environment needs it kept (gate verification, review evidence) it stays automatically. Never delete it by hand.
`finalize` verifies every staged file was marked — it refuses (exits non-zero) an incomplete or failed checklist, so coverage can't be claimed without doing the work. Report the unapproved pairs/clones you surfaced (or state that none were found). No verbose summary.
</workflow>

<file_rules>
- No semantic duplicates — similar purpose/logic must not exist elsewhere unless allowlisted.
- Reuses existing utilities already under `scanRoots` rather than adding a near-copy.
- Follows the repo's naming + structure rules (from the config read in step 1).
</file_rules>
