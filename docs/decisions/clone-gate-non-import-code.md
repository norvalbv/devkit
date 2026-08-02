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
