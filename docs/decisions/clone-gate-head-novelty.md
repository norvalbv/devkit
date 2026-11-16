---
slug: clone-gate-head-novelty
created: 2026-10-16
---

# clone-gate-head-novelty

## Target · 2026-10-16 — The clone gate blocks only clones absent from HEAD, and compares whole functions to catch renamed copies

**Context:** A 3-7 line helper copied under a new name passed every deterministic duplicate gate: jscpd 4.2.5 token mode needs 50 tokens and 5 lines (such a body is about 25 tokens), and the embedding matcher needs equal names or code cosine 0.95. Only the LLM commit-guard reviewer could catch it, and on main at 2026-10-16 jscpd 5.4.1 --similarity found 36 cross-file renamed-helper pairs that had all passed it. Pre-existing clones were frozen by fragment-hash allowlist entries: none of devkit's 88 entries survived the jscpd 4 to 5 upgrade, and a key built from one side's fragment would also approve every later copy of the same helper.
**Ruling:** The clone gate runs jscpd at an exact pinned version (5.4.1), once, with --similarity at thresholds.similarity (default 0.9) and --min-lines 3 beside token mode. With --changed it passes --baseline-from-ref HEAD and blocks only clones jscpd marks new that touch a staged file; on an unborn HEAD every clone is new. An allowlist entry approves the clone a commit introduces, keyed on the file pair plus the fragment. Pre-existing clones are not tracked in the allowlist: guard-clone scan lists clone debt, and refactoring retires it. A jscpd other than the pinned version is a named could-not-run.
**Consequences:**
- Positive: A helper copied under a new name blocks deterministically in seconds with both sides named, instead of depending on a 90-160 s LLM pass that had missed 36 such copies. A commit is never blocked for a clone it did not introduce, and upgrading jscpd needs no allowlist migration.
- Negative: Gate time on frink-oss rises from about 0.9 s to a 3.2 s idle median, and 9-10 s with three gate runs in parallel, because jscpd checks HEAD out into a temporary git worktree. That checkout runs a consumer's post-checkout hook, LFS smudge or partial-clone fetch, and devkit cannot suppress it because jscpd strips GIT_* variables. Existing clone debt never blocks again, even when its file is edited. A same-structure lookalike (two 4-line fail/refuse helpers differing only in a message) blocks and needs an approval. A function rewritten from an arrow export to a declaration scores 0.744 and is missed.
**Vision-fit:** n/a — internal tooling (gate integrity)
**Researched:** Replay of 427 devkit commits (2026-09-01 to 2026-10-16, 286 touching the clone roots): 17 new clones in 15 commits (12 similar, 5 exact, one of them only reachable at --min-lines 3); 15 genuine copies, 1 debatable (parseTrendRow/parseManifest), 1 lookalike (fail/refuse). frink-oss HEAD~30..HEAD: 2 new clones in 21 commits, both genuine. jscpd 5.4.1 docs and CHANGELOG (similarity scoring changed in 5.4.1). Ratchets-blame-the-change-not-the-tree is the same novelty rule applied to ratchets.
**Rejected:** (a) Keep fragment-hash freezing and rebaseline on the upgrade: every devkit and frink-oss entry changes hash, and a one-sided key let an approval cover a third copy. (b) Two jscpd runs, a token pass then --kind ast: the ast run claimed a name-only copy as exact and --kind ast dropped it, so neither pass reported it. (c) A hand-built identical-body check, or stripping the import prelude from matcher embeddings: jscpd already ships the normalised-AST comparison, and a body hash catches only byte-identical renames. (d) fallow dupes or PMD CPD: both token-floored, and CPD's identifier blinding does not cover TypeScript.
**Anchored-bet:** [BET]
**Revisit-when:** jscpd changes --baseline-from-ref or --similarity scoring (re-measure on every bump), a consumer's idle gate time passes 10 s, or lookalike blocks outnumber genuine ones on a replay.
**Scope:** gate-engine/co-occurrence/clone-detector.mts,gate-engine/co-occurrence/jscpd-bin.mts
**Source:** shortcut · sc-5612
