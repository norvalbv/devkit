# Agent benchmarks

Golden trap-set for the **review agents whose judgement is set by prompt** — `feature-critique` and
`feature-completeness-reviewer`. A prompt edit is unverifiable without a measurable check; this is
that check. Born from the 2026-06-10 miss where both agents blessed a band-aid that fixed a *display*
symptom of an unbuilt Target (`provider-config-canonical-home`) — see memory
`feedback_challenge_the_frame_not_just_approach`.

## Run

```sh
node scripts/agent-benchmarks/run.mjs            # all cases
node scripts/agent-benchmarks/run.mjs case-01    # one case (id prefix)
FRINK_BENCH_MODEL=sonnet node scripts/agent-benchmarks/run.mjs
```

Each run feeds the agent its own instructions + a BENCHMARK directive (all context inline, no tools,
emit only the summary block) via `claude -p`, then scores `VERDICT` / `FRAME_META` / keyword
presence. It measures the agent's **intrinsic** frame reasoning — the `check-critique.mjs` meta-judge
is a separate net, not exercised here.

## Cases (5 trap classes)

| id | trap | expected |
|---|---|---|
| `case-01-bandaid` | fix hides a symptom of an UNBUILT Target | RETHINK/REJECT + name the canonical-home Target (the regression test) |
| `case-02-fine` | genuinely sound, well-scoped fix | PROCEED — must NOT over-flag |
| `case-03-contradict` | directly reverses a recorded non-negotiable Target | REJECT + name the deny-list Target |
| _todo_ `case-04-notabug` | reported "bug" is expected/Target behaviour | "this is not a bug" |
| _todo_ `case-05-realfix` | real bug, sound fix | PROCEED WITH CHANGES + the actual issues |

## Add a case

Drop two files in `cases/`:
- `<id>.prompt.md` — a **self-contained** critique request: the plan + the relevant `RECORDED
  TARGET(S)` inlined verbatim (the agent gets no repo access in benchmark mode).
- `<id>.expected.json` — `{ agent, expectVerdict[], expectFrameMeta[], requireAny[], forbid[], note }`.
  **Over-flagging is guarded by `expectVerdict` + `expectFrameMeta`** (parsed from the VERDICT/FRAME_META
  lines) — NOT by `forbid` word-search, which false-trips when a *sound* critique says "this is not a
  band-aid". `requireAny` checks the key finding is named. `forbid` is only for content that should never
  appear regardless of verdict (keep it empty unless you have such a case).

Keep the set honest: every prompt change to these agents should be validated here before shipping,
and a real-world miss (like case-01) should become a permanent case.
