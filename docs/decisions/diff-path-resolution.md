---
slug: diff-path-resolution
created: 2026-10-15
---

# diff-path-resolution

## Target · 2026-10-15 — One jsdiff-backed resolver for diff segment paths

**Context:** Six hand-rolled resolvers turned a git diff segment into a file path, and each handled git's header shapes differently. The \S+ regexes cut 'my notes/f.md' to 'my'. The 'complete' resolver kept the TAB git appends after a spaced name on ---/+++ lines, so chunked correctness reviews packed spaced files as 0 bytes and sent the judge an empty sub-diff, a silent fail-open on every consumer repo with such a file. C-quoted names (octal UTF-8, \t, \", newline) and hunkless renames were patched one shape per ship round.
**Ruling:** One resolver: diffPathsOf / filePathOf in gate-engine/judge/diff-focus.mts. It runs jsdiff's (npm 'diff' >= 9) parsePatch on the segment HEADER only (the slice before the first hunk, because jsdiff throws on hunk counts that do not add up) and strips a/ from the old side and b/ from the new side. Diff captures that feed it force the prefixes with --src-prefix=a/ --dst-prefix=b/, so a consumer's diff.noprefix / mnemonicPrefix / srcPrefix cannot hide binary or mode-only paths. Staged-name lists come from -z (never C-quoted), so no caller-side unquoting.
**Consequences:**
- Positive: Every gate and judge keys a file by the name git staged: spaced, quoted, non-ASCII, renamed, copied, deleted, binary and mode-only files reach their reviewers. A new header shape is a dependency upgrade, not another regex.
- Negative: A runtime dependency on jsdiff (zero transitive deps, ~1 MB) and on its git-header semantics. A diff captured without forced prefixes still mis-resolves binary/mode-only segments, so every new capture site must pass the prefix flags.
**Vision-fit:** n/a — internal tooling
**Researched:** Probed 8 npm parsers against real 'git diff --cached -M -C' output covering 15 header shapes: only jsdiff 9 (kpdecker/jsdiff PR #672, 2026-04) resolved all of them. git-diff docs for --src-prefix/--dst-prefix and core.quotePath. Source: collab + web.
**Rejected:** (a) Keep extending the hand-rolled resolvers: each fix covered one shape and the copies drifted apart. (b) parse-diff, gitdiff-parser, parse-git-diff, what-the-diff, diff2html, git-diff-parser, unidiff: each failed on quoting, the trailing TAB or hunkless segments. (c) Capture with 'git diff --raw -z -p' for verbatim paths: still needs a text resolver for stored and eval diffs.
**Revisit-when:** jsdiff drops git-header support or a supported capture cannot force a/ b/ prefixes.
**Scope:** gate-engine/judge/diff-focus.mts,gate-engine/review/evidence/staged-git.mts,gate-engine/review/lens/chunk.mts,gate-engine/review/diff-evidence.mts
**Category:** commit-gates
**Source:** manual
