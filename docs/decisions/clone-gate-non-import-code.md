---
slug: clone-gate-non-import-code
created: 2026-08-02
---

# clone-gate-non-import-code

## Target · 2026-08-02 — Clones are measured over non-import code, excluded at the tokenizer

**Context:** The clone gate was silently vacuous for its own host repo: the post-filter kept only .ts/.tsx/.js/.jsx while devkit's scan roots are pure .mts, so guard-clone reported 0 repo-wide as raw jscpd found 62 real clones — a dead gate shipping in every release since it landed. Fixing the extension filter alone (#305) then exposed the opposite failure: identical linter-sorted import preambles between sibling modules clear the 50-token floor on their own, so any commit touching two files that share libs would false-block the moment a release wires the gate into hooks
**Ruling:** Import/re-export declarations are excluded from clone detection at the tokenizer via jscpd --ignore-pattern (four bounded, comma-free regexes; dynamic import(...) deliberately matches none), making the gate's semantic: clones are measured over non-import code. Post-hoc classification of reported fragments is banned on this axis
**Consequences:**
- Positive: Sibling modules sharing libraries never false-block on module-system-forced preambles, and nothing real can hide behind one — the min-tokens floor applies to actual logic. The gate's first live catches (three duplicated triage blocks in #309's own commits) confirmed it now bites
- Negative: A sub-floor duplication adjacent to an import block becomes invisible (a twice-declared 15-line interface only crossed 50 tokens by riding its imports — real debt, now sub-floor); four hand-maintained regexes with bounded-span discipline; exotic import shapes (import attributes, multi-line default+named) fall through to normal tokenization and may still report
**Vision-fit:** n/a — internal tooling (gate integrity)
**Rejected:** (a) post-hoc fragment classification (isImportPreamble) — UNFIXABLE: six opus-confirmed reviewer holes across seven gate rounds (ratio leak, dynamic import absorption, quote-terminated statements, import attributes, JSX molecules, truncated-statement excusal); jscpd cuts fragments at token boundaries and matches keywords by type, so every heuristic boundary is adversarially exploitable. (b) baseline/allowlist the import clones — leaves the class recurring in every consumer repo, one approval per sibling pair forever. (c) extension fix only — restores detection but ships the false-block class to consumers
**Anchored-bet:** [VALIDATED]
**Revisit-when:** jscpd ships native import-statement exclusion (drop the hand-rolled patterns), or corpus/telemetry evidence shows real duplications recurring sub-floor behind import blocks (lower min-tokens or revisit the exclusion)
**Scope:** gate-engine/co-occurrence/**
**Source:** collab · https://github.com/norvalbv/devkit/pull/308

## Target · 2026-10-16 — Clones are measured over non-import, non-comment code

**Context:** jscpd's mild mode keeps comment tokens in the hashed stream, and every min-tokens window overlapping a comment misses. A comment inside a pasted copy therefore splits the clone, and when both halves fall under the floor the gate reports nothing: one comment line hid a 70-token clone from a 50-token floor. The import exclusion already made the floor count actual logic; comments were the remaining non-logic tokens that could cut or pad it
**Ruling:** Clone detection runs jscpd --mode weak, so comments, like import/re-export declarations (excluded via four bounded, comma-free --ignore-pattern regexes; dynamic import(...) matches none), never enter the token stream: the min-tokens floor counts non-import, non-comment code. Post-hoc classification of reported fragments stays banned on this axis
**Consequences:**
- Positive: A comment pasted into a copy can no longer split a clone into sub-floor halves or hide it; sibling modules still never false-block on module-system-forced import preambles. On devkit the switch lost no file pair and added 5; 9 allowlisted fragments changed span and were re-keyed (human approvals keep their reason and expiry, the rest re-baselined)
- Negative: A copy whose code alone is under the floor no longer clears it by carrying identical comments. A JSX comment {/* */} still splits a .tsx clone, because its braces stay tokens. When two copies differ only in comments, fragmentHash hashes whichever side jscpd lists first (filesystem readdir order), so an approval can miss on a machine that orders the files differently. A sub-floor duplication next to an import block stays invisible; four hand-maintained import regexes
**Vision-fit:** n/a — internal tooling (gate integrity)
**Rejected:** (a) a SKILL.md note that comments split clones: documents the hole without closing it. (b) upgrading to jscpd 5, whose oxc tokenizer never emits TS comment tokens: an engine rewrite with a different regex flavour for the import patterns and platform-binary distribution. (c) lowering min-tokens: raises noise everywhere to catch one split
**Anchored-bet:** [VALIDATED]
**Revisit-when:** devkit upgrades to jscpd 5 (comments are then invisible in every mode and --max-gap-lines can merge near-miss clones), or evidence shows real duplication recurring sub-floor that only identical comments used to lift
**Scope:** gate-engine/co-occurrence/**
**Source:** https://app.shortcut.com/benordlabs/story/5650
**Evidence-change:** A jscpd 4 fixture under the gate's --mode mild showed one comment line pasted into a 70-token copy split it into 40- and 35-token halves and hid the clone entirely; on devkit itself mild reported scoring.mts as two comment-split clones that weak reports as one 43-line clone
