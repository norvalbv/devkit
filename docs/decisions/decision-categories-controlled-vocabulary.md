---
slug: decision-categories-controlled-vocabulary
created: 2026-07-26
---

# decision-categories-controlled-vocabulary

## Target · 2026-07-26 — Categories are an explicit frozen vocabulary, declared per record and never derived

**Context:** The store is per-axis but the recurring question is per-category — what config moves where and why — whose answer is spread across roughly ten records with no view assembling category to owner to establishing ruling. There is nothing reliable to derive categories FROM: **Scope:** is present on only some records and most globs share a top-level directory, so they do not cluster.
**Ruling:** A record declares **Category:** on its Target, validated against a frozen six-value list (decision-log, commit-gates, benchmarking, ship-pipeline, consumer-distribution, self-host-release) derived by reading what every existing axis actually governs. An unknown value is a hard error at write time naming the allowed values. Records without a category are reported under an explicit uncategorised heading, never silently bucketed — on the real corpus today that is all 31, which is the honest reading rather than a fabricated grouping. guard-decisions categories renders category to axis to current ruling and always exits 0: it is a view, not a gate.
**Consequences:**
- Positive: The per-category question becomes answerable from one command instead of reading the corpus, and a frozen vocabulary cannot drift into synonyms and singletons the way free tags do.
- Negative: The vocabulary is a judgement call over the corpus as it stands, so it will need re-slicing as the corpus grows; and because Category lives on the Target, existing records cannot be categorised without a new Target or a rescope-style append — so the view stays empty until that is built.
**Vision-fit:** n/a — internal tooling
**Researched:** MADR and adr-tools conventions; the known failure mode of free-text tags is drift into synonyms and singletons, which a controlled list avoids at the cost of needing maintenance.
**Rejected:** Deriving categories from Scope globs (measured: most share a top-level directory, so they do not cluster). Free-text tags (drift). Silently bucketing uncategorised records under a default (would fabricate a grouping the corpus does not support).
**Revisit-when:** The corpus outgrows six categories, or a record genuinely belongs in two — at which point the single-value field is the constraint to revisit, not the vocabulary.
**Scope:** gate-engine/decisions/recall/categories.mts,gate-engine/decisions/recall/category-report.mts
**Source:** manual
