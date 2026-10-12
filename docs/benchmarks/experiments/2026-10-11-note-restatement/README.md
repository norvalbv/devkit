# Note restatement: can a writer restate a ruling that a note changes? — 2026-10-11

**Status: complete. Verdict FAIL** (see Results). The `--kind alters --ruling` code is not built.

**What it gates.** A planned `guard-decisions add --note --kind progress|alters` option. An alters
note passes `--ruling`, the whole current rule restated, and that restatement replaces the ruling
for every reader: the pre-edit brief, detect, the reviewers' Targets block, the alignment check,
`query` and INDEX. That code is built only if this experiment passes. This record ships either way.

## Question

When a dated note extends, narrows or walks back its Target's ruling, can an agent restate the whole
ruling as one text that, within 2000 characters:

- (i) carries the note's binding clause;
- (ii) keeps every sentence the note leaves unchanged, word for word;
- (iii) drops every sentence the note walks back, instead of keeping it next to the correction?

And does the agent pick `--kind alters` for those notes without picking it for notes that only log
progress?

## Why the restatement is tested before any code

An earlier study of the same log at c29e78e6 measured the gap; its rows are not part of this record.

- 16 of a random 60 of devkit's 283 live notes alter their ruling: 26.7%, Wilson 95% [17.1, 39.0].
- Serving the whole ruling did not keep a rule that lives in a note: 7/45 runs kept it, against 6/45
  with no brief at all.
- Serving the note as a second text made the agent refuse and stop in 13/45 runs.

A writer that restates the rule as one text would close the gap. Its failure mode is worse than the
gap, because a lossy or contradictory restatement replaces the rule for every reader at once. So
this test runs first, and it is built to fail on the worst case: a walked-back sentence kept next
to its correction, which the CLI's sentence check cannot see.

## Inputs, pinned at c29e78e6

- **Source.** devkit's decision log at c29e78e6 (release v0.68.0). A live note is a dated bullet
  under its axis's newest Target: 283 live notes on 88 Target-bearing axes. Each item carries the
  current Target's Ruling field and the note's text with its date prefix stripped. The extraction's
  sha256 is `fb6d95b677f93d9ab5ee145070d892e4bab70e2e22bb41a0f3a52ada6f8be27a`. `score.mjs` checks
  that every ruling and note occurs verbatim in `git show c29e78e6:docs/decisions/<slug>.md` and
  matches its recorded sha256.
- **Labels that existed before this pre-registration.** One rater labelled a random 60 of the live
  notes L/E/N/W (16 altering: 13 E, 1 N, 2 W; 44 L). A haiku pass with the same rubric labelled all
  283 (14 W).
- **Restatement items: 29.** The 16 altering notes of the 60, plus 15 walk-back (W) candidates:
  - the haiku pass's 14 W;
  - the 60-note sample's 2 W, one of which the haiku pass also marked W;
  - `ship-gates-converge-not-restart#35`, dated 2026-10-06, "Correction to the Ruling's clause (3)";
  - minus `gate-inputs-single-registry#1`, whose ruling is already 2,784 characters, over the bound.
- **Kind-recognition items: 60.** The 60-note sample with its labels: L means progress; E, N and W
  mean alters.

## Gold (`cases.jsonl`, `kind-cases.jsonl`)

`cases.jsonl` holds the first rater's gold for the 29 restatement items, written before any call:

- `sentences`: the ruling split by `rulingSentences()` in `score.mjs`. That is
  `Intl.Segmenter('en', {granularity: 'sentence'})`, whitespace collapsed, empty pieces dropped; the
  CLI reuses the same split. A sentence is `altered` when the note makes it false or incomplete, so
  a faithful restatement may rewrite it.
- `noteClause.mustContain`: 1 to 3 strings found in the note and not in the old ruling, which any
  restatement of the note's binding clause contains.
