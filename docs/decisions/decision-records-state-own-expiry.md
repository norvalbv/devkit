---
slug: decision-records-state-own-expiry
created: 2026-07-01
---

# decision-records-state-own-expiry

## Target · 2026-07-01 — decision records state their own expiry (the 100-year test)

**Context:** The decision log failed its own 100-year test: a reader far in the future (agent or human) could not tell from a record WHEN its ruling becomes invalid or safe to overwrite — the depth-audit of all 7 real records found 0 with any stated invalidation condition, forcing future git archaeology to re-derive validity. A first fix (LLM infers revisit-ability) would have shipped blind and measurably destabilised the depth judge: 76.5% vs the 100% corpus baseline, with 3 false THINs on incident-driven decisions.
**Ruling:** Records state their own expiry: an optional **Revisit-when:** Target field carries the concrete, checkable condition that voids the ruling. The depth judge (rubric check 4) judges Revisit-when QUALITY only when the line is present; ABSENCE is flagged deterministically by the eval depth-audit's (no Revisit-when) marker — never inferred by the LLM.
**Consequences:**
- Positive: A future reader answers 'is this ruling still valid — safe to overwrite?' from the record alone; the log stays a trustable why-store instead of decaying into archaeology, and vague expiry platitudes are caught at commit (measured 17/17 on the labelled depth corpus).
- Negative: One more field to author well, and absence is only surfaced by the informational eval audit — a record can still ship without Revisit-when with no commit-time warning, so coverage of old records depends on running depth-audit.
**Vision-fit:** n/a — internal tooling
**Researched:** measured on the new decisions-eval bench (gate-engine/decisions/eval/): inference-based check-4 wording scored 76.5% (3 false THINs + 1 false PASS); conditional-quality wording restored 17/17; depth-audit of the 7 real records: 5 PASS / 2 THIN / 0 with Revisit-when
**Rejected:** (a) LLM judges Revisit-when ABSENCE by inference — loses on judge stability, measured 76.5% vs 100% baseline; (b) required schema field — loses on friction for rulings with genuinely open-ended validity and would train laundered platitude conditions, the exact failure check 4 catches; (c) status quo — loses on the 0/7 audit result: every record forces future archaeology
**Anchored-bet:** [BET]
**Revisit-when:** depth-audit shows platitude Revisit-when lines passing check 4 (the judge stopped catching vague conditions), or the schema gains structured machine-checkable validity conditions making the prose field redundant
**Scope:** gate-engine/decisions/check-alignment.mjs
**Source:** collab
