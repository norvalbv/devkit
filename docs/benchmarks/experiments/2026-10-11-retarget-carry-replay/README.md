# Re-target carry/drop: can a writer answer the listing per note?

**Status: PRE-REGISTERED. No writer call has been made.** Results are appended below the line at the
end of this file after the run; nothing above that line is edited afterwards.

## Question

When `guard-decisions add <slug> --target` re-targets an axis, every reader of the axis serves the
newest Target and the notes under it, so the notes left under the outgoing Target leave every reader.
The prototype lists each live, non-rescope note under the outgoing Target and asks the writer to
answer every id with `--carry` (re-record it under the new Target) or `--drop` (leave it as history).
There is no default.

The listing is only worth shipping if a writer answers it usefully: it must carry the notes that still
bind the code and drop the ones that are history or retired. This replay measures that, text-only,
before any of the code ships.

## What is frozen

| Input           | Pin                                                                                                                                                                                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Decision corpus | `c29e78e6` (`docs/decisions/`, read with `git show`)                                                                                                                                                                                                                                        |
| Prototype       | `prototype.patch` against `39a5d375`, sha256 `030f160319fa0d62fd19a63f4e4f199cbc6681589f03c1d1dd1bc7d62b252655` (archived with the frozen inputs in a local research repo, commit `9283ed3`)                                                                                                |
| Prompts         | `prompts.jsonl`: per axis, the listed ids, the immediately-prior subset, and the sha256 of the exact prompt bytes. `node replay.mjs build --check` re-renders them from the corpus through the module and fails on any byte difference; `call` refuses to send a prompt whose hash differs. |
| Gold            | Room-3 Q7 `bench/q7/final-labels.tsv` at `41f7b558` (branch `swarm/swarm-234901-pmyh-room/recruit-Q7`), mapped to axis-wide note ids in `labels.tsv`                                                                                                                                        |
| Models          | `claude-opus-5-5` (gating), `claude-haiku-5-5` (reported)                                                                                                                                                                                                                                   |

## Corpus and prompt

The 14 axes at `c29e78e6` that hold live notes under a superseded `## Target ·` block. Each prompt
lists every non-rescope note under every superseded Target of its axis (the collapsed steady state:
163 notes in all), built by calling the prototype's `outgoingNotes()` on the body cut at each later
Target heading, so each id is the one the CLI printed at that historical re-target. The prompt is:

1. one framing line (the writer is recording a new Target on the axis);
2. the prototype's `formatPending()` output, verbatim (the CLI's stderr listing);
3. the newest Target block (fields only; in the real event the incoming Target has no notes yet);
4. one line asking for `--carry "<ids>" --drop "<ids>"`, every listed id exactly once.

Rescope notes are never listed (13 of the 178 Q7 items: 9 labelled B, 4 labelled S), so no glob is
ever offered for carrying. `coverage-gate#1.0` (D-T) is not listed because its bullet,
`- 2026-07-25 (sc-1214) — …`, is not in the minted note-id shape. `plan-critique-evidence-loop` drops
out because its one note sits in a non-Target section.

## Scoring classes (`labels.tsv`, column `scored_as`)

| Class     | Items     | Rule                                                                                                                                                                                                                                             |
| --------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1        | 34        | Q7 label D, guard N: still true of the code, no test reference, not in the newest Target. Should be carried.                                                                                                                                     |
| C2-text   | 18        | 14 A whose label needed no code check, plus 4 C. History, or retired by a note or Target visible in the same prompt (e.g. `oxc-toolchain-migration#1.1` by `#1.7`, `review-gate-in-chain#2.20` by `#5.1`). Should be dropped.                    |
| A-repo    | 7         | `gate-opt-out-is-visible-and-detectable#1.0`, `coverage-gate#1.5`, `agent-comment-firewall#2.1`–`#2.4`, `agent-comment-firewall#3.0`. Their A label rests only on the code being gone, which a text-only writer cannot see. Reported, not gated. |
| excluded  | 2         | `agent-comment-firewall#4.1` (contested, below) and `plan-critique-evidence-loop#3.0` (non-Target section).                                                                                                                                      |
| B, D-T, S | 30, 83, 4 | Reported carry rates only.                                                                                                                                                                                                                       |

### Adjudication, fixed before any call

- The six items the Q7 first pass flagged `(check …?)` were resolved with code evidence in Q7's
  `finalize.mjs` RESOLVE table (`41f7b558:bench/q7/finalize.mjs:8-13`) and re-confirmed at `c29e78e6`.
- `agent-comment-firewall#2.1`, `#2.2`, `#2.3`, `#2.4` and `#3.0` stay A. Outside docs, no code has
  `judgeComments`, `planCommentBatches`, `receiptKey`, a rationale store or `--from-ship-log`;
  `gate-engine/comment-firewall/__tests__/gate.test.mts:155` asserts `--from-ship-log` is absent; the 2026-09-02 Ruling lists all of them as
  deleted.
