# decisions-eval — accuracy benchmark for the decisions-gate LLM judges

Scores the three LLM judges of the decisions gates against labelled corpora, so a prompt/model/
config edit is a measured delta instead of a guess:

| sub-bench | judge (gate) | verdicts | headline metric | why that metric |
|---|---|---|---|---|
| `detect` | smell-downgrade judge (`../detect.mjs`) | `DECISION` / `ROUTINE` / null | **DECISION recall** | a false ROUTINE silently unrecords an architectural decision — defeats the gate |
| `alignment` | agentic haiku→opus cascade (`../check-alignment.mjs`) | `ALIGN` / `CONTRADICT` / `UNCLEAR` / null | **CONTRADICT precision** | a false CONTRADICT blocks a legitimate commit — the worst outcome |
| `depth` | Target rationale-depth judge (`../check-alignment.mjs`) | `PASS` / `THIN` / null | **accuracy** | warn-only; plain accuracy suffices |

The bench imports the judge runners **from the gates** (`runDetectJudge` / `judgeDetailed` /
`runDepthJudge` + the parsers), so it exercises the exact prompt/argv/truncation/timeout/cascade the
gates run — bench and gate cannot drift.

## Run

```bash
node bench.mjs                    # all three sub-benches
node bench.mjs detect             # one sub-bench (also: alignment, depth; combine freely)
node bench.mjs all --baseline     # write this run as the baseline (results.baseline.json)
node bench.mjs all --fail         # exit 1 if a headline metric regressed vs baseline
node bench.mjs depth-audit        # the 100-year audit: judge YOUR real decision records (below)
```

Exit `0` = ran (no regression under `--fail`) · `1` = regression (with `--fail`) · `2` = could not
run (cases missing, `claude` absent, judge dark — see outage policy below).

Each run prints per-row `OK/FAIL`, a confusion matrix, per-class precision/recall/F1 (+ macro-F1 for
the 3-class alignment judge), the headline metric, and the config line.

## Sweeps

```bash
BENCH_MODEL=haiku|sonnet           # first/only model for all three judges (default haiku)
BENCH_ESCALATE_MODEL=opus|sonnet   # alignment second pass (default opus)
BENCH_CASCADE=on|off               # off = never escalate; score the first pass alone (default on)
```

**The cascade is measured in one run.** A cascade-ON alignment run records both the first-pass
(haiku-alone) verdict and the final (cascade) verdict per row, and reports both metric sets plus the
escalation rate — so "does opus escalation actually rescue false blocks, and how often does it
fire?" (the arXiv:2511.07396 bet) is answered without paying for two runs. `BENCH_CASCADE=off`
exists for cheap prompt iteration: it skips every opus call.

## Corpora (seeds — replace with your own)

The `cases-*.jsonl` files ship small, GENERIC starter sets seeded with the borderline cases each
judge is most likely to get wrong (dep bump vs dep swap; implementation-step vs reversal; deep-but-
terse vs superficially-complete). They are seeds, not runtime data — the gates never read them.
Copy them, add rows from your own repo's history, then lock your numbers with `--baseline`. Every
row carries a `note` saying why its label is right; keep that discipline — borderline rows are what
pin precision.

**No baseline ships.** Generate yours with `--baseline` once you're happy with a config. The file is
gitignored here; commit yours if you want CI regression checks (`--fail` needs it). Changing a
corpus or a judge prompt deliberately invalidates the baseline — inspect the new run, then
regenerate; `--fail` compares raw metric values and cannot tell a corpus change from a regression.

## depth-audit — the 100-year test on YOUR records

`node bench.mjs depth-audit` runs the real depth judge over every Target block in this repo's
decisions dir (`docs/decisions/` by default) instead of the seed corpus. It answers, per record:
could a reader far in the future reconstruct the what / why / rejected-roads — and tell **when the
ruling becomes invalid** (rubric check 4: an explicit `**Revisit-when:**` condition, or a forcing
cost concrete enough to re-measure)? Output is one PASS/THIN line per record plus a `(no
Revisit-when)` marker; informational, always exit 0. A THIN record is one you deepen (append a
Target with `--evidence-change`) or give a `--revisit-when` condition.

### `cases-detect.jsonl`

```json
{ "id": "…", "entries": [{"status":"M","path":"…","added":1,"deleted":1,"depChanged":true,"depKeys":["zod"]}],
  "boundaries": ["api/","worker/"], "diff": "…unified diff…", "expected": "DECISION|ROUTINE|NULL",
  "category": "…", "note": "…" }
```

