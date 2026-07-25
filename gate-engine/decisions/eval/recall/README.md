# decisions-recall

Does the decision log return the axis that actually rules on a question?

The three sub-benches next door score the decisions gate's LLM **judges**. This one scores its
**retrieval** — the half that had no measurement at all, and where a 14-query probe against a real
86-axis corpus found `recall@5 = 35.7%` with every miss caused by the axis being absent from the
candidate set rather than mis-ranked.

## Why it can run per-commit

Scoring is set arithmetic and substring matching over `guard-decisions query --json`. **Zero LLM
calls, a few seconds.** That is a deliberate design constraint, not a happy accident: the whole point
is to replace a ~560k-token exhaustive-mining workflow with something affordable enough to run every
time, so any metric requiring a judge was rejected (see `scoring.mts`).

```bash
node bench.mts                    # score the committed seed corpus
node bench.mts coverage           # composition + leakage audit, zero retrieval calls
node bench.mts --corpus <dir>     # score a local frozen snapshot (evidence-only)
node bench.mts --json             # machine-readable summary

BENCH_RETRIEVAL=lexical|semantic  # tier sweep (default lexical — what CI can run)
```

## Five failure modes, five denominators, never pooled

A single headline number is deliberately absent. These failures have **opposite fixes**, and pooling
them lets one mask another — better ranking cannot fix an absent candidate, and a retriever that
answers everything scores well on recall precisely by being wrong about abstention.

| | Failure | Metric | Denominator |
|---|---|---|---|
| (a) | right axis never returned | `Containment@5` | answerable cases, SINGLE and MULTI apart |
| (b) | returned, but buried under noise | `Buried@5` (by-rank / by-distractor) | **conditional** on containment |
| (c) | a stale ruling returned as if live | `CSA` / `SFER` | CURRENT_STATE cases |
| (d) | answers when nothing rules | `FANR` / `FAR` | a 2×2, never blended |
| (e) | needs N axes, gets some | `SetRecall` / macro `PartialRecall` | MULTI cases |

Three scoring rules that are easy to get subtly wrong, and are pinned by tests:

- **An empty row set is an abstain whatever `state` says.** Keying on the label alone would let a
  retriever dodge `FANR` by returning `RULED` with zero rows.
- **A false abstain counts twice** — once as a `FAR` event, once as a containment miss. Telling an
  agent "nothing is decided" when a ruling exists makes it mint a contradicting decision, so it must
  never look like a safe outcome in the recall table.
- **`Buried` is conditional on containment.** A case that returned nothing is a containment miss and
  is simply absent from the buried denominator, rather than counting as "not buried" and flattering
  the rank metric.

## The corpus is frozen, never the live tree

`docs/decisions/` is written by the gate under test. Scoring against it would let labels rot
silently — an ABSTAIN case is correct only until someone records a ruling on that topic. So the bench
reads a frozen snapshot, and every case carries the `storeHash` it was labelled against.

Two corpora, two evidence tiers:

- **`corpus/seed/`** — committed. Neutralised and generic, but structurally faithful: it reproduces
  the pathologies measured in a real corpus rather than being plausible filler. It contains both
  schema generations, a re-targeted axis, a Target falsified by its own later notes, two same-day
  mutually-exclusive rulings, an axis absent from `INDEX.md`, and an `INDEX.md` row whose file is
  gone. This is what CI scores.
- **A local frozen snapshot** via `--corpus <dir>` — never committed. devkit installs globally and
  its own recorded ruling is that it ships the generator, never the data, so a real product's
  decision log stays out of the package. Numbers from it are `evidence-only` / local-aggregate.

## Dataset card

- **Corpus**: `corpus/seed/`, 10 axis files + `INDEX.md`. `storeHash` printed by `coverage`.
- **Provenance**: seed corpus hand-authored for this suite. Cases LLM-proposed against that corpus,
  then filtered by an independent adversarial pass that re-derives the gold axis from the question
  alone and rejects on disagreement (the Doc2Query--/InPars-v2 filter shape), plus a mechanical
  leakage gate.
- **Anti-leakage**: `coverage` computes token-Jaccard between each question and its gold axis file
  and **fails** above `0.5`. A question that reuses a ruling's distinctive vocabulary tests string
  matching, not retrieval.
- **Holdout**: not yet split. With a corpus this small a holdout would leave both halves
  uninformative; it becomes meaningful when real gold cases are harvested.

### Known limitations — read before quoting any number

1. **These are SEED cases against a SEED corpus.** They prove the instrument works and catch
   regressions. They are **not** a measurement of real-world recall, and a number from this suite
   should never be reported as one.
2. **No generator/judge family separation.** The research is explicit that a case should not be
   generated and judged by the same model family, because judges favour in-family text. Only one
   family was available here, so the filter is adversarially framed and independently re-derives the
   label, but the bias is **not** eliminated. Real gold cases need human confirmation.
3. **ABSTAIN is the fragile stratum.** A false ABSTAIN label makes a *correct* retriever look broken,
   and at n≈4 one bad label moves the metric double digits. These are adversarial near-misses in the
   corpus's own domain, per SQuAD 2.0's construction — not random unrelated questions, which would
   pass trivially and overstate abstention quality.
4. **`tau` is null.** No relevance threshold is applied yet, so `FANR` measures only the
   zero-lexical-overlap case. Near-miss queries still answer. Calibrating a threshold needs gold
   cases to fit against, which is why it is sequenced after this suite rather than before it.
5. **No baseline, no `--fail` gate yet.** Registered as `experimental` / `evidence: none` in
   `docs/benchmarks/catalog.json` on purpose. It gates once it scores a corpus whose labels are worth
   gating on.

## Harvesting real gold cases

The protocol, in the order that costs least for what it buys:

1. **Mine questions from the question side, not the document side.** `git log` on the decisions dir
   (every axis-adding commit was preceded by a question the store could not answer), PR bodies,
   tickets, recorded `query` invocations. These carry no leakage by construction and *are* the real
   query distribution.
2. **CURRENT_STATE cases are found, not written.** Mechanically enumerable: files with more than one
   Target, and files whose newest note post-dates their Target. `query --json` makes this nearly
   free — `liveRulingId` diverging from `updated` is a deterministic staleness signal.
3. **ABSTAIN cases are 100% human**, verified by full-corpus grep plus reading the nearest axes.
4. **MULTI cases** by pooling several retrievers, then human adjudication of `goldRequired`; do 2–3
   exhaustively to *measure* the pooling bias rather than assume it.

Budget honestly: roughly 19 hours of human labelling for a full set. Only the LLM-proposed SINGLE
bucket takes a spot-check; the other strata are label-critical, where a wrong label inverts the
signal instead of adding noise.
