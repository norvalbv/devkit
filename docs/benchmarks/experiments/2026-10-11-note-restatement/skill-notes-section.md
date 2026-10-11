## Notes — progress or alters

```
guard-decisions add <slug> --note "<what changed, why>" --kind progress
guard-decisions add <slug> --note "<what changed, why>" --kind alters --ruling "<the whole current rule, restated>"
```
A note is a `- <date> — …` bullet under the current Target. Compare it with the current ruling and
pick its kind with this rubric:

- L = log: an implementation/convergence record, incident report, measurement or rationale that is consistent with the ruling. An engineer who read only the RULING would not act wrongly.
- E = extend: the note adds a binding constraint (must / never / always / only, or a named mechanism that must be used) on the ruling's subject that the RULING text does not state.
- N = narrow: the note carves out an exception, or limits where the ruling applies.
- W = walk back: the note reverses, retires or replaces a clause of the RULING.

L is `--kind progress`: one bullet, and the ruling stays as it is. E, N and W are `--kind alters`:
the CLI appends the note, then `- <date> — **Ruling:** <restated>`, and from then on that
restatement is the ruling every reader serves: the pre-edit brief, detect, the reviewers' Targets
block, the alignment check, `query` and INDEX.

Writing an alters note:
1. Run it once without `--ruling`. It exits 1 and prints the current ruling verbatim, even when the
   brief showed only part of it.
2. Restate the rule whole, as one text. Keep every sentence the note leaves unchanged word for
   word, and add the note's clause.
3. Remove or rewrite each sentence the note walks back or narrows. Never keep it next to its
   correction: a reader who meets both cannot tell which one holds.
4. The CLI lists every current sentence the restatement does not keep word for word, and refuses
   the write until `--changed-sentences <n>` equals that count. Check that each listed sentence is
   one the note changes.
5. Keep the restatement within 2000 characters; the CLI warns past that, because the brief cuts a
   longer ruling. A restatement identical to the current ruling is refused: that note is progress.

A note written without `--kind` is recorded as progress, and a warning names the fix:
`guard-decisions amend <slug> --note "<this note>" --kind alters --ruling "…"`. `amend --note`
takes the same `--kind`: alters replaces the newest draft note, or a draft note and Ruling pair, and
progress turns a draft pair back into one note.

Alters changes the rule, not the epic. A changed forcing problem, bet or direction is a new Target
(`add --target --evidence-change`). An alters note changes what reviewers and detect judge against
without a new Target, so the restatement and its changed sentences stay on the append-only record.