`entries` is the declarative form of the gate's `gatherEntries()` output and drives the smell floor;
`boundaries` (optional) enables the cross-boundary smell. A row whose entries raise **no smell
free-skips as ROUTINE with zero claude calls** — exactly the gate's path. `diff` (what the judge
sees on stdin, truncated to 12 000 chars by the gate itself) is only read for smelled rows.

### `cases-alignment.jsonl`

```json
{ "id": "…", "expected": "ALIGN|CONTRADICT|UNCLEAR|NO-MATCH", "note": "…",
  "target": { "ruling": "…", "vision": "…", "scope": ["src/**"] },
  "repo": { "base": { "path": "content…" }, "staged": { "path": "content-or-null" } } }
```

The alignment judge is AGENTIC — it Reads files and runs `git diff --cached` in a real repo, so it
cannot be fed a string. Each row is materialised as a **disposable git repo** in the system tmpdir:
`base` is written and committed, `staged` is applied to the index (`null` = staged deletion), scope
matching runs via the gate's own `matchScope`, and `judgeDetailed` investigates that world. The
fixture is removed after the row (a `^C` mid-call may leave one `decisions-eval-*` dir in the
tmpdir). Fixture git never touches your repo: bench start strips the `GIT_DIR` family and every
`GUARD_*`/`FRINK_*` var (either would skew or null the run), and fixtures pin local identity,
`gpgsign=false` and `core.hooksPath=/dev/null`. `target.scope` is the array form of the Target's
comma-separated `**Scope:**` field. Rows whose staged files match no scope glob score `NO-MATCH`
deterministically (the gate's free-skip) — keep a few to pin glob semantics.

### `cases-depth.jsonl`

```json
{ "id": "…", "block": "## Target · 2026-01-01 — …\n\n**Context:** …", "expected": "PASS|THIN", "note": "…" }
```

The Target block goes to the judge on stdin, exactly as the gate sends it. No free-skip class — the
gate judges every staged Target.

## NULL is a verdict

Each parser returns null on ambiguous output, and each gate fails safe in its own direction:
detect null → **the regex block stands** · alignment null → **no block** · depth null → **no warn**.
The bench scores NULL as its own confusion-matrix column, never as an error. Detect rows may even
*expect* NULL (deliberately ambiguous diffs where fail-safe is the right answer) — these are scored
and displayed but **excluded from the `--fail` comparison** (`accuracy (scored rows)`), because
deliberate ambiguity is the least stable ground truth. Expect them to be your flakiest rows.

## Outage policy (asymmetric by cost — deliberate)

A judge that cannot run (claude absent / offline / quota / timeout) is an **outage**, distinct from
a parse-NULL (the judge ran and was ambiguous):

- **detect / depth** rows cost ~30 s: the first dark row aborts the run (exit 2, sentry-style) — a
  polluted run is worth less than a rerun.
- **alignment** rows cost 1–6 min: a mid-run outage scores that row NULL, counts it in the summary's
  `outages`, and continues — the spend is preserved. Exit 2 only when *every* judged row was an
  outage. If `outages > 0`, treat the score as suspect and rerun.

## Cost

Every judged row is a `claude -p` cold start. Budget (printed before any token is spent):

| sub-bench | judged rows in seed | per row | seed cost |
|---|---|---|---|
| detect | ~15 of 20 (5 free-skip) | ~30 s | ~8 min |
| depth | 15 | ~40 s | ~10 min |
| alignment | 11 of 14 (3 NO-MATCH) | 60–120 s (+120–240 s per opus escalation) | ~20–40 min |

Sweep accordingly: iterate prompts on `detect`/`depth` first, run `alignment` when the cheap benches
are stable, and use `BENCH_CASCADE=off` while iterating the alignment prompt.

## Departures from the sentry eval (the house pattern)

- three corpora + a fixture-repo harness (the alignment judge is agentic — stdin won't do);
- `results.baseline.json` is gitignored here (sentry leaves it to discipline);
- per-row outage tolerance for alignment (sentry aborts on the first dark row — its rows are cheap);
- `bench.mjs` is importable (`invokedDirectly` guard) so the metrics/fixture logic is unit-tested in
  `../__tests__/eval-bench.test.mjs`.

The judges run under the shared isolation flags (`--settings '{"disableAllHooks":true}'`,
`--no-session-persistence`, read-only for the pure-text judges), so host hooks can't rewrite
verdicts and bench runs leave no session transcripts. Still run with a clean tree: the alignment
judge diffs *staged* state, and your own staged changes are irrelevant noise in its cwd — the
fixtures isolate it anyway, but the detect/depth judges execute in your cwd.
