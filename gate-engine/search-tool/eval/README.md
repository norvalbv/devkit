# Search Tool Eval

> Dev-only bench. Not a skill, not agent-invokable. Run manually from terminal.

Scores the classifier in `../search-tool-guard.mjs` against `queries.json` (a
frink-agnostic SEED corpus — copy it and add your own domain queries). Each query
has an `expected_tool` and a reason. The script reports per-query results plus
false-positive / false-negative counts.

## The hooks under test

| File | Hook | Role |
|---|---|---|
| `../search-tool-lib.mjs` | — | Shared classifier logic: `normalize` (strip `cd` prefix + unwrap `rtk`), `stripQuotes`, `extractPattern`, `classify`, `hasCommandSearch`, `isPrimarySearchCommand`. Single source of truth for both hooks. |
| `../search-tool-guard.mjs` | PreToolUse | Warns (or, in `SEARCH_GUARD_MODE=block`, asks) when a single grep looks conceptual. |
| `../search-tool-counter.mjs` | PostToolUse | Catches concept-by-*enumeration* — N consecutive primary search commands in one session (threshold 3), counting clean-identifier greps too since the agent hunts concepts with valid-syntax greps. Resets on a semantic-search call or any non-search command. |

The steered tool names (`searchTool` / `graphTool`) come from `resolveGuardConfig`
(the consumer's `guard.config.json` + `GUARD_*` env), defaulting to
`mcp__codebase__searchCode` / `graphify`.

## Tests

Unit + integration tests live under `../__tests__/` (vitest):

```bash
vitest run gate-engine/search-tool/
```

- `search-tool-lib.test.mjs` — pure-function unit tests for the shared lib.
- `search-tool-hooks.test.mjs` — spawns the real hooks over the stdin JSON contract (guard fire/quiet, modes, counter streak/reset, graceful degradation).

## How

```bash
node gate-engine/search-tool/eval/eval.mjs           # full table
node gate-engine/search-tool/eval/eval.mjs --fail    # exit 1 on regression (CI)
```

## Adding queries

Edit `queries.json`. Pick `expected_tool` from:

| value | meaning |
|---|---|
| `grep` | exact identifier or error string — should NOT be flagged |
| `find_glob` | filename pattern — should NOT be flagged |
| `searchCode` | conceptual / semantic — SHOULD be flagged |
| `graphify_affected` | impact / callers query — SHOULD be flagged |
| `graphify_explain` | "explain X" — SHOULD be flagged |
| `graphify_path` | relationship between two nodes — SHOULD be flagged |

The eval treats anything other than `grep`/`find_glob` as "should be flagged".

## Out of scope

Live-agent runs (firing queries at the model API to observe the actual tool
chosen) cost real tokens. The classifier is a proxy: if the hook flags conceptual
greps reliably, the agent's worst-case behaviour is at least interrupted.
