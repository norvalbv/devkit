---
slug: decision-log-write-path-integrity
created: 2026-07-27
---

# decision-log-write-path-integrity

## Target · 2026-07-27 — The write path gets deterministic shape checks, chosen by measured fire rate

**Context:** The decision log's READ path has a 29-case recall benchmark; its WRITE path had none. decision-records-cli-owned-writes explicitly left 'shell, MCP, human, and OS-level writes outside v1', so a record reaching disk outside guard-decisions add/amend — a hand-edit, a bad merge, a non-CLI writer — was undetectable. The sharpest case is a Target heading demoted to depth 3: sections() stops treating it as a block boundary, so currentTarget() silently stops reading the record as a ruling at all, and nothing reported that.
**Ruling:** Seven deterministic structural checks (gate-engine/decisions/integrity/) answer one narrow question — does this record still have the shape the CLI would have written? — via the same parsers the rest of the engine trusts (parseDecision/parseTargetFields, recall/markdown.mts sections()), never a second regex reader. Zero LLM, zero network. guard-decisions integrity runs them corpus-wide. Membership is decided by measured fire rate on the real corpus, not by plausibility: six fire 0/32 files, the seventh fires 1/39 Target blocks. Checks that fired broadly are rejected outright (note relation tags 36/36, retroactive Supersedes 7/7), and duplicate rulings are never detected by similarity threshold. The paired decisions-save-quality benchmark scores mutation recall and false-positive rate, and its gate rests on PER-CHECK completeness rather than a pooled recall floor.
**Consequences:**
- Positive: A record that bypassed the CLI is detectable corpus-wide in milliseconds, closing the hole decision-records-cli-owned-writes named as open for v1. The suite can genuinely fail: killing any one check fails the gate by name rather than being averaged away.
- Negative: Seven checks is a deliberately narrow net — it proves SHAPE, never rationale quality, so a well-formed but hollow ruling passes untouched. One historical record (overlay-self-heal's 2026-07-14 re-target) is grandfathered by an explicit block-keyed exception, which is real permanent debt in the corpus.
**Vision-fit:** n/a — internal developer tooling; the decision log's own write path.
**Scope:** gate-engine/decisions/integrity/**,gate-engine/decisions/eval/save-quality/**
**Category:** decision-log
**Source:** manual