- `agent-comment-firewall#4.1` is excluded as contested. Its separate hook lane is gone, but its
  property still holds: comments is a guard-deterministic sub-gate
  (`gate-engine/deterministic/registry.mts:49`, `cli/lib/husky/husky-block.mts:73`), the deterministic
  lane defers under review|dry-gates (`cli/lib/husky/gate-policy/block-helpers.mts:10-13`), and the
  2026-09-30 Ruling restates this. It is neither clearly C nor clearly D-N.
- `plan-critique-evidence-loop#3.0` is excluded: it sits in a non-Target section.

## Protocol

- Writer call: `claude -p --model <id> --output-format json --strict-mcp-config --mcp-config
'{"mcpServers":{}}' --setting-sources '' --disallowedTools '*' --settings
'{"disableAllHooks":true}' --no-session-persistence`, prompt on stdin, a fresh temp cwd, `GIT_*`
  stripped, `DEVKIT_NO_TELEMETRY=1`, 300 s timeout. A failed call (non-zero exit, `is_error`, empty
  result) is retried up to 3 attempts; every attempt is an appended row. Concurrency 3.
- Probe, K=1: 14 axes x 2 models = 28 calls. Its rows are scored data (opus rep 1, haiku rep 1).
- Full run: opus reps 2 and 3 = 28 calls. **56 calls in total**, plus retries of failed calls.
- Parsing: the text after each `--carry` / `--drop` token up to the next one; ids by the note-id
  regex, so quoting does not matter. An id in both lists, an id not listed for that axis, or a listed
  id left unanswered counts as a drop for that item; such answers are counted and reported.
- Gating score: opus majority of K=3 (an item is carried when at least 2 of 3 reps carry it).
- Raw rows stay outside the repository. `results.json` holds the parsed writer answers only;
  `summary.json` the scores.

### Probe stop conditions

Stop before the full run if 3 or more of the 28 probe cells end without a usable answer, or if a
well-formed answer is misparsed. Only the harness may then change; the prompt bytes are frozen. If the
prompt itself proves defective, the experiment is reported INCONCLUSIVE, not re-prompted.

## Pass rule (opus only)

- **C1:** carried C1 >= 28 of 34.
- **C2:** carried C2-text <= 4 of 18.

Both pass: ship the listing in the warn phase (it prints and still writes), file the story that
turns an unanswered re-target into a refusal in the next minor release with this record as its
evidence, and record the Target through the CLI. Either fails: ship nothing but this record plus a
dated note on `decision-note-supersession-declared`. Either way the glob-rule story (Scope globs are
out of this flow) and the sc-5196 acceptance-criteria amendments stand.

## Zero-LLM controls (`node replay.mjs controls`)

| Policy       | C1    | C2-text | Verdict |
| ------------ | ----- | ------- | ------- |
| always-carry | 34/34 | 18/18   | FAIL    |
| always-drop  | 0/34  | 0/18    | FAIL    |
| gold oracle  | 34/34 | 0/18    | PASS    |

Neither degenerate policy passes, and a gold-correct writer can.

## Reported, not gated

Haiku C1 and C2-text; the A-repo carry rate; B and D-T carry rates; the immediately-prior-Target
subset scored from the same answers (20 C1, 6 C2-text, 2 A-repo, 0 C — the notes the CLI would list at
the most recent real re-target); a per-axis table (`review-gate-in-chain` and `coverage-gate` supply 21
of the 34 C1 items, so per-axis results lead and no interval is computed over clustered items);
opus run-to-run agreement; invalid-answer and unanswered counts; cost.

## Reproduce

```
node replay.mjs build --check                    # prompts match the module byte for byte
node replay.mjs labels <q7-final-labels.tsv>     # regenerates labels.tsv
node replay.mjs controls
node replay.mjs call --phase probe               # 28 calls
node replay.mjs call --phase full                # 28 calls
node replay.mjs score                            # results.json + summary.json
```

`REPLAY_RUNS` sets where raw rows go (default `~/.devkit/research/2026-10-11-retarget-carry-replay/runs`).

---

## Results

**Verdict: FAIL.** Opus carried every note that still binds the code (C1 34/34) but also carried 8
of 18 history or retired notes (C2-text, bar <= 4). Nothing but this record ships.

### Run

- Pre-registration committed in `c81607ba` at 13:44:44Z on 2026-10-11; the first call started at
  13:45:38Z. Every call ran with that commit checked out (Claude Code 2.1.296).
- Probe 13:45-13:47Z, full run 13:48-13:50Z. 56 calls, all usable on the first attempt: no retry, no
  invalid id, no id in both lists. One listed item went unanswered (haiku, `review-gate-in-chain`
  `note:2026-08-09`; scored as a drop). Cost $3.87: probe $1.34, full run $2.54.
- **Harness amendment after the probe; prompt bytes unchanged.** 2 of the 14 opus probe answers named
  every listed id without its `note:` prefix (`--carry "2026-08-02~2,2026-08-03,…"`). The
  pre-registered parser read those as no answer at all: a well-formed answer misparsed, which is a
  stop condition. As the protocol allows, only the harness changed: a bare `YYYY-MM-DD[~N]` token now
  parses as `note:YYYY-MM-DD[~N]`. In the end 12 of 42 opus answers used bare ids. Under the original
  parser the verdict is also FAIL (C1 24/34, C2-text 6/18).
