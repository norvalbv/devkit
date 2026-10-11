# decisions-brief: does the pre-edit brief change what an agent writes?

The decisions guard's pre-edit hook (`agents-hooks/decision-scope-brief.mjs`) shows an editing agent
the rulings that govern a file before its first write. This suite measures what that brief changes in
the edit. It is dev-only (catalog suite `decisions-brief`, lifecycle experimental) and never runs at
commit or in CI.

## How a session runs

1. A scratch git repo is seeded from a frozen task (`docs/benchmarks/decisions-brief/tasks/<id>/repo`).
2. For hook arms, `.claude/settings.json` registers `HOOK_REGISTRATIONS.decisions` exactly as
   `devkit init` would, with each command wrapped by `tap.mts`. The scripts that
   `hookScriptsFor({ decisions: true })` selects are copied from this tree's `agents-hooks/`.
3. Only `guard-decisions` is stubbed: `node_modules/.bin/guard-decisions` runs `stub.mts`, which
   answers from the task's frozen `brief.json`. The child's PATH puts that directory first, so a bare
   `guard-decisions show` reaches the stub rather than a global install.
4. `claude -p` edits the repo on `claude-haiku-5-5` with the same flags in every arm, and the task's
   `check.sh` scores the result: 0 = rule kept, 1 = broken, 2 = not done.

There is no copy of the brief formatter here. A change to the hook's cap, text, timing or
registration is measured as shipped, and it changes the replay key, so old rows are never reused.

The tap passes stdout, stderr and the exit code through unchanged. It records, outside the scratch
repo, which slugs the brief named, its length, whether it carried the task's `bindingText`, and
whether it was the "DID NOT RUN" outage notice. The stub logs every call with its caller (hook or
agent).

## Arms and tasks

| arm | hooks | agent may run the stub |
|---|---|---|
| `none` | no | no |
| `brief-only` | shipped | no: print mode denies Bash |
| `read-on` | shipped | yes: `--allowedTools` for guard-decisions, head and tail |

`tasks.json` gives each task a role. The 8 **clause** tasks bind on a clause past character 320 of
the target ruling; agents break them without a brief. The 9 **floor** tasks need no brief, so they
catch harm from extra text. The **probe** (`q2-outage`) is outside the default plan; run it with
`--only q2-outage`. Its check scores behaviour (an unrecognised failure is not permanent), not the
literal label.

The study that built these tasks measured, on claude-haiku-5-5 at K=5:

| cell | none | brief cut at 320 | whole ruling | read-on at 320 |
|---|---|---|---|---|
| clause tasks, rule kept | 0/40 | 1/40 | 37/40 | 38/40 |
| floor tasks, edit correct | 45/45 | 41/45 | 45/45 | |

The first run of this suite must land in those bands: they are its reproduction check.

## What it does not measure

These are best-case tasks: one small edit, one on-point ruling, no other injected context. Results
compare a before and an after on one corpus; they are not field rates. On the bench the agent follows
the brief's pointer in almost every read-on run, while real sessions open a briefed record far less
often, so `read-on` is a positive control. With 8 clause clusters, only effects of about 15 points or
more are detectable, and a null result on a small change proves nothing.

## Run

From the repository root:

```sh
B=gate-engine/decisions/eval/brief/bench.mts
node $B validate                # zero LLM: every fixture fails to pass in the run's scratch setup
node $B run                     # dry run: prints the 210-session plan, spawns nothing
node $B run --k 1 --yes         # 42-session probe, one per cell
node $B run --yes               # K=5; finished rows (the probe's rep 0 included) replay
node $B report                  # per-cluster table and metrics against results.baseline.json
node $B report --write-baseline
```

A full plan costs about $1.40 and 15 minutes at concurrency 6. Every run re-validates the fixtures,
forces `DEVKIT_NO_TELEMETRY=1`, `DISABLE_AUTOUPDATER=1` and `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` in the
child, and stops after 3 consecutive outages. Rows land in
`gate-engine/decisions/eval/progress-brief.jsonl` (gitignored). A row replays only under the same
model, CLI version, hook and harness bytes, registrations and corpus; outage rows (an agent failure
or a killed check script) are never replayed, so re-running the same command resumes.

## Metrics and validity

Published, none arm excluded, each with a 0.15 noise floor (about the Wilson-95 half-width of a
40-run cell at p = 0.5):

- `clause-kept-brief-only`, `clause-kept-read-on`: rule kept, exit 2 counted as not kept;
- `floor-good-brief-only`: floor edits still correct;
- `clause-shown-brief-only`: the delivered brief contains the binding clause.

Cells (`task@arm`) carry counts only and no `ok` flag, so 5-run majorities cannot flip a verdict.
`floorsMet` requires every cell at n = K, every hook-arm edit of the task file briefed with the
target slug and no outage notice, the none-arm screens (clause kept at most 10%, floor good at least
90%), and a single model and claude version across all rows.

## Before/after protocol

A PR that changes brief delivery runs the default plan at its head, then `report`.

- `improved`: Δ above +15 points and, for kept metrics, a cluster mid-p below .05. `regressed`: Δ
  below −15 points. Otherwise flat. The tracker applies the same noise floor, so the dashboard agrees.
- `report` refuses a contrast when the model or CLI version differs from the comparison rows.
- If they match the committed baseline, publish a `quality` event.
- Otherwise run the plan at the PR's base in a worktree on the same CLI and pass
  `report --base <that worktree's progress-brief.jsonl>`. Publish the base re-run first as
  `--change-type methodology-reset` (the instrument changed), then the head as `quality`. `publish`
  itself compares hashes, not CLI versions.

Adding or replacing a task changes the corpus hash and is a methodology-reset event.

## Auditing a score

Each row in `progress-brief.jsonl` names its scratch repo in `tmp`. `git -C <tmp> diff` shows the
agent's edit, and `bash <task dir>/check.sh` run there reproduces the score. The row's `result`
field holds the agent's closing message.

## Extending it

Plan-time delivery, a real-CLI `show` for the rule card, and a Sonnet confirmation arm each need
their own arms and fixtures; add them here and pay for them in the PR that needs them.
