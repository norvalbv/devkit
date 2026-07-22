---
slug: qavis-advisory-gate
created: 2026-07-07
---

# qavis-advisory-gate

## Target · 2026-07-07 — the "deserves QA?" classifier + pass-receipt live in qavis; devkit is a thin fail-open gate that maps its verdict to an exit code

**Context:** qavis (a computer-vision PR QA agent) only ran on an explicit request, so UI-affecting PRs shipped un-QA'd. We wanted `devkit ship` / pre-commit to proactively nudge "run qavis QA" when a change warrants it and stay silent when it doesn't — agent-visibly (a stderr nudge is invisible to a headless shipping agent under output filtering; only an exit code survives). The naive placement — a qavis-specific classifier + a copy of qavis's UI path/ext regex inside devkit — is dead weight for every non-qavis consumer and duplicates logic qavis already owns (`src/route.ts`), and a bench showed that regex (recall 0.45, false-advise 0.39 over a 95-row hard corpus) cannot see semantic UI impact (an API/schema/token/i18n change the UI renders) nor exclude non-UI files under UI paths (tests/stories/types). A first exit-3 design was also unsatisfiable-by-compliance: at commit time no PR exists, so an "already-QA'd" marker always missed and every UI ship blocked with only an override to clear it.

**Ruling:** Split by ownership. (1) qavis owns the classifier (`route --staged|--diff --gate`, a haiku judge that reads the diff — bench-picked at recall 0.96 / false-advise 0.00, clearing the floors regex can't) and a content-addressed pass-receipt (`.qavis/receipt.json`, sha256 over each changed file's blob sha, so a staged index and an identical committed tree match). (2) devkit is a THIN CHANNEL: `gate-engine/qavis-advisory` shells `qavis route --staged --gate`, and fail-OPENS (exit 0) when qavis or a `.qavis/recipe.json` is absent — the fallow precedent, zero weight for non-qavis consumers. (3) The exit contract is advisory: 0 = continue (SILENT / advisory-only on a normal commit / receipt-cleared / qavis absent), 3 = ADVISE under a strict ship (`GUARD_AI_STRICT`) — the ship blocks until qavis runs (writing a receipt that clears it) or an override is set. There is NO exit 1 and NO fail-closed on outage (unlike completeness): an advisor's own failure must never block a ship. Overrides: `GUARD_QAVIS_OK=1` ships without QA, `GUARD_NO_QAVIS_ADVISORY=1` disables. Wired as its own husky fragment (bunx/standalone/overlay) with its own remedy line, NOT an AI_GUARD (different exit contract).

**Consequences:**
- Positive: the block is satisfiable-by-compliance — running qavis clears it and editing after QA re-arms it (proven end-to-end); the classifier isn't duplicated; non-qavis consumers carry zero cost; the model call is spent only on launchable, non-empty diffs (the launchability/empty gate stays deterministic in qavis's `needsVisualJudge`), and a receipt short-circuits a re-ship to zero tokens.
- Negative: the advisory reaches a headless agent only via the exit-3 ship block, not the normal pre-commit path (stderr there is advisory-only); a UI commit in a qavis-recipe repo spends one ~seconds haiku call unless a receipt already covers it; and cross-tool the receipt SHA formula must stay byte-identical between qavis and devkit (documented in both).

**Vision-fit:** n/a — internal dev/CI tooling.

**Researched:** gate-engine/qavis-advisory/{check,cli}.mts; qavis src/{route,route-judge,receipt}.ts + eval/ (95-row bench, results.baseline.json); the completeness gate exit contract (gate-engine/review/completeness.mts); the fallow chain-fail-open precedent (cli/lib/husky/husky-block.mts). A feature-critique pass (RETHINK → resolved) drove the ownership split, the satisfiable-receipt fix, and the flip-table `--fail` for the bench.

**Rejected:** (a) classifier + regex copy inside devkit — REJECTED: dead weight for non-qavis consumers, duplicates qavis's router, and the regex misses the hard cases (bench-proven). (b) a warn-only exit-0 advisory everywhere — REJECTED: invisible to a headless shipping agent (the whole exit-code point). (c) exit-3 with the pass-receipt deferred — REJECTED: unsatisfiable-by-compliance (only a bypass could clear it), the dead-gate anti-pattern.

**Anchored-bet:** [VALIDATED]

**Scope:** gate-engine/qavis-advisory/**,cli/lib/husky/husky-block.mts,cli/lib/components.mts

**Source:** collab · qavis-advisory
- 2026-07-22 — Fail-open stays exit 0 but is now LOUD: when the advisory cannot run, the gate prints one stderr line naming WHY (qavis not on PATH / route failed / unparseable verdict) instead of returning a bare null that read exactly like SILENT. defaultRoute now returns a RouteResult whose null arm carries the reason, so there is one printer and no detail is discarded; ENOENT is discriminated from a qavis that ran and failed. Silent fail-open made a dead gate indistinguishable from 'nothing to QA'.