- `prototype.patch` (sha256 `030f1603…2655`, the pinned prototype) is committed here because the
  module does not ship. `git apply prototype.patch` on `39a5d375` and then
  `node replay.mjs build --check` reproduces `prompts.jsonl` byte for byte.

### Gating (opus, majority of K=3)

| Class                                       | Carried | Bar   |          |
| ------------------------------------------- | ------- | ----- | -------- |
| C1 (still binds, untested, not restated)    | 34/34   | >= 28 | pass     |
| C2-text (history, or retired in the prompt) | 8/18    | <= 4  | **fail** |

Per rep: C1 34, 34, 33; C2-text 7, 7, 8. All three reps agree on 158 of 163 listed items, so the
failure is not run-to-run noise.

### Reported

| Class                                      | opus (maj. K=3) | haiku (K=1) |
| ------------------------------------------ | --------------- | ----------- |
| C1                                         | 34/34           | 34/34       |
| C2-text                                    | 8/18            | 5/18        |
| A-repo                                     | 2/7             | 7/7         |
| B (restated by the newest Target)          | 18/30           | 18/30       |
| D-T (still true, has a test)               | 81/83           | 77/83       |
| excluded `agent-comment-firewall#4.1`      | carried 3/3     | carried     |
| excluded `plan-critique-evidence-loop#3.0` | not listed      | not listed  |

Haiku would also fail the C2 bar (5/18). The immediately-prior-Target subset (the notes the CLI lists
at the most recent real re-target) reads the same: opus C1 20/20, C2-text 3/6; haiku C1 20/20,
C2-text 2/6.

The 8 C2-text items opus carried (opus votes / haiku vote, then the Q7 gold clause):

| Item                                      | Note                | opus | haiku | Gold                                                                        |
| ----------------------------------------- | ------------------- | ---- | ----- | --------------------------------------------------------------------------- |
| `benchmarks-grow-from-telemetry#1.2`      | `note:2026-08-02~2` | 3/3  | 0     | A: noise-floor measurement; the bound itself is restated in the Ruling      |
| `oxc-toolchain-migration#1.6`             | `note:2026-08-16~6` | 3/3  | 0     | A: dogfood summary                                                          |
| `oxc-toolchain-migration#1.8`             | `note:2026-08-22`   | 3/3  | 1     | A: test-ownership statement, descriptive                                    |
| `oxc-toolchain-migration#1.9`             | `note:2026-08-23`   | 3/3  | 1     | A: opt-in retired; its runtime-only clause retired by the 2026-09-03 Target |
| `review-gate-in-chain#5.0`                | `note:2026-08-31`   | 3/3  | 1     | A: implementation-complete report and eval figures                          |
| `review-gate-in-chain#5.4`                | `note:2026-09-02`   | 3/3  | 1     | A: a judge retired from the light-judge family (history)                    |
| `suite-hangs-bound-at-the-spawn-site#1.5` | `note:2026-09-06~5` | 2/3  | 0     | A: benchmark-runner correction                                              |
| `review-gate-in-chain#2.20`               | `note:2026-08-04~9` | 2/3  | 1     | C: checklist recovery is review-only, retired by `note:2026-08-29`          |

Per axis, the C1 and C2-text items concentrate where the pre-registration said they would:
`review-gate-in-chain` (C1 12/12, C2-text 3/4) and `oxc-toolchain-migration` (C1 3/3, C2-text 3/7).
`coverage-gate` carried all 9 of its C1 items and has no C2-text item. Full per-axis counts are in
`summary.json`.

### Reading

The writers do not answer per note: both models carry almost everything that reads as a statement
about the code (D-T 81/83, B 18/30 for opus), including history phrased as fact ("the judge was
retired", "the runner was corrected"). The listing would have got every buried constraint carried
forward, and it would also have copied about half of the history into each new Target. A required
answer adds friction to every re-target (at historical rates, counted at `eadfcdc2`, 23 of 48 re-targets list a
note; median 5 among those), so a mechanism whose answers barely separate rule from history is not worth that cost.
The writer was text-only, so a session that can read the code might do better on A-repo items; that is
untested. Opus dropped 5 of the 7 (the agent-comment-firewall judge, receipt and rationale-store notes)
and haiku carried all 7.

Not tested: another wording of the listing, listing only notes that read as rules, or a writer that can
open the code. Any of these is a new experiment with its own pre-registration; this record does not
license re-running the same prompt.

### What ships

This record (`README.md`, `replay.mjs`, `labels.tsv`, `prompts.jsonl`, `prototype.patch`,
`results.json` with the parsed writer answers only, `summary.json`) and a dated note on
`decision-note-supersession-declared`. Raw call rows stay outside the repository. The glob half (Scope
globs a re-target drops) is out of this flow either way and has its own follow-up story.
