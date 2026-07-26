---
slug: decision-format-parsed-not-regexed
created: 2026-07-26
---

# decision-format-parsed-not-regexed

## Target · 2026-07-26 — The decision format is read with a markdown PARSER, never string arithmetic

**Context:** Every structural boundary in a decision file was inferred with string arithmetic — lastIndexOf('\n## '), slice-to-next-heading, scan-until-first-dated-bullet. That produced SIX consecutive correctness-review rejections on one diff (sc-1236), each a different end of the same problem: the note tail running to end-of-file so a trailing '## [archived …]' block's bullets became live qualifiers; the start located by 'last h2' so an archived heading after the current Target hid every real note; and legacy multi-block files folding SUPERSEDED blocks into the current ruling text — 12 files in the real corpus have that shape, one with 8 blocks. Each fix addressed one end and the next review found another. The tests could not catch them because the seed corpus contained none of the shapes.
**Ruling:** Markdown structure is read by mdast-util-from-markdown in one module (gate-engine/decisions/markdown.mts), which is the only place permitted to know markdown layout. A section is 'this heading until the next heading', read off parser node offsets rather than inferred, so a boundary cannot be half-right. Retrieval consumes sections(); sliceToNextHeading, upToFirstNote and every lastIndexOf offset walk are deleted. Frontmatter stays hand-rolled — it parses exactly the two documented fields.
**Consequences:**
- Positive: The entire boundary-bug class is gone by construction rather than by another patch, at the point where Phase 5 is about to add MORE parsing surface (Supersedes:, Relation:, category:). Verified against the real 85-axis corpus: every axis parses, none dropped, and the 8-block legacy file now resolves to its last block.
- Negative: A runtime dependency (and its micromark tree) in a globally-installed CLI, for structure a regex 'nearly' handled. Accepted because 'nearly' cost six review rounds and the failure mode is silent — a mis-sliced boundary serves a falsified ruling as current, which is the exact harm the log exists to prevent. Consumers are unaffected: devkit bundles its own tools per zero-consumer-tool-deps.
**Vision-fit:** n/a — internal tooling. A why-store that mis-reads its own format cannot be the source of truth Rule 12 makes it.
**Researched:** Maintenance check before adoption (the rule this repo now works to): mdast-util-from-markdown 155 days since release, 2 maintainers, 32 releases — adopted. gray-matter REJECTED at 1919 days (5.2 years) despite being the obvious frontmatter choice; minisearch DEFERRED on a single maintainer for a per-commit gate. remark-parse/unified are stable rather than dead but the full plugin pipeline is not needed.
**Rejected:** (a) Keep patching the regexes — six rounds of evidence say each fix reveals the next end, and the failure is silent; (b) gray-watter/gray-matter for frontmatter — fails the maintenance bar at 5.2 years, and the hand-rolled parser covers the whole two-field schema; (c) remark/unified — the plugin pipeline is machinery we do not need to get an AST; (d) hand-roll a real parser — that is the wheel, and worse than the one on npm.
**Anchored-bet:** [BET]
**Revisit-when:** mdast-util-from-markdown goes unmaintained (no release in ~2 years with open issues unanswered), or the format stops being markdown
**Scope:** gate-engine/decisions/markdown.mts,gate-engine/decisions/retrieval.mts
**Source:** shortcut · sc-1236
- 2026-07-26 — Scope correction: the parser landed at gate-engine/decisions/recall/{markdown,retrieval,qualifiers}.mts, not the paths this Target's Scope names. The folder-fanout ratchet capped gate-engine/decisions at 12 impl files and markdown.mts made 13, so the recall trio moved into its own cohesive subfolder. Also dropped sectionByHeading from markdown.mts: it was exported but never called, and its doc argued for exact-heading matching while the caller deliberately takes the LAST same-date heading — a dead export whose comment contradicted live behaviour is worse than no export. Recorded rather than silently corrected because the Scope glob is what the alignment gate matches on.
