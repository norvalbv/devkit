# sentry-eval

Accuracy benchmark for the commit-message **Sentry-advisory judge** (`../check-sentry.mjs`). The
judge's behaviour is set by its prompt + context tier; a prompt edit is unverifiable without a
measurable check. This scores the judge against a labelled set of commit subjects so the **cheapest
config that classifies correctly** can be locked, not guessed.

It imports the judge pieces **from the gate** (`buildPrompt`, `shouldJudge`, `buildContext`,
`judge`), so the bench exercises the exact path the gate runs — prompt and logic never drift.

## SEED corpus (`cases.jsonl`) — replace it with your own

`cases.jsonl` ships a small, **generic** starter set (no repo-specific subjects). It is a **seed,
not data the engine reads at runtime** — the gate never touches it. Copy it into your repo and add
your own **real commit subjects** for a meaningful score on your codebase, then regenerate a baseline
(`--baseline`). **No `results.baseline.json` ships** — it is yours to generate once tuned.

## Run

```bash
node bench.mjs              # confusion matrix + per-category accuracy
node bench.mjs --baseline   # write this run as the new baseline (results.baseline.json)
node bench.mjs --fail       # exit 1 if F1 or accuracy regressed vs baseline
```

Each `claude -p` call pays a cold-start (~20–40s); only `fix|feat|perf|refactor` rows reach the
model — the rest free-skip with zero tokens, exactly like the gate. Budget the judged-row count ×
~30s per config.

> **Run with a clean tree.** If your repo has a `claude -p` auto-fix Stop hook that rewrites the
> model's reply when a changed file has a formatting issue, every judged row scores `NULL`. Format
> the tree first. (The live commit-msg gate is unaffected: pre-commit formats before commit-msg runs.)

## The sweep — the token-economy decision

Pick the **cheapest cell that clears the F1 target**:

```bash
BENCH_CONTEXT=message node bench.mjs   # message-only (default)
BENCH_CONTEXT=names   node bench.mjs   # message + changed-file list
BENCH_MODEL=haiku  ... ;  BENCH_MODEL=sonnet ...   # cheapest model that clears target
BENCH_SHOTS=0 ... ;  BENCH_SHOTS=4 ...             # confirm the few-shot lift (arXiv 2605.02033)
BENCH_SAMPLES=1 ... ;  BENCH_SAMPLES=3 ...         # confirm/deny self-consistency (arXiv 2510.22389)
```

Whatever wins becomes the gate's env defaults (`GUARD_SENTRY_MODEL` / `GUARD_SENTRY_CONTEXT` /
`GUARD_SENTRY_SAMPLES`, and the `buildPrompt(4)` baked into `SENTRY_JUDGE_PROMPT`).

## Dataset format

One JSON object per line:

```json
{ "id": "...", "message": "<commit subject>", "nameStatus": "M\tpath\nA\tpath", "expected": "MONITOR|SKIP", "category": "...", "note": "..." }
```

- `message` — the commit subject (the gate's primary signal).
- `nameStatus` — optional `git diff --cached --name-status` text, so the `names` tier is benchmarkable
  offline. Omit for trivial free-skip rows (they never reach the model).
- `expected` — the ground-truth label. Keep these **deliberately reviewed**; the borderline rows
  (`feat`→SKIP pure-UI, `perf`→MONITOR db-write) are what pin precision.

`MONITOR` = a swallowed runtime error-class (caught error, silent strand, state corruption,
network/db/fs/native/IPC failure handled without crashing). `SKIP` = everything else, including
crashes that ALREADY auto-capture (uncaught/unhandled/native).
