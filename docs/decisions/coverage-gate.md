---
slug: coverage-gate
created: 2026-07-19
---

# coverage-gate

## Target · 2026-07-19 — coverage is a devkit-owned, opt-in, fail-CLOSED deterministic guard; the ship worktree links the coverage artifact so the gate verifies real coverage instead of being warned away

**Context:** The coverage check lived hand-rolled in a consumer's (frink's) `.husky/pre-commit`, below the devkit-managed block: hardcoded statement/function thresholds, and on an absent `coverage/coverage-final.json` it printed a loud SKIP and PASSED (fail-open). It was written fail-open on purpose because `devkit ship` runs the hook inside an ephemeral worktree that never carries the gitignored `coverage/` artifact — so a real ship would otherwise always trip it. The result: substantive commits could ship with coverage silently unverified, and the gate was per-repo dead weight instead of a devkit primitive.

**Ruling:** Lift it into devkit as a first-class **opt-in deterministic guard** (`gate-engine/coverage/run.mts`, id `coverage` in `GUARD_IDS`/`GUARD_OPTIONS`, NOT recommended — it needs a `test:run:coverage` provider the repo may not own). It is **fail-CLOSED**: `coverage: false` in guard.config.json = the ONLY bypass (exit 0); an absent artifact = exit 1 (run test:run:coverage first) — NOT a fail-open (2); a malformed artifact = exit 1 (corrupt data is not verification); a present artifact enforces only the threshold KEYS set in the config object (`{ statements, functions, lines?, branches? }`), computed from the istanbul/V8 shape. The config default is `{}` = active-strict: no percentage floor, but absent data still fails hard — so "gate selected + nothing configured" fails hard, exactly the anti-fail-open the old warn-branch violated. The ship-worktree tension is fixed at the ROOT, not papered over: `prepare_gate_worktree` links `coverage/` into the worktree (the same mechanism it uses for node_modules/.husky/_), existence-guarded so an absent artifact simply isn't linked → the gate fails hard, forcing a real `test:run:coverage`. Opt-in guards are excluded from `selectedIds`' missing-config fallback (a new `DEFAULT_IDS`) so an unadopted/CI repo without `.devkit/config.json` is never wedged by a coverage gate it never selected.

**Consequences:**
- Positive: a selected coverage gate can never silently pass unverified; thresholds are config-driven per consumer (no hardcoded frink numbers in devkit); the ship worktree verifies REAL coverage rather than warning it away; opt-in + missing-config exclusion means zero cost/zero surprise for repos that don't select it; rides the existing `newBundledGates` opt-in path so `devkit upgrade` surfaces it like `review`/`sentry`.
- Negative: a developer who skips `test:run:coverage` now hits a hard block on their real commit (intended — that IS the fix); the ship link makes coverage verify the developer's last coverage run, not a fresh in-worktree run (a deliberate cost/accuracy trade — the artifact reflects the staged source, which ship isolates); consumers migrating off a hand-rolled block must move their thresholds into guard.config.json.

**Vision-fit:** n/a — internal dev/CI gate tooling.

**Researched:** gate-engine/coverage/run.mts (+ __tests__); gate-engine/config.mts (CoverageConfig resolution); gate-engine/deterministic/run.mts (DETERMINISTIC + DEFAULT_IDS opt-in fallback); cli/lib/ship/prepare-gate-worktree.sh (the shared link set from PR #104); the frink hand-rolled block being replaced. The deterministic trichotomy (0/1/2) — coverage deliberately omits the 2 (fail-open) arm.

**Rejected:** (a) keep it hand-rolled per-repo — REJECTED: dead weight, drifts, and stays fail-open. (b) fail-open on absent data (the old warn-branch) — REJECTED: silently ships unverified coverage, the exact defect. (c) make ship auto-bypass coverage or re-run test:run:coverage in the worktree — REJECTED: bypass re-introduces the fail-open, and re-running adds minutes to every ship; linking the existing artifact is both cheap and correct. (d) sweep coverage into the missing-config fallback like the core gates — REJECTED: an opt-in artifact-dependent gate must not fail an unadopted/CI repo that never chose it.

**Anchored-bet:** [PROPOSED]

**Scope:** gate-engine/coverage/**,gate-engine/config.mts,gate-engine/deterministic/run.mts,cli/lib/components.mts,cli/lib/ship/prepare-gate-worktree.sh,package.json

**Source:** collab · coverage-gate
- 2026-07-21 — per-run bypass GUARD_COVERAGE_OK=1 (alias GUARD_NO_COVERAGE=1), resolved via config.mts coverageBypassed(). NOT a reversal of Rejected (c): that was ship AUTO-bypassing (an implicit always-on skip = the fail-open this gate kills). This is an explicit operator assertion in the GUARD_NO_LOG / GUARD_QAVIS_OK class — default path still fail-CLOSED, bannered (⚠️ BYPASSED, worded apart from the coverage:false line) and emitted as a gate_result telemetry event. guard-deterministic salts its prefix-cache scope with ':coverage-bypassed' so a bypassed run can never record a green key a later un-bypassed run would reuse. Driven by field evidence: 6 frink ship attempts, 0 clean ships, all blocked on the ABSENT-artifact arm (task worktrees carry no coverage/ dir to link); agents grepped for GUARD_NO_COVERAGE/SKIP_COVERAGE by name and found nothing, then left devkit for hand-rolled git commit. Hence the alias, and remedy lines on all three failure arms. The absent-arm text also now states that a local coverage:false is ignored under ship (read from the committed tree) — the old text advised it unconditionally and burned a user-approved bypass.