- `rater1Label`, plus, for a W label, `staleSentences` (the sentences the note makes false) and
  `staleMarkers` (short strings from those sentences that flag a paraphrase for adjudication).

A W candidate that the first rater does not label W carries no clause gold: it cannot be confirmed.

## Second rater, before any call

**Stage 1, blind.** A second human rater reads `rater2-candidates.md`, which holds the 15 W
candidates without the first rater's labels. They label each L/E/N/W with the rubric and, for a W,
name its stale sentences by number. The answers are committed as stage-1 rows of
`rater2-labels.jsonl` (`{id, stage: 1, label, staleSentences, rater, date}`) before stage 2 starts.

**Confirmation rule.**

- A candidate is a confirmed W when both raters label it W and their stale-sentence sets share at
  least one sentence.
- Its gold stale sentences are the shared ones. A sentence only one rater names is contested: it is
  neither required in (ii) nor required absent in (iii).
- Disagreements are dropped. An unconfirmed candidate outside the 16 sample items leaves the run.
  The 16 sample items always run; an unconfirmed sample W runs without (iii).
- The run set is the 16 sample items plus the confirmed W candidates, so N ≤ 29.
- **Fewer than 8 confirmed W items makes the experiment inconclusive.** No call is made, this record
  ships with that outcome, and the code is not built.

**Stage 2, gold check.** After stage 1 is committed, the rater reads
`node score.mjs --gold-sheet` and checks each run item's `mustContain` strings and its keep / may
change sentence flags. A correction is a stage-2 row (`{id, stage: 2, mustContain?,
alteredSentences?, rater, date}`); it can change those two fields only, never a label or a stale
set. No correction is a row-free outcome, recorded in the adjudication log below.

## Controls, zero LLM, before any call

`node score.mjs --controls` must print PASS on the confirmed run set. It first checks the gold
itself: hashes, provenance at c29e78e6, the sentence split, mustContain in the note and not in the
ruling, and stale sentences flagged altered.

- **C1**, the old ruling as the output: (i) holds on 0/N items, and (iii) fails every confirmed W.
- **C2**, the old ruling plus the note, length rule off: (i) holds on N/N, (ii) on N/N, and (iii)
  fails every confirmed W.

C2 is the "append the correction" writer. It must fail (iii); otherwise the test cannot see the worst
case. Both controls pass on the first rater's preview set at this commit. A deviation stops all
calls until a dated addendum fixes the scorer or the gold.

## Frozen inputs

- `skill-notes-section.md`: the Notes section of `skills/decisions/SKILL.md` as the code would ship
  it. The code PR ships it byte-identical.
- `writer-prompt.txt`: the skill section, then the CLI's refusal for an alters note without
  `--ruling`, then the note. The refusal reads `decisions: --kind alters needs --ruling "<the whole
  current rule, restated>". The current ruling, verbatim:` followed by the ruling on the next line;
  the code PR must print exactly this. The writer replies with its `--ruling` text.
- `kind-prompt.txt`: the skill section, the current ruling and the note; the reply is `progress` or
  `alters`.

## Writer

- `writer.mjs` calls `claude -p --model <id> --disallowedTools * --settings
  {"disableAllHooks":true} --no-session-persistence <prompt>`. That is devkit's `JUDGE_READ_ONLY`
  then `JUDGE_ISOLATION`, imported from `gate-engine/judge/judge-isolation.mts`.
- Each call runs from a fresh `mkdtemp` directory, with stdin closed, git's per-repository variables
  removed and `DEVKIT_NO_TELEMETRY=1`. A 300 s timeout applies.
- **Confound:** user-scope CLAUDE.md and auto-memory still load, as they do for devkit's own judges.
- **Models:** `claude-haiku-5-5` and `claude-opus-5-5`.
- **Rows.** Every attempt is appended to `runs/<phase>.jsonl` with the model id, replicate, item id,
  case sha256, prompt sha256, `claude --version`, HEAD sha, Node and ICU versions, timestamp, the
  exact argv (the prompt replaced by its sha256), exit code and stdout.
