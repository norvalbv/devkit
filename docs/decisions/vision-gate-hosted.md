---
slug: vision-gate-hosted
created: 2026-07-18
---

# vision-gate-hosted

## Target · 2026-07-18 — The product-vision gate stays CONSUMER-LOCAL

**Context:** A guard-vision gate (opus judge of the staged diff vs a consumer-supplied product-vision statement in guard.config.json) was fully built and bench-certified on branch feat/guard-vision (PR #77): qavis-style ownership split (devkit scaffold/parse/exit contract, consumer statement), hard-by-default bounded to a confident single-word OUT, and a 141-case eval (de-confounded contrast corpus, 3-run majority, Wilson CI + MDE, sealed holdout, McNemar flip regression) that passed its holdout floors after the in-chain critique loop exposed and fixed two real scaffold flaws (verdict-injection to NULL; operate-vs-touch false OUT). PR #77 was then closed UNMERGED by user ruling — this Target records the road not taken so the branch's own decision entries don't vanish with it.
**Ruling:** The product-vision gate stays CONSUMER-LOCAL; devkit does not host it. Deciding rationale (user): a hard vision gate is only as valid as the vision content it judges, and validating that needs benchmarking from every angle — the statement itself, whether agents can faithfully work against it, and whether a config-paragraph compression of a living identity corpus (frink: hundreds of files of gate-enforced vision material) can be rich enough to neither false-block nor vacuously pass. Until that validation burden is paid, the consumer-local gate is the honest home: its judge brief can evolve to assemble from the living identity sources (frink-identity skill + scoped decision Targets, the prep-critique pattern) and those sources are already staleness-gated — properties a devkit config string can never have without devkit growing single-consumer file-injection machinery.
**Consequences:**
- Positive: Positive: no hard gate ships judging an unvalidated compressed vision; devkit stays free of a single-consumer content interface; the consumer keeps the richness/maintenance upgrade path. Negative: the mechanism+bench engineering idles on the closed branch (feat/guard-vision remains; scaffold lines, corpus and harness port to the consumer whenever wanted), and vision-gate telemetry/eval standards stay per-consumer rather than centralized.
- Negative: Chose content-validity over mechanism-consolidation: a benched MECHANISM (the judge applies a paragraph rubric well) was proven, but a benched mechanism over unvalidated CONTENT still ships false confidence — the bench measured fidelity-to-statement, and no bench yet measures statement-to-product truth.
**Vision-fit:** n/a — devkit gate-engine scoping; the ruling exists precisely to protect each consumer's product-vision integrity.
**Source:** manual
