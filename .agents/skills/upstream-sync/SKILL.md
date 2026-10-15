---
name: upstream-sync
description: Sync upstream changes from 1code into frink. Linear commit-by-commit review and merge workflow. Use when the user wants to pull in new features from the 1code upstream repo, sync with upstream, or review what 1code has shipped recently.
---

# Upstream Sync

Syncs changes from the [1code](https://github.com/21st-dev/1code) upstream repo into frink. Walks commits linearly, one at a time. You decide accept or skip — hash advances either way. Large commits support **file-level partial accept/reject**.

## Architecture

```
1code (upstream)
  │
  ├── Small commit: Review Agent → You decide → Merge Agent → Guard + Verifier (parallel)
  │
  └── Large commit (chunked):
        review-init → Parallel Reviewer Chunks (max 4) → review-merge-chunks
          → Validation loop (re-invoke incomplete) → You decide
          → review-workgroups → Sequential Merger per Workgroup
          → tsc once → Guard + Verifier (parallel)
```

## State

Tracked in `.upstream-sync.json` at project root:

```json
{
  "lastSyncedHash": "09a6880...",
  "lastSyncDate": "2026-02-10T00:00:00Z",
  "skippedCommits": [],
  "appliedCommits": [],
  "partialCommits": []
}
```

- `appliedCommits` — commits fully accepted (all files)
- `skippedCommits` — commits fully skipped
- `partialCommits` — commits where some files were accepted and others rejected; records `accepted` and `rejected` file lists for audit

## Partial Accept (File-Level)

For large commits (6+ files, multiple features), the reviewer writes `.upstream-sync-review.json` with a per-file breakdown. The user accepts/rejects individual files. Only accepted files are merged.

### Review File Schema

```json
{
  "commit": "<hash>",
  "subject": "<subject>",
  "message": "<full commit body>",
  "reviewedAt": "<ISO timestamp>",
  "stats": { "additions": N, "deletions": N, "filesChanged": N },
  "chunks": [
    { "id": 1, "files": ["src/a.ts", "src/b.ts"], "lines": 850 }
  ],
  "files": [
    {
      "id": 1,
      "path": "src/path/to/file.ts",
      "additions": N,
      "deletions": N,
      "chunk": 1,
      "summary": "Terse 1-line description",
      "context": "2-3 sentences: what, why, impact-if-skipped.",
      "inFrink": "Full / Superseded / Partial / No",
      "conflictRisk": "Low / Medium / High",
      "status": "pending"  // "pending" | "accepted" | "rejected" | "deferred"
    }
  ]
}
```

The `chunks` array and per-file `chunk` field are only present when created by `review-init`. The merger, guard, and verifier agents ignore these fields — they only read `path` and `status`.

All files default to `"pending"` — user must explicitly accept or reject each file using `review-accept`/`review-reject` script commands.

### Baseline Strategy

When a commit is partially accepted, `1code/` is updated per-file:
- **Accepted files**: updated to the new upstream commit state
- **Rejected files**: set to the pre-commit state (`git -C 1code show <hash>~1:<file>`)

`lastSyncedHash` always advances to the full commit hash.

**Caveat**: The `1code/` directory HEAD may not match `lastSyncedHash` for files never touched by the merger. `frink-delta` works per-file (`diff -u 1code/<path> src/<path>`), so cross-file consistency is not required.

## Workflow

### Upstream clone path

The sync scripts run `git` in a **separate checkout** of [1code](https://github.com/21st-dev/1code) (baseline for diffs and pending commits). Resolution order:

1. **`FRINK_ONECODE_DIR`** — use this path if set
2. **`cloned-projects/1code`** — if `cloned-projects/1code/.git` exists
3. **`1code`** — default fallback

Manual commands and subagents should use `git -C <resolved-path>` instead of assuming `./1code`.

### Prerequisites

```bash
# Upstream remote must exist
git remote -v | grep upstream
# If not: git remote add upstream https://github.com/21st-dev/1code.git

# Fetch latest
git fetch upstream
```

### Script Commands

```bash
SCRIPT=".cursor/skills/upstream-sync/scripts/sync.mjs"

node $SCRIPT status                      # Show current hash, pending commits count
node $SCRIPT list                        # List all pending commits (hash + subject)
node $SCRIPT show <hash>                 # Show full diff for a specific commit
node $SCRIPT show <hash> --chunk N       # Show diff filtered to files in chunk N
node $SCRIPT frink-delta <hash>          # Show frink vs baseline diffs for files in a commit
node $SCRIPT frink-delta <hash> --chunk N # Frink delta filtered to files in chunk N
node $SCRIPT check-size <hash>            # Check commit size → Path A or Path B
node $SCRIPT accept <hash>               # Record commit as accepted, advance hash
node $SCRIPT accept <hash> --review-file # Record partial accept from review file
node $SCRIPT skip <hash>                 # Record commit as skipped, advance hash
node $SCRIPT review-init <hash>          # Pre-populate review JSON with all files, IDs, chunks
node $SCRIPT review-init <hash> --budget N # Set lines-per-chunk budget (default 950)
node $SCRIPT review-merge-chunks         # Merge chunk temp files into main review JSON
node $SCRIPT review-workgroups            # Group accepted files into merger workgroups
node $SCRIPT review-workgroups --budget N # Set lines-per-workgroup (default 950)
node $SCRIPT review-show                 # Pretty-print current review file status
node $SCRIPT review-accept <ids>         # Set files by ID to "accepted" (comma-separated)
node $SCRIPT review-reject <ids>         # Set files by ID to "rejected" (comma-separated)
node $SCRIPT review-defer <ids>          # Set files by ID to "deferred" (comma-separated)
node $SCRIPT review-accept-all           # Set all files to "accepted"
node $SCRIPT review-reject-all           # Set all files to "rejected"
node $SCRIPT review-defer-all            # Set all files to "deferred"
node $SCRIPT review-clean                # Remove review + chunk temp + workgroup files
node $SCRIPT reset                       # Reset state (dangerous — prompts confirmation)
```

### Step-by-step (per commit)

**IMPORTANT**: Only run `status` and `list` yourself. Do NOT run `show` or `frink-delta` before invoking the reviewer — the reviewer subagent runs those itself. Running them here duplicates large diffs into your context and wastes tokens.

**1. Check status and determine commit size:**

```bash
node $SCRIPT status
# Note the next pending commit hash

node $SCRIPT check-size <hash>
# Output: SMALL (3 files, 247 lines) → Path A (standard review)
# or:     LARGE (52 files, 5052 lines) → Path B (chunked review)
```

**2. Route based on commit size:**

- **Small commit** (under ~950 total lines changed AND fewer than 6 files): → go to **Path A (Standard Review)**
- **Large commit** (950+ total lines changed OR 6+ files): → go to **Path B (Chunked Review)**

When in doubt, use Path B. It works for small commits too (creates a single chunk).

---

### Path A: Standard Review

For small, focused commits that fit in a single reviewer's context.

1. Invoke **upstream-sync-reviewer** agent with the commit hash → it runs `show` and `frink-delta` itself
2. User decides: accept, skip, or partial accept
3. If **skip**: run `node $SCRIPT skip <hash>` (also run `review-clean` if a review file exists)
4. If **full accept**:
   - Invoke **upstream-sync-merger** → applies changes
   - Invoke **upstream-sync-guard** and **upstream-sync-verifier** in **parallel**
   - Run `node $SCRIPT accept <hash>`
   - Run `node $SCRIPT review-clean` (if the reviewer created a review file)
5. If **partial accept** (reviewer wrote a review file):
   - User resolves files via `review-accept <ids>` / `review-reject <ids>`
   - **ALL files must be resolved (no "pending") before proceeding**
   - Invoke **upstream-sync-merger** → applies only accepted files
   - Invoke **upstream-sync-guard** and **upstream-sync-verifier** in **parallel**
   - Run `node $SCRIPT accept <hash> --review-file`
   - Run `node $SCRIPT review-clean`

---

### Path B: Chunked Review (large commits)

For commits with large diffs that would overwhelm a single reviewer agent. This is the primary path for any commit with 950+ lines or 6+ files.

**Phase 1 — Initialize and review:**

1. Run `node $SCRIPT review-init <hash>` (optionally `--budget N`, default 950)
   - Pre-populates `.upstream-sync-review.json` with ALL files as `"pending"`, globally unique IDs, and chunk assignments
   - Output: "Pre-populated 52 files in 4 chunks (budget: 950). Invoke reviewer with --chunk 1..4"

2. Issue ALL reviewer Task calls in a **single message** (one per chunk, max 4 concurrent):
   ```
   Task: upstream-sync-reviewer — "Review commit <hash> --chunk 1. Chunk manifest: [full file list with chunk IDs]"
   Task: upstream-sync-reviewer — "Review commit <hash> --chunk 2. Chunk manifest: [full file list with chunk IDs]"
   Task: upstream-sync-reviewer — "Review commit <hash> --chunk 3. Chunk manifest: [full file list with chunk IDs]"
   Task: upstream-sync-reviewer — "Review commit <hash> --chunk 4. Chunk manifest: [full file list with chunk IDs]"
   ```
   For >4 chunks: issue first 4 in one message, wait for completion, then issue remaining.

   Each reviewer writes to `.upstream-sync-chunk-<hash7>-N.json` temp file (NOT the main review JSON).

3. Run `node $SCRIPT review-merge-chunks` to combine chunk findings into the main review JSON.

4. **Validation loop:** Check the merge output. If incomplete files are reported (null summary/context), re-invoke the reviewer for those specific chunks. Repeat until all files are complete.

5. Run `node $SCRIPT review-show` and present the grouped recommendation table to the user.

**Phase 2 — User decides:**

6. User accepts/rejects/defers files using script commands:
   - `node $SCRIPT review-accept 1,2,3` / `node $SCRIPT review-reject 4,5` / `node $SCRIPT review-defer 6,7`
   - `node $SCRIPT review-accept-all` / `node $SCRIPT review-reject-all` / `node $SCRIPT review-defer-all`
   - **Deferred** = useful but depends on future work (e.g. Phase 10); recorded in audit trail, skipped by merger
   - **ALL files must be resolved (no "pending") before proceeding** — deferred counts as resolved

**Phase 3 — Merge with workgroups:**

7. Run `node $SCRIPT review-workgroups` → groups accepted files into bounded workgroups
8. Invoke **upstream-sync-merger** sequentially per workgroup, starting with workgroup 1 (shared deps):
   - Read `.upstream-sync-workgroups.json` for the file list per workgroup
   - Invoke merger with: "Process workgroup N for commit <hash>: files src/a.ts, src/b.ts"
   - Wait for workgroup to complete before starting the next
9. Run `npx tsc --noEmit` once after ALL workgroups complete — fix any issues
10. Update `1code/` baselines for **rejected files** (workgroups only contain accepted files):
    ```bash
    # For each rejected file that existed before this commit:
    cd 1code && git checkout <hash>~1 -- <rejected-file> && cd ..
    # For rejected NEW files (didn't exist before):
    cd 1code && git rm -f <rejected-new-file> && cd .. 2>/dev/null || true
    ```

**Phase 4 — Verify and finalize:**

11. Invoke **upstream-sync-guard** and **upstream-sync-verifier** in **parallel** (both Task calls in one message)
12. Run `node $SCRIPT accept <hash> --review-file` → records partial commit in audit trail
13. Run `node $SCRIPT review-clean` → removes all ephemeral files

---

### Chunked review reference

**Chunk temp file schema** (written by each parallel reviewer):
```json
{
  "commit": "<hash>",
  "chunkId": N,
  "files": [
    { "path": "src/foo.ts", "summary": "...", "context": "...", "inFrink": "No", "conflictRisk": "Low" }
  ]
}
```

Temp filenames include commit hash prefix: `.upstream-sync-chunk-fc32ba9-1.json`

**Key safety:**
- All files exist as `"pending"` from the start — `accept --review-file` blocks if any files are still pending
- `review-merge-chunks` validates completeness — null summary/context fields are flagged for re-invocation
- Temp files are NOT deleted during merge — safe for idempotent re-runs
- `review-clean` removes everything (review JSON, chunk temps, workgroups JSON)

**Edge cases:**
- Small commits under budget: `review-init` creates a single chunk — still use `--chunk 1` so the reviewer writes a temp file
- Chunks can be reviewed in any order — each writes its own temp file
- Re-invoking the reviewer for the same chunk overwrites the same temp file — idempotent
- Reviewer failure: `review-merge-chunks` detects missing chunks and reports them for re-invocation

## Accept / Reject / Defer Decision Framework

The correct framework when evaluating every file is:

> **"Is this feature/fix valuable for Frink's UX, architecture, or stability?"**

This is the **only** question that matters. Apply it as follows:

**Accept** when:
- The change improves Frink (bug fix, UX improvement, stability, new useful feature)
- Even if the file is heavily diverged — the merger handles it
- Even if the file doesn't exist in Frink yet — the merger creates it or adapts it
- Even if conflict risk is High — that's information, not a rejection reason

**Reject** only when:
- The change has zero value for Frink (version bump, 1code-only config, upstream deletes something Frink needs)
- Accepting would actively break or regress Frink (e.g. accepting deletes a Frink migration)

**Defer** when:
- The feature IS worthwhile, but the upstream file maps to a *different* Frink component (e.g. upstream changed `AgentsSidebar` but Frink uses `UnifiedSidebar` — the feature belongs there instead)
- The feature depends on Frink work not yet done
- Deferred items MUST be written to `todos/` by the root agent

**Never auto-reject because:**
- A file is diverged (even +2000/-5000 lines)
- The file doesn't exist in Frink
- The conflict risk is High
- The upstream pattern doesn't perfectly match Frink's architecture

**Migration files special case:** If upstream deletes a migration Frink still needs → reject (keep Frink's). If upstream modifies a migration at a different path in Frink → reject the file but add a manual-port todo.

## Presenting Review Results to the User

After the reviewer returns, the root agent must present a **grouped recommendation table** — not a raw file list. Group files by action and feature, not by ID order.

### Format

Example:

**Accept**
| IDs | Feature | What it does |
|-----|---------|-------------|
| 13 | Plan refetch fix | Uses `subChatId` instead of `parentChatId` — bug fix |
| 20, 22 | Open in new window | Adds "Open in new window" to context menu and sidebar |

**Accept only as a group (all or none)**
| IDs | Feature | What it does |
|-----|---------|-------------|
| 5, 10, 24, 27, 28 | VS Code theme import | Full dependency chain for importing external themes |

**On the fence**
| IDs | Feature | What it does |
|-----|---------|-------------|
| 14 | Image drop handling | Useful but touches heavily diverged file |

**Reject**
| IDs | Feature | Why reject |
|-----|---------|-----------|
| 1 | Version bump | Frink has own versioning |
| 2, 6, 7, 9 | Multi-window wiring | Already diverged in frink |
| 11, 12, 23 | Window-scoped atoms | Already superseded in frink |

### Rules

- **Group related files** — if 3 files all serve "multi-window wiring", list them on one row, not three
- **Name the feature** — not the file. "Plan refetch fix" not "active-chat.tsx change"
- **Explain why** — accept rows get "what it does", reject rows get "why reject"
- **Dependency chains** — if files must be taken together, put them in an "all or none" group
- **On the fence** — use sparingly for genuinely borderline cases (useful but risky)
- **Keep it scannable** — the user should be able to decide in under 60 seconds

## Agents

| Agent | Purpose | When | Orchestration |
|-------|---------|------|---------------|
| `upstream-sync-reviewer` | Summarizes commit, writes chunk temp files | Every commit | **Parallel** (one per chunk, max 4) |
| `upstream-sync-merger` | Applies diff + resolves conflicts (respects review file) | On accept | **Sequential** per workgroup |
| `upstream-sync-guard` | Verifies no frink code removed, rejected files untouched | After merge | **Parallel** with verifier |
| `upstream-sync-verifier` | Read-only check accepted changes applied correctly | After guard | **Parallel** with guard |

## Guard Agent — False Positive Prevention

The guard uses a **3-step test** before flagging a removal:

1. **Is it upstream code?** — Check if the line exists in the `1code/` baseline. If yes, it's an expected upstream change → not a problem.
2. **Was it moved or refactored?** — Search the added lines for equivalent functionality (extracted helper, new component, logic replacement). If found → false positive, not a real loss.
3. **Is it truly gone?** — Only flag if the functionality cannot be found anywhere in additions or existing codebase.

Common false positives to ignore:
- Helper functions extracted to shared files (e.g. `getFileName` → `file-list-item.tsx`)
- Inline code wrapped in a new component (e.g. `WidgetCard+PlanSection` → `PlanWidget`)
- String matching replaced with mode/enum logic (e.g. `"Build plan"` → `isPlanMode`)

## Verification Script

After the guard agent runs, always run the deterministic verification script:

```bash
node .cursor/skills/upstream-sync/scripts/verify-merge.mjs --verbose
```

This script programmatically checks every frink-specific addition (lines frink added vs the fork point) still exists after the merge. It handles:
- **Modified lines** — tokens still present but line changed (e.g. expanded type union)
- **Moved code** — functionality relocated to a different staged file
- **Import changes** — filtered out as noise
- **Review file awareness** — when `.upstream-sync-review.json` exists, only verifies accepted files

Only lines that are truly gone from the entire codebase are flagged. A handful of false positives may remain for lines upstream intentionally changed — use judgement.

## Key Rules

- **Always advance hash** — skip or accept, never leave a commit in limbo
- **One commit at a time** — no batching, no grouping
- **Guard agent is mandatory** after every merge — frink-specific code must be preserved
- **Work on a sync branch** — create `sync/upstream-YYYY-MM-DD` before starting
- **1code/ directory** is the baseline reference — updated per-file after each accepted commit
- **Review file is optional** — only created for large commits (6+ files) or when the user requests granularity
- **Parallel reviewers** — for large commits, issue all reviewer Task calls in one message (max 4 concurrent)
- **Sequential merger workgroups** — for reliability, merger processes workgroups one at a time (shared deps first)
- **Parallel guard + verifier** — issue both Task calls in one message after all workgroups complete

## Reference Paths

- Upstream remote: `upstream` (https://github.com/21st-dev/1code.git)
- Baseline copy: `1code/` directory in project root
- Sync state: `.upstream-sync.json`
- Review file: `.upstream-sync-review.json` (ephemeral, gitignored)
- Chunk temp files: `.upstream-sync-chunk-<hash7>-N.json` (ephemeral, gitignored)
- Workgroups file: `.upstream-sync-workgroups.json` (ephemeral, gitignored)
- Script: `.cursor/skills/upstream-sync/scripts/sync.mjs`
- Verify script: `.cursor/skills/upstream-sync/scripts/verify-merge.mjs`