- **Retries.** A failed call (non-zero exit, timeout or empty output) is retried up to twice. An item
  with no successful attempt fails (i) to (iii).
- **Output.** The `--ruling` text is stdout trimmed, minus one wrapping code fence or one wrapping
  pair of double quotes. Nothing else is stripped.
- **Preflight.** `writer.mjs` refuses to call when a frozen input is uncommitted, the second rater is
  missing, fewer than 8 W are confirmed or a control fails. It also refuses the decisive run before
  the probe.

## Procedure and call budget

0. This pre-registration commit. No calls.
1. Second rater, stage 1, committed; then stage 2.
2. `node score.mjs --controls` prints PASS on the confirmed set.
3. **Probe**, K=1: the first sample E item, the sample N item and the first confirmed W item, in
   `cases.jsonl` order, × 2 models = 6 calls. The probe may change mechanics only (timeout, output
   stripping), through a dated addendum here. It never changes gold, prompts or the pass rule.
4. **Decisive run (a):** N ≤ 29 items × 2 models × K=3 ≤ 174 calls.
5. **Kind recognition:** 60 notes × 2 models × K=1 = 120 calls.

In all, at most 300 single-turn writer calls of about 1.5k tokens in and 0.5k out, half of them
Opus, and no judge calls.

## Scoring (`score.mjs`, zero LLM)

Per row:

- **(i) clause:** every `mustContain` string occurs in the output, case-insensitive, whitespace
  collapsed.
- **(ii) retained:** every sentence not flagged altered (or contested) occurs in the
  whitespace-collapsed output verbatim, case-sensitive. The code's sentence refusal must use the
  same predicate.
- **(iii) stale-free**, W items only: no gold stale sentence occurs verbatim.
- **Length:** an output over 2000 characters fails (i) to (iii) for that item.

**Adjudication** is human and appended to `adjudication.jsonl` as
`{key: "<model>|<rep>|<id>", criterion: "clause"|"stale", verdict, by, date, reason}`. It covers:

- every (i) miss;
- every W row whose stale markers occur without a verbatim stale sentence (the verdict says whether
  the stale claim is still asserted);
- a fixed 20% of exact (i) passes: the rows whose `sha256(key)`, first 8 hex digits read as a
  number, is 0 mod 5.

An adjudicated verdict replaces the scorer's for that row and criterion. It cannot rescue a row over
2000 characters, and it never applies to (ii). Exact and adjudicated counts are both reported.
`score.mjs` prints PENDING until every queued row has a verdict.

## Pass rule

For **each** writer model and **each** of the K=3 replicates, all of:

- (i) holds in at least ceil(0.875·N) items;
- (ii) holds in at least ceil(0.875·N) items;
- (iii) holds for **every** confirmed W item (at least 8).

Kind recognition, per model: at most 5 of the 44 L notes are called alters; an unparseable answer
counts as alters on an L note and as a miss on an altering note. Recall on the 16 is reported.

Build the code only if haiku **and** opus pass every replicate and kind recognition. If only Opus
passes, or fewer than 8 W items are confirmed, do not ship the code and re-open the design.
`node score.mjs --controls --runs runs/decisive.jsonl --kind runs/kind.jsonl` prints the verdict.

## Before → after

- A reader served only the ruling holds the note's clause on 0/N items (C1, by construction).
- Ruling plus note, concatenated, exceeds 2000 characters on 7 of the 16 sample items and on 10 of
  the 29 candidates.
- The target: a restatement holds the clause on at least 87.5% of items within 2000 characters, with
  no stale W sentence.

## Commands

```
node score.mjs --controls
node score.mjs --gold-sheet
DEVKIT_NO_TELEMETRY=1 node writer.mjs --phase probe
DEVKIT_NO_TELEMETRY=1 node writer.mjs --phase decisive
DEVKIT_NO_TELEMETRY=1 node writer.mjs --phase kind
node score.mjs --controls --runs runs/decisive.jsonl --kind runs/kind.jsonl
```

