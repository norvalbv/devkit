---
slug: line-cap-governs-declared-extensions
created: 2026-10-11
---

# line-cap-governs-declared-extensions

## Target · 2026-10-11 — guard.config.json gains maxLinesExtensions, a list of bare extensions that defaults to empty

**Context:** The raw-line ratchet (guard-size) counted only sourceExtensions under scanRoots, so a repo's shell scripts had no deterministic cap. In devkit the 500-line shrink-only rule reached those scripts only through the conventions reviewer, which applied it on one judge model and not another: a 22-line growth of an oversized ship script passed five ship attempts and was blocked on the sixth after a judge-family switch. Six ship scripts sat between 523 and 1730 lines with nothing holding them.
**Ruling:** guard.config.json gains maxLinesExtensions, a list of bare extensions that defaults to empty. The raw-line ratchet governs sourceExtensions plus maxLinesExtensions under scanRoots: the commit gate, the preflight, the oversized-file count and the baseline freeze all use one matcher, lineMatchers in gate-engine/ratchets/size-policy.mts. Nothing else reads the key: fan-out, eslint-disable debt, structure, coverage, the comment budget and review routing stay on sourceExtensions. A file matched by the key takes the same caps and the same shrink-only baseline as a source file, including the test ceiling for a .test. or .spec. name. devkit sets the key to sh.
**Consequences:**
- Positive: A size verdict on a governed file is the same on every judge model and arrives before any judge runs, so a ship does not spend reviewer rounds discovering it. A consumer who does not set the key sees no change.
- Negative: One more config key, and a second meaning of 'source' inside the size ratchet that a reader must keep apart from sourceExtensions. In devkit six scripts become shrink-only and two more sit within 13 lines of a hard 500 cap, so the next growth there forces a split. Extensionless scripts stay ungoverned.
**Vision-fit:** n/a — internal tooling
**Researched:** Prior-art pass over the three reference checkouts, this repo's history and open PRs, and the ESLint and Oxlint max-lines docs: no peer repo caps shell, max-lines is a JS-linter rule, and no size-specific extension key existed. The rule-grounding and ambient-context fixes for the reviewer are separate open work and are not part of this ruling.
**Rejected:** Adding sh to sourceExtensions: the comment budget has no shell lexer and coverage, fan-out and review routing would all start reading shell. An extraGates script: a second line counter with a second baseline beside the one guard-size already keeps. Per-tree sourceExtensions: read by structure lint only. Leaving it to the conventions reviewer: that is the model-dependent verdict this replaces.
**Anchored-bet:** [BET]
**Revisit-when:** A governed extension needs a cap different from maxLines, or a second gate needs the same extension list.
**Scope:** gate-engine/ratchets/size-*.mts
**Category:** commit-gates
**Source:** manual
