---
slug: oxc-toolchain-migration
created: 2026-08-15
---

# oxc-toolchain-migration

## Target · 2026-08-15 — Migrate quality tooling to Oxc one proven responsibility at a time

**Context:** Devkit and Frink split quality work across Biome, ESLint, and TypeScript, making every agent loop pay several processes and leaving anti-slop outside the standard ruleset. A one-off Devkit control measured type checking as the largest standalone lane at 2.185 s median wall time and 443.1 MiB median RSS, but the Frink compatibility study also found that an all-at-once Oxc swap would silently lose non-JavaScript topology coverage and would rely on experimental TypeScript-7-oriented type checking while Frink uses TypeScript 6.
**Ruling:** Adopt Oxc incrementally, one responsibility at a time, only after the candidate preserves that responsibility's diagnostics and scope on pinned Devkit and then Frink inputs. Target Oxfmt for formatting, native Oxlint for ordinary and compatible ESLint rules, and vendored anti-slop in the same Oxlint configuration. Keep the current Biome, ESLint topology path, and tsc ownership until their individual parity conditions are proven; replace filesystem topology with a dedicated policy runner rather than a partial source-only port.
**Consequences:**
- Positive: Agent feedback can become faster and less memory-intensive without trading away import walls, asset and empty-directory topology, formatter stability, or compiler diagnostics. Future contributors can tell which Oxc migrations are intended and which retained tools are deliberate temporary owners rather than forgotten duplication.
- Negative: The repository carries a mixed toolchain during migration and must run one-off paired parity experiments before each removal. This delays a single-command Oxc end state and temporarily duplicates configuration, but avoids a fast command that checks fewer files or reports fewer errors.
**Vision-fit:** Internal tooling: reduce CPU time and memory so autonomous agents reach trustworthy feedback faster.
**Researched:** Shortcut sc-1674; the [consolidated 2026-08-15 Devkit/Frink report](../benchmarks/experiments/2026-08-15-oxlint-js-plugin-frink/README.md); official Oxc Oxlint, JS-plugin, Oxfmt, and type-aware documentation; official Biome plugin documentation; anti-slop upstream.
**Rejected:** An immediate full Oxc replacement was rejected because Oxlint JS plugins cannot run the custom parser used for CSS, HTML, assets, and empty-directory topology, and its compiler-diagnostic path is experimental and targets TypeScript 7 semantics. Keeping the current stack indefinitely was rejected because the measured control identifies material CPU and memory targets and Oxc has compatible native rules plus the required anti-slop plugin model. Consolidating on Biome plugins was rejected because GritQL plugins are not ESLint-compatible JavaScript plugins and do not provide the required multi-file and semantic APIs.
**Anchored-bet:** [BET]
**Revisit-when:** Remove each incumbent only when a pinned paired experiment proves diagnostic and scope parity, plus a worthwhile wall-time or memory improvement, first in Devkit and then in Frink; reconsider the topology runner if Oxlint gains custom-parser and arbitrary-file coverage, and reconsider tsc when the candidate supports Frink's TypeScript semantics.
**Scope:** package.json,biome.jsonc,eslint.config.mjs,guard.config.json,gate-engine/structure/**,eslint/**,docs/benchmarks/**
**Source:** shortcut · sc-1674
