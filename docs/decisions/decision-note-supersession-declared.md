---
slug: decision-note-supersession-declared
created: 2026-07-27
---

# decision-note-supersession-declared

## Target · 2026-07-27 — Note supersession is declared and validated, never inferred

**Context:** About a quarter of notes in the real 68-axis frink corpus supersede an earlier note on their own axis, and nothing recorded which one won: retrieval served the superseded note and its correction as equally-weighted qualifiers on the same ruling. An **Amends:** marker had existed since sc-1236 but was a bare flag with no target, unused across all 181 notes — because notes had no id to point AT. retrieval.mts minted note:<date> without an occurrence suffix, so on the axis carrying six notes dated 2026-07-03 all six answered to one id.
**Ruling:** Notes get axis-wide ids with a ~N same-day suffix, minted once in recall/note-relations.mts and imported by both retrieval and the gate. A note declares its relation with --supersedes <id> on add --note, rendered as the established **Amends:** marker. A deterministic check (integrity #8, note-amends-unresolvable) validates the DECLARATION: the id parses, names a real note on the axis, predates the amending note, and is not the note itself. The write path validates too, so the CLI can never write a pointer its own check rejects.
**Consequences:**
- Positive: A supersession edge becomes machine-readable, so serving can stop presenting a superseded note as a live qualifier. Fires 0/181 on both real corpora — no grandfathering, unlike the mandatory-relation-tag check that died firing 36/36. Fixes a latent id collision that made **Amends:** unusable.
- Negative: Only DECLARED edges are caught. A note that supersedes an earlier one silently is invisible to this gate, and the ~75% of notes relating to nothing prior are deliberately not asked to declare anything — so coverage depends on writers using the flag.
**Vision-fit:** n/a — internal developer tooling; the decision log's own note layer.
**Rejected:** Classifier/keyword detection of undeclared supersession — measured dead: a narrow supersede/reverse grep recovers 25% of the real cases while a broader one overshoots to 48%, because notes use reversal vocabulary precisely to DENY they are reversals. Separating a genuine supersession from a refinement needs a note read against its predecessor, which is an LLM call the commit gate cannot make.
**Scope:** gate-engine/decisions/recall/note-relations.mts,gate-engine/decisions/integrity/**
**Category:** decision-log
**Source:** manual
- 2026-07-27 — Latent id collision fixed as a precondition: retrieval.mts minted note:<date> with no ~N suffix, so the six notes dated 2026-07-03 on flow-run-restart-recovery shared one id. Minting now lives once in note-relations.mts and both readers import it.
- 2026-07-27 — **Amends:** note:2026-07-27 — Scope correction: the collision was in retrieval's own minting, not in supersession.mts — that module already had ~N for Targets and was the template copied.
