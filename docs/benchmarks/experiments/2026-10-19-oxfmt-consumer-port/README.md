# Consumer Oxfmt port — formatting churn probe, 2026-10-19

**Verdict:** ship Oxfmt as the only consumer formatter, with the starter in
`oxc/oxfmtrc.starter.json` (devkit's own reviewed formatting block, a CSS `singleQuote: false`
override, and `.devkit` / `.anti-slop-baseline.json` ignored). Each existing Biome consumer is
migrated by hand: its `biome.jsonc` exclusions and formatter opt-outs become `.oxfmtrc.json`
`ignorePatterns` before `devkit upgrade`.

This is a one-time evidence probe for Shortcut sc-2687, not a recurring benchmark. It closes the
consumer leg of [`oxc-toolchain-migration`](../../../decisions/oxc-toolchain-migration.md). Devkit
(sc-1679, sc-1787) and Frink (sc-1685) had already switched themselves. No timing samples were taken:
the decision turns on churn and style parity, not speed.

## Method

[`probe.sh`](probe.sh) takes each consumer's **committed** tree (`git archive HEAD`), drops in the
starter as `.oxfmtrc.json`, and runs devkit's pinned Oxfmt 0.63.0 the way the pre-commit step does:
explicit paths matching the step's extension filter, with `--no-error-on-unmatched-pattern --write`.
It reports files and hunks changed, CSS files changed, a second pass for idempotence, and which
extensions a bare `oxfmt .` would also touch.

```
probe.sh <devkit checkout> <consumer repo>...
```

## Results

| Consumer | Formattable | Changed | Hunks | CSS changed | Pass 2 changed | Bare `oxfmt .` also touches |
| --- | --- | --- | --- | --- | --- | --- |
| bug-mcp | 81 | 21 | 293 | 0 | 0 | 81 md |
| frink-marketing | 820 | 77 | 3598 | 1 | 0 | 329 md, 1 html |
| claude-usage-dashboard | 302 | 181 | 1591 | 1 | 0 | 47 md |
| repo-graph | 122 | 1 | 10 | 0 | 0 | 43 md, 1 html |
| agent-chatroom-mcp | 10759 | 4794 | 22169 | 0 | 3 | 924 md |

## Reading

- **bug-mcp's churn predates this change.** `biome format .` in the real checkout reports 20 of
  the same 21 files as unformatted under Biome itself (devkit-synced hook scripts and `src/`), so
  the tree was never Biome-clean.
- **frink-marketing is Biome-clean, and its churn sits in paths its `biome.jsonc` excludes.** These
  include `.claude/skills`, `.decisions/index.json` and `docs/marketing/section-2/published`.
  Excluding those paths leaves 6 authored files with formatter-only hunks: CSS `font-family` lists
  broken one per line, parentheses around `typeof import(...)`, and an `await import` rewrapped. Its
  hand migration must carry those exclusions into `ignorePatterns`.
- **CSS quote parity holds.** The one changed CSS file per repo is line-wrapping only; the
  `singleQuote: false` override keeps CSS strings double-quoted, as Biome's preset did.
- **agent-chatroom-mcp turns Biome's formatter off** and hand-maintains double quotes. Its migration
  is the opt-out `{"ignorePatterns":["**"]}`, not the starter. The probe shows what not opting out
  would cost. Its 3 files that changed again on a second pass are moot under the opt-out.
- **A bare `oxfmt .` formats markdown and HTML,** which Biome never touched. The consumer `format` and
  `lint` scripts therefore pass the step's extension glob rather than `.`.
- **Lint:** the consumer Oxlint base now denies the `correctness`, `suspicious` and `perf` categories
  plus `react/rules-of-hooks`, the categories sc-1787 adopted for devkit itself. Biome rules with no
  Oxlint owner are retired rather than approximated, as sc-1787 did for devkit: `organizeImports`
  (Oxfmt import sorting stays off), `useTopLevelRegex`, JSON/CSS lint and the React a11y set.
