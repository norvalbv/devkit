---
slug: consumer-extra-gates
created: 2026-10-08
---

# consumer-extra-gates

## Target · 2026-10-08 — A repo declares extra deterministic gates in guard.config.json as extraGates, a label-to-command map

**Context:** Overlay and package consumers had no way to add a repo-specific deterministic gate. Only self-host could, by baking --extra into its generated hook. A consumer that moved from a hand-written pre-commit to an overlay lost commands such as knip, its structure lint and its typecheck, so devkit ship passed and the repo's main went red on CI three times in two weeks.
**Ruling:** A repo declares extra deterministic gates in guard.config.json as extraGates, a label-to-command map. guard-deterministic reads them at run time and runs them after any --extra gates, under the same contract: each command's argv is split on whitespace, runs without a shell, and any non-zero exit blocks. A malformed entry, a non-object block or an unreadable guard.config.json blocks as unrunnable instead of being dropped. The value is a resolved GuardConfig field, so the prefix-cache config fingerprint changes when the declared set changes.
**Consequences:**
- Positive: Any install mode gets the repo's own checks on commit, ship and --dry-gates with no hook regeneration, and a cached green tree can never skip a newly declared gate.
- Negative: Gates are whole-command, not diff-scoped: pre-existing debt on the base branch blocks every commit until it is fixed. Commands run without a shell, so anything compound has to live in a package script.
**Vision-fit:** n/a — internal tooling
**Researched:** gate-engine/deterministic/run.mts (--extra contract, prefix scope), gate-engine/prefix-cache/config-fingerprint.mts (fingerprint hashes the resolved GuardConfig), cli/lib/husky/self-host.mts (SELF_HOST_EXTRAS), devkit PR #663 (deferred consumer --extra gates), frink-oss CI history.
**Rejected:** (a) Let overlay or package init write consumer --extra flags into the generated hook: every config change needs a hook regeneration, and the hook text is the only cache input. (b) Ship a built-in knip gate: covers one tool and leaves typecheck, structure lint and generated-content checks out. (c) Read extraGates outside GuardConfig: the cache fingerprint would miss it and a cached green tree would skip a newly declared gate.
**Scope:** gate-engine/deterministic/run.mts,gate-engine/deterministic/command-gates.mts,gate-engine/config.mts,guard.config.example.json
**Source:** manual
- 2026-10-08 — First self-host use: related-tests runs vitest related on the staged paths. It reads the commit index through stagedSet, not vitest --changed, which also selects unstaged and untracked files and ignores the commit's alternate index. It has no run-level cap and fails closed. Measured 497s at loadavg 16 for a husky-block.mts change that selects 63 test files.
- 2026-10-14 — related-tests sees only vitest's import graph, so a test that spawns node <module>.mts declares the edge with a never-run void (() => import('<module>')) line. cli/__tests__/test-graph-reach.test.mts fails on any cli/ or gate-engine/ source module that no test's import closure reaches; cli/index.mts is exempt, since an edge to the dispatcher would select every spawning test. Before this, reconcile.mts, decisions/cli.mts and 27 other modules selected no test.
- 2026-10-14 — related-tests appends cli/__tests__/test-graph-reach.test.mts to every vitest related run, because ship skips the full suite before push, so the reach invariant would otherwise only fire in CI. The check reads indexed sources only, so an untracked stray module never blocks a commit, and it skips indexed files deleted from disk.
- 2026-10-16 — devkit self-host now declares its seven former hook --extra gates (lint, hook-parity, formatter-identity, decisions-integrity, release-only-dist, benchmarks, corpus-lint) in its own guard.config.json extraGates, in the same run order, so no generated hook bakes a command gate any more. A label declared both by a hand-written --extra and by extraGates now blocks as one command-less '<label>(duplicate)' gate instead of running two commands under one label: a row under the bare label let a reader such as base attribution pair one gate's failure with the other's command. The --extra runner flag itself stays.
