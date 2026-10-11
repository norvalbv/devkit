---
slug: decision-capture-gate-posture
created: 2026-10-11
---

# decision-capture-gate-posture

## Target · 2026-10-11 — The capture gate passes on facts or a ROUTINE downgrade, never on a declaration

**Context:** No Target ruled whether the commit-time capture gate (guard-decisions detect --gate) blocks, and a 2026-10 design review proposed replacing the judge's ROUTINE downgrade with a deterministic 'Decision: none — <reason>' declaration, on the theory that ROUTINE calls often miss decisions. A zero-LLM join of one machine's telemetry to git found few misses (Researched). Whether the block itself produces records, compared with an advisory gate, was not measured: there is no advisory or no-gate arm, so this posture is a bet.
**Ruling:** No commit-message or CLI declaration ("Decision: none") clears the detect gate: a smelled diff passes only with a staged decision file, noLog (GUARD_NO_LOG or the guard.config.json key), or a ROUTINE verdict from the judge, live or cached, which may downgrade a smell and never escalates. A judge outage keeps the block (exit 1; exit 3 under strict ship), as does noLlm, which skips the live judge. Any other failure of the gate itself exits 2, which the generated hook lets through (fail-open); under strict ship it exits 3 and blocks, and an unreadable staged object exits 4 and blocks in either mode. Outage classification is ruled in judge-outage-classified-not-blocked.
**Consequences:**
- Positive: A consumer's generated hook keeps one pass condition and one remedy per block (record the decision, or GUARD_NO_LOG). No second commit-message escape grows beside noLog, and the judge keeps its one job of clearing false-positive smells.
- Negative: The judge stays non-deterministic on the commit path. Identical haiku runs of the detect judge disagreed in 22% of cells over two runs on 19 bench rows. 5 of 47 production block chains were cleared by re-running it. In 8 of the 15 branches where a ROUTINE call was later followed by a record, the gate blocked a later run of that branch first, as the diff grew. The block is also routed around: 203 GUARD_NO_LOG bypasses against 67 blocks on the same machine.
**Vision-fit:** n/a — internal tooling
**Researched:** 2026-10-11, zero LLM, one machine. Source: ~/.devkit/telemetry/gate-events.jsonl gate_result gate=decisions, 9,316 rows (967 recorded, 273 ROUTINE, 203 bypassed, 67 blocked), joined to git in four repos and to gh by staged-tree SHA and ship logs. Unit: repo+branch, the unit block chains are counted in. ROUTINE cleared about 90 non-fixture branches; 15 had a recorded run within 7 days. Smell files were recomputed with smellSources, and Scope matched with matchesRepoGlob. Of the 15: 8 recorded only after the gate blocked a later run; 1 was a detached-HEAD artefact; 1 had off-Scope notes; 1 was ambiguous (dep-change smell, squash-merged); 4 had an un-forced later Target, 1 whose Scope covers a smelled file and 3 covering other changed files. The completeness or conventions reviewer had flagged 2 of those 3. 24 of 47 block chains ended in a record.
**Rejected:** A deterministic 'Decision: none — <reason>' declaration in place of the ROUTINE downgrade. Its bar was ROUTINE misses at least equal to the 24 recorded block chains. Misses were 1 branch (Scope covers a smelled file) to 5 (Scope covers any changed file, 1 ambiguous), and at most 12 counting block-caused follow-ups, notes and unresolved axes. It would add a declaration to every ROUTINE-cleared commit (about 90 branches) to recover at most 5, plus a second escape beside noLog; changesets grew --empty for CI that blocks merges without a changeset.
**Anchored-bet:** [BET]
**Revisit-when:** (1) Once every decisions gate_result carries commit_tree and head_oid and the decisions write path emits an event: over 30 or more days, the branches where a ROUTINE call is followed by an un-forced Target whose Scope covers a smelled file reach the number of block chains that end in a record, both counted per repo+branch. (2) An advisory or holdout arm (detect warns instead of blocking for a sample of commits or repos) shows that the share of smelled changes that stage a record is unchanged without the block.
**Scope:** gate-engine/decisions/detect.mts
**Category:** commit-gates
**Source:** manual