`writer.mjs` takes `--model <id>` (repeatable) and `--concurrency <n>` (default 2), and resumes a
phase by skipping cells that already succeeded or used all three attempts.

## Files

| file | contents | written |
|---|---|---|
| `cases.jsonl` | 29 restatement items with the first rater's gold | this commit |
| `kind-cases.jsonl` | 60 kind-recognition notes with their sample labels | this commit |
| `rater2-candidates.md` | the 15 W candidates, blind, for the second rater | this commit |
| `skill-notes-section.md`, `writer-prompt.txt`, `kind-prompt.txt` | frozen prompt inputs | this commit |
| `score.mjs`, `writer.mjs` | scorer and writer | this commit |
| `rater2-labels.jsonl` | second-rater answers, stage 1 then stage 2 | append-only |
| `runs/*.jsonl`, `adjudication.jsonl` | writer rows and human verdicts | append-only |

Corrections go in new dated rows or files, never edits. Runner banks and transcripts are not
committed; each run row holds only the writer's reply.

## Limits

- One repository's decision log, and W items confirmed by one second rater.
- Single turn: in production the CLI's sentence refusal gives the writer a second try on (ii), so
  (ii) here is conservative. Nothing gives a second try on (iii).
- The writer sees the full current ruling, as the CLI prints it. A writer that skips that step and
  works from a cut brief is outside this test.
- The kind-recognition gold is one rater's labels.

## Addendum, 2026-10-11, before any call: the second rater

- **Who.** `rater2-labels.jsonl` holds the second rater's 15 stage-1 rows, copied unchanged from
  the answer file. The rater is `claude-opus-5-5`, run blind on `rater2-candidates.md`, not a human
  as pre-registered. It is also one of the two writer models. Read every result below with that.
- **Agreement.** The raters agree on 11 of 15 labels. Each labelled 10 candidates W; 9 are W for
  both, and every one of the 9 names the same stale sentence. `correctness-chunking-ships-dark#2`
  is W for the second rater only, and `vendored-third-party-agent-assets#2` for the first only.
- **Confirmed W: 9**, at least 8, so the run goes ahead. The run set is 23 items: the 16 sample
  items plus 7 confirmed W outside the sample. ceil(0.875 × 23) = 21.
- **Stage 2 was not run.** No second rater checked the `mustContain` strings or the keep / may
  change flags, so the first rater's gold stands unchecked. An unchecked keep flag can only cost a
  writer on (ii), and every (i) miss is adjudicated, so the gap biases the test toward failing.
- `node score.mjs --controls` on the confirmed set: gold OK, C1 clause 0/23 and stale fails 9/9,
  C2 clause 23/23, retained 23/23 and stale fails 9/9. Controls PASS.

## Results

**Verdict: FAIL.** `node score.mjs --controls --runs runs/decisive.jsonl --kind runs/kind.jsonl`
prints `VERDICT: FAIL`. Haiku fails kind recognition, and one replicate of each model fails (ii).
Per the pass rule the code is not built and the design is re-opened.

**Calls: 264**, all on 2026-10-11 between 11:55 and 12:16 UTC: probe 6, decisive 138 (23 items × 2
models × K=3), kind recognition 120. Every call succeeded on its first attempt, so no row is a
retry. All rows record HEAD `a0800613`, `claude` 2.1.296, Node v22.20.0 and ICU 77.1. The probe
needed no change to the mechanics.

### Restatement (decisive run, N = 23, need 21 on (i) and (ii), 9 of 9 on (iii))

