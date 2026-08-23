# Pre-registration — scale-track: whole-diff vs chunked correctness review on real large diffs

Written 2026-08-23 (before any expansion run; the single-diff probe `760e1080…` ran first as the
plan's explicitly-exempt informal go/no-go and is reported separately). Data handling per
[`scale-track-third-party-data`](../decisions/scale-track-third-party-data.md): committed results
carry hashes and counts only.

## Question

On real large diffs (~1k–7k LOC), does slicing the diff into ~N-LOC chunks — one sonnet judge per
chunk per local correctness lens, `writer-reader-contracts` always whole-diff — re-find more of the
KNOWN later-found defects in ONE attempt than the production whole-diff-per-lens shape, without
drowning the gain in unverifiable extra findings?

## Inputs (fixed before any run)

One diff per branch, ranked by tier-A label count from the $0 candidate scan
(`scale/scan-candidates.mts`; 273/277 archived diffs carry ≥1 label). Tier A = the issue's file has
byte-identical normalized diff identity between the diff under test and the attempt where the gate
found it; tier B = file present only.

| # | diff (sha256 prefix) | ~LOC | files | tier A | tier B |
|---|---|---|---|---|---|
| 1 | `032d886019d3` | 1,054 | 14 | 11 | 12 |
| 2 | `3f1389b9293c` | 1,073 | 17 | 8 | 0 |
| 3 | `0aa63cf864b5` | 2,119 | 25 | 4 | 28 |
| 4 | `e236ba4b4bab` | 2,865 | 35 | 6 | 6 |
| 5 | `6e42021c793d` | 1,126 | 14 | 6 | 3 |
| 6 | `fe31a21e54fc` | 1,011 | 10 | 5 | 13 |
| 7 | `2e0713a80df2` | 7,239 | 57 | 5 | 8 |
| 8 | `63a1f928f40a` | 1,406 | 11 | 4 | 18 |

Pooled tier-A n = 49. Sources: two repos (aliases only), seven branches; a diff is skipped (and
reported skipped) if its branch ref or base commit cannot be materialized.

## Arms

- `whole`: 4 lens judges over the whole diff (production shape; 60 KB evidence cap applies).
- `chunk:1000`: ~1,000-LOC next-fit whole-file chunks (`lens/chunk.mts`), 3 local lenses per
  chunk + 1 whole-diff writer-reader judge.
- `chunk:400`: diff #1 only (granularity probe).

Engine: integration branch `feat/ship-attempts-epic` (#426+#429), sonnet, lens split on,
`GUARD_REVIEW_MAX_ISSUES_PER_LENS=3`. K=1 per (diff, arm, chunk, lens) — DIRECTIONAL evidence only;
stable-flip machinery is out of scope for this round and any production decision still requires the
repo's standard pre-registered confirmation.

## Metrics

- Co-primary: pooled tier-A label recall per arm (file match ±10 lines; Wilson 95%).
- Secondary: pooled tier-B recall; distinct predicted findings per arm.
- Guardrail 1 (noise): verified-precision of EXTRA findings — every deduped extra is judged once by
  a haiku verifier shown the finding + its file's diff hunk (`REAL`/`NOT`); chunk arms must not fall
  more than 20pp below the whole arm.
- Guardrail 2: inconclusive/error task rate per arm (≤10%).
- Cost/latency per arm (judge tasks, est $, summed task secs).

## Decision rule

Open a production-chunking story (plan step 4) only if `chunk:1000` pooled tier-A recall ≥ 1.5×
`whole` AND guardrails hold. If recall gain < 1.5× or precision collapses, record no-ship for
chunking; the disclosure (#429) + telemetry (#426) levers stand alone. Either way the labelled
diffs become scale-track corpus row candidates.

## Budget

Estimated ≈ $180–250 at $0.55 + $0.03/KB per judge task; hard stop: no new diff is launched once
cumulative estimate exceeds $260. Checkpointed per task; a usage-limit kill resumes free.

## Amendment — 2026-08-23 (POST-HOC, after round-1 results were seen)

The `chunk:400` arm is extended from diff #1 to every materializable diff. This extension was
decided AFTER observing round-1 results (the owner asked why the granularity arm covered only one
diff; the original one-diff scope was a cost cap set under an earlier budget). Its results are
therefore exploratory for the granularity question — the 400-vs-1000 comparison they enable was
not part of the registered decision rule, and any production granularity choice still needs the
confirmation round's registered sweep. The registered whole-vs-chunk:1000 comparison is unaffected.

## Amendment 2 — 2026-08-23 (registered BEFORE the haiku arm ran)

Added arm `haiku × chunk:400` on all materializable diffs, queued strictly AFTER the sonnet
chunk:400 runs so the known concurrent-load checklist-compliance degradation (sc-1476) cannot bias
it. Bench-arm only: `correctness-reviewer-precision`'s sonnet pin governs production and is not
reopened. Metrics and matching identical to the other arms; report beside them with its own
inconclusive-rate guardrail (haiku's known failure mode is checklist non-compliance, not wrong
verdicts).

## Amendment 3 — 2026-08-23 (registered BEFORE the haiku chunk:200 arm ran)

Added arm `haiku × chunk:200` on all materializable diffs (owner-requested granularity probe),
queued strictly AFTER the `haiku × chunk:400` arm completes so the two haiku arms never run
concurrently (same sc-1476 load precaution as Amendment 2). Packing note recorded up front: 25 of
180 changed files exceed the 200-LOC cap alone, so this arm partially degenerates to per-file
review; 254 judge tasks estimated. Same metrics, matching, and inconclusive-rate guardrail as
Amendment 2. Bench-arm only; production stays sonnet whole-diff pending the confirmation round.

### Amendment 2/3 outcome note — 2026-08-23 (post-hoc, recorded at stop time)

`haiku × chunk:400` was stopped for futility after 6 of 8 diffs (75/161 tasks): the arm's
inconclusive-rate guardrail was already exceeded (10/75 = 13% vs the ≤10% bar) and pooled tier-A
recall on the completed diffs was 6/38 vs sonnet chunk:400's 20/38 on the same six — every hit
from the single diff all arms handle well. The owner approved the early stop. `haiku × chunk:200`
(Amendment 3) was cancelled before launch ($0 spent) on the same evidence: the failure mode is
disclosure/checklist compliance, which finer slicing does not address.

## Amendment 4 — 2026-08-23 (registered BEFORE the haiku chunk:100 arm ran)

Owner-requested after the haiku × chunk:400 futility stop: does haiku recover when chunks shrink
to ~100 LOC (mostly single-file slices)? Arm `haiku × chunk:100` on the first THREE diffs of the
driver order only (`032d8860`, `3f1389b9`, `6e42021c`; 24 chunks → 75 judge tasks est.) — an
explicitly small probe, not a full arm. Same metrics, matching, and ≤10% inconclusive guardrail.
Prior expectation recorded up front: the 400-arm failure modes (checklist non-compliance, silent
under-disclosure) are not chunk-size-dependent, so the null is "no recovery"; a surprise here
would justify a full registered arm, nothing less.

### Amendment 4 outcome note — 2026-08-23 (recorded at completion)

Null confirmed, from both directions. `haiku × chunk:100` on the three probe diffs: tier-A
0/11 · 4/8 · 1/6 = **5/25 (20%)** vs `haiku × chunk:400`'s 6/25 and `sonnet × chunk:400`'s 12/25
on the same diffs; inconclusive 16/75 = **21%** (guardrail ≤10%, exceeded; worse than the 400
arm's 13%). On the one diff haiku handled at 400 (6/8), shrinking to 100 LOC LOWERED recall to
4/8 — finer slices fragment what signal it had while multiplying protocol round-trips it fumbles.
75 tasks. Verdict: no cheap-model rescue via granularity; a future cheap-model arm must change
the judge protocol, not the chunk size. No further haiku granularity arms will be run.

### Scoring-correction note — 2026-08-23 (post-hoc, prompted by the reviewer gate)

The registration fixed the MATCH rule (file ±10 lines) but not the EXTRACTION rule (which
file[:line] mentions of a predicted issue count). The harness used first-match; devkit's reviewer
gate blocked the harness PR because first-match mis-locates predictions — a bias AGAINST the
whole arm, whose issue texts name more cross-file context. Under corrected all-locations
extraction the pooled result moves 12/20/22 → 16/22/25 (whole / chunk:1000 / chunk:400 of 44):
`chunk:1000` = 1.375× whole, UNDER the registered 1.5× bar (1.67× under the original scoring).
Ruling recorded: the registered decision is scoring-sensitive → round downgraded to directional;
no production-chunking default may cite this round as a cleared bar; the confirmation round's
registration must pin the extraction rule (and the post-merge/#429-cap scoring surface) before
any run.

Second scoring defect, same day: loose path-suffix matching cross-attributed BARE basenames
between distinct same-named files (`index.ts`). The shipped scorer now requires line agreement
for bare-basename pairs and unique-basename resolution when mining. Sensitivity across the three
variants (whole / chunk:1000 / chunk:400 of 44): v1 first-match 12/20/22 (1.67×) · v2
all-locations 16/22/25 (1.375×) · v3 basename-disciplined 8/16/17 (2.0×). Chunk ≥ whole under
every variant on every diff; the RATIO straddles the bar, so the ruling above stands — round is
directional, the confirmation registration pins one rule ex ante.

Third defect, same day (reviewer round 3): one-sided multi-segment suffixes cross-attribute
between packages sharing a trailing subpath. Final shipped rule (v4): resolve every mentioned
path against the diff's closed staged-file set (exact, else unique suffix; ambiguity = no
resolution), compare exact paths, ±10-line window. v4 pooled: 16/22/24 of 44 (1.375×). The
four-variant spread (1.375×–2.0×) stands as the reason the registered bar is not treated as
cleared in either direction.

Fourth defect, same day (adversarial sweep after reviewer round 10): LABEL CONTAMINATION — the
mining window `l.ts >= sinceTs` included the diff's OWN attempt's findings as "later-found"
labels (21 of the round's 44 tier-A labels; test-retest circularity) and filtered by branch name
with no repo pin. Decontaminated mining (own-sha rows excluded, repo pinned) yields n=23 pooled
labels: whole 5 · chunk:1000 8 · chunk:400 8 (1.6×). Across all five rulesets the ratio spans
1.375×–2.0× with chunk ≥ whole in every one. Standing ruling: this round is directional only;
the confirmation registration pins the mining rule, the scoring rule, and a frozen corpus
manifest (decontaminated corpus: 305 archived large diffs, 230 labelled, 310 tier-A labels).
