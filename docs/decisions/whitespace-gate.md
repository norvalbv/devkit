---
slug: whitespace-gate
created: 2026-10-16
---

# whitespace-gate

## Target · 2026-10-16 — Staged whitespace errors block in a built-in deterministic gate, read from the commit's index

**Context:** devkit ship printed git's apply warning 'new blank line at EOF / 1 line adds whitespace errors' on attempt 1 and nothing acted on it; two attempts and ~257s later an escalated LLM reviewer blocked on the same line citing git diff --cached --check. A free, deterministic fact about the diff cost an extra ship attempt and minutes of judge time, and the apply warning never fires for untracked files or plain commits at all.
**Ruling:** A default deterministic gate, whitespace, runs git diff --cached --check over the commit's index (commitIndexEnv, so commit -a, partial commits and alternate indexes are judged as committed) first in the registry, before any judge. Only added lines are judged. Git's own rules decide: the consumer's core.whitespace and the .gitattributes whitespace / conflict-marker-size attributes are the per-path exemptions; devkit hard-codes none. Exit 1 lists file:line with a remedy naming the matching attribute; a git failure is could-not-run (exit 2, fail-open).
**Consequences:**
- Positive: Trailing whitespace, a new blank line at EOF and leftover conflict markers block in under a second on attempt 1 with file:line, so no ship spends an LLM round or an attempt on them, in every install mode and for every commit shape.
- Negative: Intentional whitespace now blocks until the path is exempted: .patch/.diff blank context lines, markdown two-space hard breaks, CRLF files, a 7-character '=======' setext underline (a conflict marker, exempted only by conflict-marker-size). devkit itself exempts *.patch and dist/** in .gitattributes. Existing installs get the gate only by accepting the devkit upgrade offer or editing components.guards.
**Vision-fit:** n/a — internal tooling
**Researched:** git docs (git diff --check, core.whitespace, gitattributes whitespace); git templates/hooks/pre-commit.sample (diff-index --check --cached, no exclusions); pre-commit-hooks trailing-whitespace (markdown preservation opt-in, default none); replay of devkit's last 300 commits (6 would block: 2 .patch, 4 dist) and frink-oss's last 200 (0); cli/lib/husky/review-fragments.mts (__dk_no_git_env scrubs GIT_INDEX_FILE).
**Rejected:** (a) A consumer extraGates entry running git diff --cached --check: extraGates inherit the scrubbed environment and judge the default index, so commit -a misses the change and commit -- <path> judges unrelated staged paths; fixing that reverses gates-judge-commit-index; and git's exit 2 reads as could-not-run. (b) Promote ship's git-apply warning into the findings block: covers only the tracked-patch arm (untracked files are copied) and never runs on a plain commit. (c) Hard-code *.md/*.patch exclusions: contradicts git's and pre-commit's defaults and drops real EOF defects in markdown; .gitattributes is the native per-path control.
**Anchored-bet:** [BET]
**Revisit-when:** A consumer's own formatter or hook already enforces git diff --check on the commit index for every commit shape, or the false-block rate on added lines exceeds a few per hundred commits.
**Scope:** gate-engine/deterministic/whitespace.mts,gate-engine/deterministic/registry.mts
**Source:** shortcut · sc-3952