| model | rep | (i) clause, adjudicated (exact) | (ii) retained | (iii) stale-free W | cell |
|---|---|---|---|---|---|
| claude-haiku-5-5 | 1 | 23/23 (22) | **20/23** | 9/9 | FAIL |
| claude-haiku-5-5 | 2 | 23/23 (23) | 21/23 | 9/9 | PASS |
| claude-haiku-5-5 | 3 | 23/23 (23) | 21/23 | 9/9 | PASS |
| claude-opus-5-5 | 1 | 22/23 (22) | **19/23** | 9/9 | FAIL |
| claude-opus-5-5 | 2 | 23/23 (23) | 22/23 | 9/9 | PASS |
| claude-opus-5-5 | 3 | 23/23 (23) | 22/23 | 9/9 | PASS |

- **(iii) held everywhere.** None of the 54 replies on a confirmed W item kept a stale sentence
  verbatim. Four replies hit a stale marker, and adjudication found the stale claim no longer
  asserted in each. This is the worst case the test was built to catch, and it did not occur.
- **(i) held.** 136 of 138 replies matched exactly and 137 after adjudication. The one loss is the
  only reply over 2000 characters: Opus rep 1 on `qavis-advisory-gate#10`, 2,137.
- **(ii) failed in 2 of 6 cells.** 13 of 138 replies miss a kept sentence. One is the over-length
  reply. The other 12 rewrite a sentence the gold marks unchanged in place, weaving the note's
  clause into it rather than adding a sentence; none of the 12 drops that sentence's claim.
  - 6 of the 12 are `hook-command-supersession#1`, in every cell. Its note says a registration can
    ship more than one prior spelling, which arguably makes the singular "prior spelling" in S1 and
    S4 incomplete. A stage-2 gold check might have marked them may change.
  - The verdict does not rest on that item. With S1 and S4 marked may change, Opus rep 1 still
    retains 20/23, under 21, and Haiku still fails kind recognition.
- **Format.** One reply (Haiku rep 1, `bench-gates-on-flips-not-deltas#0`) opens with
  `The --ruling text is:`, which a CLI would write into the ruling. One came in a code fence and was
  stripped as pre-registered.

### Kind recognition (60 notes: 44 L, 16 altering)

| model | false alters on L (max 5) | recall on altering | unparseable | result |
|---|---|---|---|---|
| claude-haiku-5-5 | **14/44** | 14/16 | 0 | FAIL |
| claude-opus-5-5 | 4/44 | 14/16 | 0 | PASS |

The two models give the same answer on 46 of 60 notes. Haiku would have written a restated ruling
for about a third of the progress notes, and each one would replace the rule that every reader is
served.

### What the failure says about the design

This is interpretation, not part of the verdict.

- The restatements' content held up: no stale sentence survived, and after adjudication the clause
  was missing only from the one over-length reply.
- The 12 in-place rewrites are the case the planned CLI sentence refusal exists for. A single-turn
  test cannot show whether that second step fixes them.
- The binding failure is choosing the kind. Asking the writer to classify its own note, with this
  rubric, over-calls alters on Haiku.

## Addendum, 2026-10-11, after the runs: adjudication

The 32 queued rows were adjudicated by the build agent (`claude-opus-5-5`), not by a human as
pre-registered. In `adjudication.jsonl`, `verdict: true` means the criterion holds: the clause is
present, or the reply is stale-free. That is the reading `score.mjs` applies. The FAIL does not
depend on these rows: the failing cells fail on (ii), which adjudication never touches, and on kind
recognition.

## Adjudication log

- `adjudication.jsonl`: 32 rows, all from the build agent on 2026-10-11.
  - 1 (i) miss, ruled present. Haiku rep 1 on `bench-gates-on-flips-not-deltas#0` paraphrases
    "early return": the floors run first and still fire when the comparison is skipped.
  - 27 audit-sampled exact (i) passes, all confirmed.
  - 4 stale-marker rows, all stale-free. In three, `1800` now names the reviewer caps. In one,
    "same vocabulary" now describes one of three lists.
- Stage 2 (gold check): not run, so there are no stage-2 rows (see the first addendum).
