# Decision-log benchmarks — findings, corrections and open work (sc-1236)

Working record for story sc-1236. Written because the measurements here are easy to quote wrongly:
several numbers below were overstated in earlier reporting and had to be corrected, and the
corrections are the point. Numbers without a stated *tier* and *n* are not usable — see Limitations.

## What shipped

| PR | What |
|---|---|
| #219, #223 | Bench made capable of failing (floors above the no-baseline return; `--fail` exits non-zero with no baseline); retrieval candidate set moved from `INDEX.md` rows to the decisions DIRECTORY; recall suite + scoring; frozen seed corpus |
| #231 | Checkpoint/resume for the judge bench (`progress-<sub>.jsonl`, `--fresh`), keyed on config + `gateHash` + `corpusHash` |
| #234 | RRF fusion replacing the tier ladder; dense tier extracted to `recall/embeddings.mts` |
| #235 | Correction to the fusion Target's wording (see Corrections) |

## Measured results

**Judge suite** — 103 labelled rows, haiku (escalate sonnet), K=3 detect/depth, K=1 alignment.
First baseline ever produced; `--fail` therefore gates on floors only until a second run exists.

| Sub-bench | Accuracy | Headline (floor 0.75) |
|---|---|---|
| detect | 43/49 = 87.8% | DECISION recall **0.83** `[0.61, 0.94]` |
| alignment | 18/20 = 90% | CONTRADICT precision **0.80** `[0.49, 0.94]`, macro-F1 0.63 |
| depth | 34/34 = 100% | accuracy **1.00** `[0.90, 1.00]` |

**Retrieval suite** — 29 cases, seed corpus `c51657aca687`, zero LLM calls.
CI runs the **lexical** tier (no Ollama); hybrid is local-only. Always state which.

| Metric | lexical (CI) | semantic | hybrid (local) |
|---|---|---|---|
| Containment@5 SINGLE | 7/8 | 8/8 | 8/8 |
| Containment@5 MULTI (≥1 axis) | 4/4 | 4/4 | 4/4 |
| Buried@5 by rank | 1/7 | 2/8 | 1/8 |
| CSA / SFER | 6/6 / 0/6 | 6/6 / 0/6 | 6/6 / 0/6 |
| SetRecall (ALL axes) | 2/4 | 1/4 | 3/4 |
| PartialRecall (macro) | 75% | 62.5% | 87.5% |
| FANR / FAR | 11/11 / 0/18 | 11/11 / 0/18 | 11/11 / 0/18 |

## Corrections to earlier claims

1. **"Fusion strictly dominates both tiers" — false.** It TIES semantic on Containment SINGLE (8/8)
   and wins outright only on the multi-axis family. Corrected in `decision-retrieval-tier-fusion`.
2. **The multi-axis win rests on one axis.** PartialRecall 87.5%/75%/62.5% is 7/8, 6/8, 5/8 required
   slots across 4 MULTI cases. Wilson on SetRecall 3/4 is `[30, 95]`.
3. **"frink recall@5 35.7% → 100%" is not benchmark evidence.** Both numbers come from one
   uncommitted 14-query probe, run by the same person who had already diagnosed the cause as
   candidate-set absence. Fixing reachability makes the post-fix 100% near-certain by construction.
   It shows the fix worked on the diagnosed cases; it is not evidence of generalisation.
4. **No abstention exists in shipped code.** The FANR 1/11 / FAR 0/18 figure for BM25 top-1 magnitude
   is an ORACLE bound — the threshold was fitted and scored on the same 29 cases. `abstain.mts` was
   written, never wired, and parked out of the tree rather than left as dead code.
5. **Containment@5 MULTI counts ≥1 gold axis, not all of them** (`scoring.mts:136`). "All axes" is
   SetRecall. An independent recomputation using the all-axes rule reproduced SetRecall 2/4 exactly,
   which is a genuine cross-validation of the scorer — but the label misleads and should be read with
   care.

## Record durability — what actually decays

Decision RECORDS do not rot. They are append-only, one file per axis, and content never mutates; a
ruling reads identically in a century. Retrieval returning the right FILE is sufficient even if it
points at the wrong entry within it, because the file carries its own history — which is why
Containment is scored at axis level.

What decays is **ENFORCEMENT**, and it is measurable today:

- **5 of 28 records have a `**Scope:**` glob matching no path on disk.** (An earlier draft said
  7, from a cruder shell-glob check; 5 is the authoritative count from the gate's own `matchScope`.) `check-alignment`
  free-skips a Target whose scope matches nothing and exits 0 (`check-alignment.mts:29`), so those
  rulings are intact and silently unenforced. Causes are mechanical: the `.mjs`→`.mts` migration, and
  file moves — `decision-format-parsed-not-regexed` scopes `gate-engine/decisions/markdown.mts`,
  which moved to `recall/markdown.mts` during this very story.
- **0 of 29 records carry `**Supersedes:**` or a note `**Relation:**`.** Nothing mechanically records
  that ruling B replaced ruling A, so two live contradictory axes are representable and exist:
  `dev-guardrails-distribution` vs `devkit-onboarding-cli`, both `2026-06-13`, "via npx-skills" vs
  "NOT npx-skills".

`Revisit-when` coverage (17/29) is deliberately NOT treated as a defect: a ruling stays valid until
superseded, so an expiry condition is a review prompt, not a durability requirement.

Field-coverage note: `--tradeoff` is stored as the `Negative:` bullet under `**Consequences:**`, not
as its own field. Counting `**Tradeoff:**` labels reports 0/29 and is wrong — no data is lost.

## Limitations that must travel with every number above

- n=29 retrieval cases, n=103 judge rows. These are large-effect tripwires, not 5pp detectors.
- The seed corpus is `adapted` provenance — neutralised, authored to reproduce real pathologies.
  Numbers on it are not numbers on a real corpus.
- `depth 34/34 = 100%` means the depth corpus is too easy, not that the judge is perfect. A suite
  that cannot fail cannot detect a regression. The 100-year audit over 29 REAL records was passing
  every record while a quarter of them had dead scopes, which is corroborating evidence of leniency.
- The sonnet escalation earns nothing measurable on this corpus: haiku-alone matches the full cascade
  on CONTRADICT precision (0.80) and macro-F1 (0.63) while escalating on 58.8% of rows.
- Local runs are hybrid, CI runs lexical. A number without its tier is not comparable.

## Open work, in leverage order

> **Superseded — see "Final state" at the end of this document.** Items 1-4 shipped; 5 is still
> blocked and 6-8 remain. Kept as written because the ORDER was the judgement call, and the reasoning
> for it is worth more than a tidy list.

1. **Scope-glob validity check** — deterministic, no LLM, catches the 7 known cases; a ruling whose
   gate has silently stopped firing is worse than a stale doc. (Story AC4, reduced to its mechanical
   core.)
2. **Refuse a duplicate live ruling at write time** (AC2) — enforces the "supersession writes to the
   SAME axis file" invariant that the design assumes and nothing currently checks.
3. **`**Supersedes:**` forward pointer + note `**Relation:**`** (AC1 write side). The read side
   already surfaces `⚠ qualified by <date>`.
4. **`guard-decisions categories`** (AC3).
5. **Abstention** — blocked on ~25 realistic answerable questions for split-conformal calibration.
   Corpus-derived queries measurably fail: slug queries are short, BM25 magnitude scales with query
   length, so τ lands at 7.6 against an oracle 11.55 and FANR degrades to 8/11.
6. **Orama spike** — `@orama/orama` (maintained, hybrid search) against `recall/embeddings.mts`, now
   cleanly separable. The recall bench referees it in seconds.
7. **ranx cross-check** — validate our hand-computed IR metrics against a TREC-validated implementation.
8. **Publish** — `bun gate-engine/eval/cli.mts publish --suite decisions --baseline
   gate-engine/decisions/eval/results.baseline.json --tree WORKTREE`, then `bun run benchmarks:render`.
   Requires a completely clean tree, so run it from a fresh checkout at `main`.

---

## Final state (sc-1236 closed out)

All four acceptance criteria are implemented. What a reader needs to know:

| AC | Delivered as |
|---|---|
| 1 — supersession surfaced on read | `**Supersedes:** <id>` on a Target, `**Amends:**` tag on a note. Resolved at READ time into a reverse edge; the superseded block is never rewritten, so append-only holds. Cross-axis refs use `slug#target:<date>`. |
| 2 — refuse a duplicate live ruling | **Deliberately advisory, not blocking.** `add --new` prints the three nearest live rulings. Measured over 30 real axes, all six highest-BM25 pairs are legitimately distinct (top pair: the recall *benchmark* vs the ranking *algorithm*), so any blocking threshold would reject good work. |
| 3 — category view | `guard-decisions categories`, frozen six-value vocabulary, validated at write time. Uncategorised records are listed as such, never bucketed. |
| 4 — drift check | `guard-decisions drift` (deterministic, no LLM) plus `guard-decisions rescope` to fix what it finds by appending a dated `**Scope:**` correction. |

### Commands added

```
guard-decisions drift                          # rulings whose Scope matches no code (exit 1 if any)
guard-decisions rescope <slug> --scope … --reason …   # append-only Scope correction
guard-decisions categories                     # category -> axis -> current ruling
guard-decisions query "…" --full               # whole matched records, not truncated rulings
node gate-engine/decisions/eval/bench.mts all --baseline   # resumable; re-run to continue
```

### Known gaps, stated plainly

- **Abstention is still absent.** FANR 11/11 — the retriever never says "nothing rules on this". The
  signal is identified (raw BM25 top-1; oracle FANR 1/11, FAR 0/18) but calibrating τ needs ~25
  realistic answerable questions. Two shortcuts were tried and both measurably failed: deriving them
  from the corpus (τ 7.6 vs oracle 11.55) and length-normalising the score to avoid needing them
  (oracle degrades to 7/11; slug-calibrated abstains on everything). Do not retry either.
- **`categories` is empty on the real corpus** — all 31 records predate the field, and `Category`
  lives on a Target, which cannot be edited. Backfill needs a rescope-style append for that field.
- **`check-alignment` does not yet skip superseded Targets** at commit time, and the query envelope
  has no `SUPERSEDED` state — both need `eval/recall/scoring.mts` updated in lockstep.
- **AC5 (ship the `check-alignment` hook fragment)** was flagged in the plan and remains unbuilt.
- **The judge baseline is not published to the dashboard.** `results.baseline.json` exists locally
  and is gitignored by design ("no baseline ships; each consumer generates theirs"). Publishing needs
  a completely clean tree: `bun gate-engine/eval/cli.mts publish --suite decisions --baseline
  gate-engine/decisions/eval/results.baseline.json --tree WORKTREE`, then `bun run benchmarks:render`.

### How to read any number in this document

State the **tier** and the **n**. Local runs are hybrid (needs Ollama); CI runs lexical-only. A
retrieval figure without its tier is not comparable, and at n=29 the intervals are wide enough that
point estimates mislead — `SetRecall 3/4` is `[30, 95]`.
